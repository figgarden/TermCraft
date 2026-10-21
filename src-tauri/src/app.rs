// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! The application: window, menu, native dialogs, and every call the page makes (the same
//! channels as `window.api` in src/renderer, see js/tauri-api.js).

use crate::batch::BatchRunner;
use crate::bus::Bus;
use crate::conn_manager::Manager;
use crate::json::{arg, arg_str, arr, num_or, str_at, string, truthy};
use crate::launcher::{Approval, Launcher};
use crate::menu;
use crate::proto::ssh::{Mode, connect_client};
use crate::proto::{Ctx, local::default_shell, serial};
use crate::remote_desktop::{RdpService, VncBridge};
use crate::safe_storage::{OsKeychain, SecretBox};
use crate::scp_service::{ScpService, exec_text};
use crate::scripting::{AppHost, ScriptEngine};
use crate::security::{ApprovedPaths, is_safe_external_url, safe_json_parse};
use crate::sftp_service::SftpService;
use crate::store::{Store, mkdir_private, write_mode};
use crate::tftp::{Options as TftpOptions, TftpServer};
use crate::util::{expand_tilde, home, platform, resolve, timestamp};
use crate::xmodem::{Io, Signal};
use crate::{ssh_keys, xmodem, zmodem};
use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager as _, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

pub const COPYRIGHT: &str = "Copyright © 2026 Gabriel Moreno and contributors";
pub const LICENSE_NOTICE: &str = "TermCraft is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 2 of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.";
const INDEX: &str = "src/renderer/index.html";

pub enum Kind {
    File,
    Files,
    Folder,
    Folders,
    Save,
}

/// A path the user picked in a dialog.
pub struct Picked(pub PathBuf);

impl Picked {
    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// Stand-ins for native dialogs and the OS shell, used only by the end-to-end tests (set through
/// the debug-build test control; always empty otherwise).
#[derive(Default)]
pub struct TestHooks {
    pub dialogs: Mutex<std::collections::VecDeque<Value>>,
    pub boxes: Mutex<std::collections::VecDeque<String>>,
    pub box_calls: Mutex<Vec<String>>,
    pub shell: AtomicBool,
    pub external: Mutex<Vec<String>>,
}

/// Keystrokes for one tab, numbered by the page, written strictly in that order.
#[derive(Default)]
struct WriteQueue {
    next: u64,
    held: std::collections::BTreeMap<u64, String>,
}

impl WriteQueue {
    /// Add keystroke number `n`; returns the keystrokes that can now be written, in order.
    fn push(&mut self, n: u64, data: String) -> Vec<String> {
        if n == 1 || n < self.next {
            // The tab's first keystroke, or the page started counting again (reload). Keystrokes
            // already held (later ones that arrived first) are kept.
            self.next = n;
            self.held.retain(|k, _| *k > n);
        }
        self.held.insert(n, data);
        let mut out = Vec::new();
        while let Some(d) = self.held.remove(&self.next) {
            out.push(d);
            self.next += 1;
        }
        out
    }
}

pub struct App {
    pub test: TestHooks,
    writes: Mutex<HashMap<String, WriteQueue>>,
    pub handle: AppHandle,
    pub store: Arc<Mutex<Store>>,
    secrets: Arc<dyn SecretBox>,
    pub bus: Bus,
    pub manager: Arc<Manager>,
    scripts: Arc<ScriptEngine>,
    sftp: Arc<SftpService>,
    scp: Arc<ScpService>,
    vnc: Arc<VncBridge>,
    rdp: Arc<RdpService>,
    batch: Arc<BatchRunner>,
    launcher: tokio::sync::Mutex<Launcher>,
    tftp: tokio::sync::Mutex<Option<TftpServer>>,
    xfers: Mutex<HashMap<String, Arc<Signal>>>,
    approved: Mutex<ApprovedPaths>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    menu_state: Mutex<Value>,
    pub allow_close: AtomicBool,
    pub quitting: AtomicBool,
    clipboard: Mutex<Option<arboard::Clipboard>>,
    resources: PathBuf,
    pub data_dir: PathBuf,
    /// Debug builds only: results of end-to-end test evaluations (see control.rs).
    pub smoke: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

/// The data folder: <config dir>/TermCraft/data, or <dir>/data with --user-data-dir=<dir>.
pub fn user_data_dir() -> (PathBuf, bool) {
    for a in std::env::args() {
        if let Some(d) = a.strip_prefix("--user-data-dir=") {
            return (PathBuf::from(d), false);
        }
    }
    (dirs::config_dir().unwrap_or_else(home).join("TermCraft"), true)
}

/// One-time migration from the app's former name (OpenCRT): copy sessions, settings and known
/// hosts, and update references to the old default log folder and color scheme.
fn migrate_from_opencrt(new_dir: &Path) {
    let Some(old) = dirs::config_dir().map(|d| d.join("OpenCRT").join("data")) else { return };
    if new_dir.exists() || !old.exists() {
        return;
    }
    if mkdir_private(new_dir).is_err() {
        return;
    }
    for e in std::fs::read_dir(&old).into_iter().flatten().flatten() {
        let name = e.file_name();
        let mut text = match std::fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if name == "settings.json" || name == "sessions.json" {
            text = text.replace("~/OpenCRT Logs/", "~/TermCraft Logs/").replace("\"OpenCRT Dark\"", "\"TermCraft Dark\"");
        }
        let _ = write_mode(&new_dir.join(&name), text.as_bytes(), 0o600);
    }
    eprintln!("[main] migrated data from {}", old.display());
}

fn resources_dir(handle: &AppHandle) -> PathBuf {
    if let Ok(r) = handle.path().resource_dir() {
        if r.join("LICENSE").exists() {
            return r;
        }
    }
    // Development: the repository.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// This computer's IPv4 addresses (what a device needs for copy tftp://...).
fn local_addresses() -> Vec<Value> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && i.ip().is_ipv4())
        .map(|i| json!({ "name": i.name, "address": i.ip().to_string() }))
        .collect()
}

impl App {
    pub fn new(handle: AppHandle) -> Result<Arc<App>> {
        let (user_dir, default_profile) = user_data_dir();
        let data_dir = user_dir.join("data");
        if default_profile {
            migrate_from_opencrt(&data_dir);
        }
        // End-to-end tests (debug builds with the test channel on) keep their key in the throwaway
        // profile, so they never touch — or wait on a prompt from — the user's keychain.
        let secrets: Arc<dyn SecretBox> = if cfg!(debug_assertions) && std::env::var("TERMCRAFT_CONTROL").ok().as_deref() == Some("1") {
            Arc::new(crate::safe_storage::FileKey::new(data_dir.join("test-keychain.key")))
        } else {
            Arc::new(OsKeychain::default())
        };
        let store = Arc::new(Mutex::new(Store::new(&data_dir, Some(secrets.clone()))?));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Default::default();
        let seq = Arc::new(AtomicU64::new(0));
        let h1 = handle.clone();
        let send = Arc::new(move |channel: &str, args: Vec<Value>| {
            let _ = h1.emit_to("main", "termcraft", json!({ "channel": channel, "args": args }));
        });
        let h2 = handle.clone();
        let p2 = pending.clone();
        let request = Arc::new(move |kind: &str, payload: Value| -> futures::future::BoxFuture<'static, Value> {
            if h2.get_webview_window("main").is_none() {
                return Box::pin(async { Value::Null });
            }
            let id = seq.fetch_add(1, Ordering::SeqCst) + 1;
            let (tx, rx) = oneshot::channel();
            p2.lock().insert(id, tx);
            let _ = h2.emit_to("main", "termcraft", json!({ "channel": "main:request", "args": [{ "id": id, "type": kind, "payload": payload }] }));
            Box::pin(async move { rx.await.unwrap_or(Value::Null) })
        });
        let bus = Bus::new(send, request);
        let manager = Manager::new(bus.clone(), store.clone());
        let scripts =
            ScriptEngine::new(Arc::new(AppHost { manager: manager.clone(), bus: bus.clone(), store: store.clone(), rt: tokio::runtime::Handle::current() }));
        let h3 = handle.clone();
        let launcher = Launcher::new(
            data_dir.join("approved_commands.json"),
            Box::new(move |argv, command| {
                let h = h3.clone();
                Box::pin(async move { confirm_launch(&h, &argv, &command).await })
            }),
            None,
            None,
        );
        let app = Arc::new(App {
            resources: resources_dir(&handle),
            sftp: SftpService::new(bus.clone(), store.clone()),
            scp: ScpService::new(bus.clone(), store.clone()),
            vnc: VncBridge::new(bus.clone(), store.clone()),
            rdp: RdpService::new(bus.clone(), store.clone()),
            batch: BatchRunner::new(bus.clone(), store.clone(), None),
            handle,
            store,
            secrets,
            bus,
            manager,
            scripts,
            launcher: tokio::sync::Mutex::new(launcher),
            tftp: Default::default(),
            xfers: Default::default(),
            approved: Default::default(),
            pending,
            menu_state: Mutex::new(json!({})),
            allow_close: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            clipboard: Mutex::new(None),
            data_dir,
            smoke: Default::default(),
            test: Default::default(),
            writes: Default::default(),
        });
        let a1 = Arc::downgrade(&app);
        let a2 = Arc::downgrade(&app);
        app.manager.set_hooks(
            Arc::new(move |tab, direction, io| {
                if let Some(app) = a1.upgrade() {
                    tauri::async_runtime::spawn(async move { app.start_zmodem(tab, direction, io).await });
                }
            }),
            Arc::new(move |file, tab| {
                let a = a2.clone();
                Box::pin(async move {
                    let app = a.upgrade().ok_or_else(|| anyhow!("closing"))?;
                    app.scripts.run(&expand_tilde(&file), Some(tab), vec![]).await
                })
            }),
        );
        Ok(app)
    }

    pub fn send(&self, channel: &str, args: Vec<Value>) {
        self.bus.send(channel, args)
    }

    pub fn window(&self) -> Option<WebviewWindow> {
        self.handle.get_webview_window("main")
    }

    /// Read the keychain key outside the store lock (on macOS this can wait for the user to
    /// answer the access prompt).
    async fn warm_keychain(&self) {
        let s = self.secrets.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = s.encrypt("termcraft-keychain-check");
        })
        .await;
    }

    pub fn refresh_menu(&self) {
        let s = self.store.lock().settings().clone();
        let mut state = self.menu_state.lock().clone();
        for k in ["showSessionManager", "showButtonBar", "showCommandWindow", "showStatusBar", "recentScripts"] {
            state[k] = s[k].clone();
        }
        state["reticulum"] = s["reticulum"]["enabled"].clone();
        let h = self.handle.clone();
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || {
            if let Ok(m) = menu::build(&h2, &state, COPYRIGHT) {
                let _ = h2.set_menu(m);
            }
        });
    }

    pub fn menu_state(&self) -> Value {
        let s = self.store.lock().settings().clone();
        let mut state = self.menu_state.lock().clone();
        state["recentScripts"] = s["recentScripts"].clone();
        state
    }

    pub fn on_menu(&self, id: &str) {
        match menu::action_for(id, &self.menu_state()) {
            Some(menu::Action::Page(action, a)) => self.send("menu:action", vec![json!(action), a]),
            Some(menu::Action::Backend(x)) => match x.as_str() {
                "quit" => {
                    #[cfg(debug_assertions)]
                    eprintln!("[main] quit from the menu");
                    self.quitting.store(true, Ordering::SeqCst);
                    match self.window() {
                        Some(w) => {
                            let _ = w.close();
                        }
                        None => self.handle.exit(0),
                    }
                }
                "fullscreen" => {
                    if let Some(w) = self.window() {
                        let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
                    }
                }
                "devtools" =>
                {
                    #[cfg(debug_assertions)]
                    if let Some(w) = self.window() {
                        if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
                    }
                }
                "readme" => {
                    self.open_path(&self.resources.join("README.md"));
                }
                _ => {}
            },
            None => {}
        }
    }

    pub fn on_response(&self, id: u64, result: Value) {
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(result);
        }
    }

    /// The window closed: end everything that belongs to it.
    pub fn on_window_closed(&self) {
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Value::Null);
        }
        self.manager.close_all();
        self.sftp.close_all();
        self.scp.close_all();
        self.vnc.close_all();
        self.rdp.close_all();
        self.batch.cancel_all();
        self.scripts.cancel_all();
        if let Ok(mut t) = self.tftp.try_lock() {
            if let Some(s) = t.take() {
                s.stop();
            }
        }
    }

    // ---- file transfers in a terminal tab ---------------------------------

    /// Files to send, in order. Several files ("a series") are shown to the user to put in the
    /// order the device expects; only files picked in this dialog can be sent.
    async fn choose_files_to_send(&self, tab: &str, protocol: &str, multiple: bool) -> Option<Vec<PathBuf>> {
        let d = self.open_dialog(Some(format!("Send {}", protocol.to_uppercase())), &Value::Null);
        let picked: Vec<PathBuf> = self.dialog(d, if multiple { Kind::Files } else { Kind::File }).await?.into_iter().map(|f| f.0).collect();
        if picked.len() <= 1 {
            return (!picked.is_empty()).then_some(picked);
        }
        let ordered = self.bus.request("orderFiles", json!({ "tabId": tab, "protocol": protocol, "files": picked })).await;
        let mut out: Vec<PathBuf> = Vec::new();
        for f in arr(&ordered).iter().map(string).map(PathBuf::from) {
            if picked.contains(&f) && !out.contains(&f) {
                out.push(f);
            }
        }
        (!out.is_empty()).then_some(out)
    }

    /// The device ran rz (wants files) or sz (is sending): run ZMODEM in that tab.
    async fn start_zmodem(self: Arc<Self>, tab: String, direction: &'static str, io: Io) {
        let me = self.clone();
        let t2 = tab.clone();
        let r = if direction == "send" {
            self.run_xfer(&tab, "zmodem", "send", Some(io), move |io, signal, progress| async move {
                let Some(files) = me.choose_files_to_send(&t2, "zmodem", true).await else {
                    io.write(&zmodem::ABORT); // tell rz we're not sending anything
                    return Ok(None);
                };
                zmodem::send(io, &files, signal, Some(&progress)).await?;
                Ok(Some(files))
            })
            .await
        } else {
            self.run_xfer(&tab, "zmodem", "receive", Some(io), move |io, signal, progress| async move {
                // Device-started downloads always go to ~/Downloads (a fixed place the page can't
                // redirect).
                let dir = home().join("Downloads");
                std::fs::create_dir_all(&dir)?;
                Ok(Some(zmodem::receive(io, &dir, signal, Some(&progress)).await?))
            })
            .await
        };
        let _ = r; // reported to the tab by run_xfer
    }

    /// Run an XMODEM/YMODEM/ZMODEM transfer on a tab, reporting progress to it.
    async fn run_xfer<F, Fut>(&self, tab: &str, protocol: &str, direction: &str, io: Option<Io>, job: F) -> Result<Value>
    where
        F: FnOnce(Io, Arc<Signal>, Box<dyn Fn(Value) + Send + Sync>) -> Fut,
        Fut: std::future::Future<Output = Result<Option<Vec<PathBuf>>>>,
    {
        let signal = Arc::new(Signal::default());
        {
            let mut x = self.xfers.lock();
            if x.contains_key(tab) {
                bail!("A file transfer is already running in this tab");
            }
            x.insert(tab.to_string(), signal.clone());
        }
        let base = json!({ "protocol": protocol, "direction": direction });
        let with = |extra: Value| {
            let mut v = base.clone();
            for (k, x) in extra.as_object().into_iter().flatten() {
                v[k] = x.clone();
            }
            v
        };
        self.send("xfer:progress", vec![json!(tab), with(json!({ "state": "waiting" }))]);
        let io = match io {
            Some(io) => Ok(io),
            None => self.manager.begin_raw(tab, vec![]),
        };
        let result = match io {
            Err(e) => Err(e),
            Ok(io) => {
                let bus = self.bus.clone();
                let tid = tab.to_string();
                let b2 = base.clone();
                let last = Mutex::new(Instant::now() - Duration::from_secs(1));
                let progress: Box<dyn Fn(Value) + Send + Sync> = Box::new(move |p: Value| {
                    let mut l = last.lock();
                    if l.elapsed() > Duration::from_millis(200) || p["bytes"] == p["size"] {
                        *l = Instant::now();
                        let mut v = b2.clone();
                        for (k, x) in p.as_object().into_iter().flatten() {
                            v[k] = x.clone();
                        }
                        bus.send("xfer:progress", vec![json!(tid), v]);
                    }
                });
                let r = job(io, signal, progress).await;
                self.manager.end_raw(tab);
                r
            }
        };
        self.xfers.lock().remove(tab);
        match result {
            Ok(None) => {
                self.send("xfer:progress", vec![json!(tab), with(json!({ "state": "cancelled" }))]);
                Ok(Value::Null)
            }
            Ok(Some(files)) => {
                self.send("xfer:progress", vec![json!(tab), with(json!({ "state": "done", "files": files }))]);
                Ok(json!(files))
            }
            Err(e) => {
                self.send("xfer:progress", vec![json!(tab), with(json!({ "state": "failed", "error": e.to_string() }))]);
                Err(e)
            }
        }
    }

    /// Scripts the user configured or picked: recent scripts, button bars, key map, dialog choices.
    fn is_approved_script(&self, file: &str) -> bool {
        let s = self.store.lock().settings().clone();
        let norm = |f: &str| resolve(expand_tilde(f));
        let target = norm(file);
        let mut configured: Vec<String> = arr(&s["recentScripts"]).iter().map(string).collect();
        for b in arr(&s["buttonBars"]) {
            for x in arr(&b["buttons"]) {
                if x["action"] == "script" {
                    configured.push(string(&x["value"]));
                }
            }
        }
        for k in arr(&s["keymap"]) {
            if k["action"] == "script" {
                configured.push(string(&k["value"]));
            }
        }
        configured.iter().filter(|f| !f.is_empty()).any(|f| norm(f) == target) || self.approved.lock().is_approved_file(&target.to_string_lossy())
    }

    /// Files sent to a server must be ones the user picked, dropped, or is browsing in the SFTP
    /// local pane, so a compromised page cannot upload arbitrary local files (keys, documents).
    fn check_upload_source(&self, p: &str) -> Result<()> {
        let ap = self.approved.lock();
        if ap.is_approved_file(p) || ap.is_in_approved_dir(p) { Ok(()) } else { bail!("That file was not chosen, dropped or browsed in TermCraft") }
    }

    /// A Reticulum tool tab from the page: files sent with rncp must be ones the user chose, and
    /// fetched files go to a folder picked in a dialog (or Downloads).
    fn check_rns_tool(&self, mut session: Value) -> Result<Value> {
        let spec = &mut session["rntool"];
        match str_at(spec, &["tool"]).as_str() {
            "send" => self.check_upload_source(&str_at(spec, &["file"]))?,
            "fetch" => {
                let dir = str_at(spec, &["saveDir"]);
                let dir = if dir.is_empty() {
                    let d = home().join("Downloads");
                    std::fs::create_dir_all(&d)?;
                    d.to_string_lossy().into_owned()
                } else if self.approved.lock().is_chosen_dir(&dir) {
                    resolve(&dir).to_string_lossy().into_owned()
                } else {
                    bail!("Choose the folder to save into with Browse…");
                };
                spec["saveDir"] = json!(dir);
            }
            _ => {}
        }
        Ok(session)
    }

    /// Files dropped on the window from the system count as chosen by the user.
    pub fn approve_dropped(&self, paths: &[PathBuf]) {
        let mut ap = self.approved.lock();
        for p in paths {
            ap.approve_file(&p.to_string_lossy());
        }
    }

    fn clipboard<T>(&self, f: impl FnOnce(&mut arboard::Clipboard) -> T) -> Option<T> {
        let mut c = self.clipboard.lock();
        if c.is_none() {
            *c = arboard::Clipboard::new().ok();
        }
        c.as_mut().map(f)
    }

    /// Show a native file dialog (or, in end-to-end tests, take the next queued answer).
    async fn dialog(&self, d: rfd::AsyncFileDialog, kind: Kind) -> Option<Vec<Picked>> {
        if let Some(answer) = self.test.dialogs.lock().pop_front() {
            let paths: Vec<Picked> = match answer {
                Value::Null => return None,
                Value::Array(a) => a.iter().map(|p| Picked(PathBuf::from(string(p)))).collect(),
                v => vec![Picked(PathBuf::from(string(&v)))],
            };
            return (!paths.is_empty()).then_some(paths);
        }
        let one = |f: Option<rfd::FileHandle>| f.map(|f| vec![Picked(f.path().to_path_buf())]);
        let many =
            |f: Option<Vec<rfd::FileHandle>>| f.map(|v| v.into_iter().map(|f| Picked(f.path().to_path_buf())).collect::<Vec<_>>()).filter(|v| !v.is_empty());
        match kind {
            Kind::File => one(d.pick_file().await),
            Kind::Files => many(d.pick_files().await),
            Kind::Folder => one(d.pick_folder().await),
            Kind::Folders => many(d.pick_folders().await),
            Kind::Save => one(d.save_file().await),
        }
    }

    async fn one(&self, d: rfd::AsyncFileDialog, kind: Kind) -> Option<Picked> {
        self.dialog(d, kind).await?.into_iter().next()
    }

    pub fn open_external(&self, url: &str) -> bool {
        if self.test.shell.load(Ordering::SeqCst) {
            self.test.external.lock().push(url.to_string());
            return true;
        }
        opener::open_browser(url).is_ok()
    }

    /// Open a folder in the file manager; '' or an error message.
    fn open_path(&self, p: &Path) -> String {
        if self.test.shell.load(Ordering::SeqCst) {
            return String::new();
        }
        opener::open(p).err().map(|e| e.to_string()).unwrap_or_default()
    }

    fn reveal(&self, p: &Path) {
        if !self.test.shell.load(Ordering::SeqCst) {
            let _ = opener::reveal(p);
        }
    }

    fn prompt_ctx(&self, tab: Option<&str>) -> Ctx {
        let bus = self.bus.clone();
        let tab = tab.map(String::from);
        Ctx {
            store: self.store.clone(),
            prompt: Arc::new(move |mut req: Value| {
                if let Some(t) = &tab {
                    req["tabId"] = json!(t);
                }
                bus.request("prompt", req)
            }),
        }
    }

    fn save_dialog(&self, title: Option<&str>, default: &Path, filters: &[(&str, &[&str])]) -> rfd::AsyncFileDialog {
        let mut d = rfd::AsyncFileDialog::new();
        if let Some(t) = title {
            d = d.set_title(t);
        }
        if let Some(dir) = default.parent() {
            d = d.set_directory(dir);
        }
        if let Some(n) = default.file_name() {
            d = d.set_file_name(n.to_string_lossy());
        }
        for (name, exts) in filters {
            d = d.add_filter(*name, exts);
        }
        if let Some(w) = self.window() {
            d = d.set_parent(&w);
        }
        d
    }

    fn open_dialog(&self, title: Option<String>, filters: &Value) -> rfd::AsyncFileDialog {
        let mut d = rfd::AsyncFileDialog::new();
        if let Some(t) = title {
            d = d.set_title(t);
        }
        for f in arr(filters) {
            let exts: Vec<String> = arr(&f["extensions"]).iter().map(string).collect();
            if !exts.is_empty() && !exts.iter().any(|e| e == "*") {
                d = d.add_filter(string(&f["name"]), &exts);
            }
        }
        if let Some(w) = self.window() {
            d = d.set_parent(&w);
        }
        d
    }

    /// Handle one call from the page.
    pub async fn dispatch(self: &Arc<Self>, ch: &str, a: &[Value]) -> Result<Value> {
        let s = |i: usize| arg_str(a, i);
        let v = |i: usize| arg(a, i);
        Ok(match ch {
            // ---- store ----
            "store:tree" => self.store.lock().tree(),
            "store:saveSession" => {
                self.warm_keychain().await;
                self.store.lock().save_session(&v(0))?
            }
            "store:deleteSession" => {
                self.store.lock().delete_session(&s(0))?;
                Value::Null
            }
            "store:saveFolder" => self.store.lock().save_folder(&v(0))?,
            "store:deleteFolder" => {
                self.store.lock().delete_folder(&s(0))?;
                Value::Null
            }
            "store:move" => {
                self.store.lock().move_item(&s(0), &s(1), &s(2))?;
                Value::Null
            }
            "store:settings" => self.store.lock().settings().clone(),
            "store:saveSettings" => {
                let r = self.store.lock().save_settings(&v(0))?;
                self.refresh_menu();
                r
            }
            "store:knownHosts" => self.store.lock().known_hosts().clone(),
            "store:deleteKnownHost" => {
                self.store.lock().delete_known_host(&s(0))?;
                Value::Null
            }
            "store:importSshConfig" => json!(self.store.lock().import_ssh_config(None)?),
            "store:export" => {
                let Some(f) =
                    self.one(self.save_dialog(Some("Export Sessions"), &home().join("TermCraft-sessions.json"), &[("JSON", &["json"])]), Kind::Save).await
                else {
                    return Ok(Value::Null);
                };
                if truthy(&v(0)) {
                    self.warm_keychain().await;
                }
                let data = self.store.lock().export_sessions(truthy(&v(0)));
                write_mode(f.path(), serde_json::to_string_pretty(&data)?.as_bytes(), 0o600)?;
                json!(f.path().to_string_lossy())
            }
            "store:import" => {
                let Some(f) =
                    self.one(self.open_dialog(Some("Import Sessions".into()), &json!([{ "name": "JSON", "extensions": ["json"] }])), Kind::File).await
                else {
                    return Ok(Value::Null);
                };
                let data = safe_json_parse(&std::fs::read_to_string(f.path())?)?;
                self.warm_keychain().await;
                self.store.lock().import_sessions(&data, "Imported")?
            }

            // ---- connections ----
            "conn:open" => {
                self.warm_keychain().await;
                let cols = num_or(&v(2), 80.0) as u16;
                let rows = num_or(&v(3), 24.0) as u16;
                let session = if v(1)["protocol"] == "rntool" { self.check_rns_tool(v(1))? } else { v(1) };
                self.manager.open(&s(0), &session, cols, rows).await?;
                Value::Null
            }
            // Where each Reticulum program is (Settings shows it).
            "rns:tools" => {
                let bin = if v(0).is_string() { s(0) } else { str_at(self.store.lock().settings(), &["reticulum", "binDir"]) };
                tokio::task::spawn_blocking(move || crate::proto::reticulum::tool_paths(&bin)).await?
            }
            "conn:write" => {
                // Calls run concurrently, so keystrokes carry a per-tab sequence number and are
                // written strictly in that order.
                let tab = s(0);
                let ready = {
                    let mut w = self.writes.lock();
                    let q = w.entry(tab.clone()).or_default();
                    match v(2).as_u64() {
                        None => vec![s(1)],
                        Some(n) => q.push(n, s(1)),
                    }
                };
                for d in ready {
                    self.manager.write(&tab, &d, false);
                }
                Value::Null
            }
            "conn:resize" => {
                self.manager.resize(&s(0), num_or(&v(1), 80.0) as u16, num_or(&v(2), 24.0) as u16);
                Value::Null
            }
            "conn:close" => {
                self.manager.close(&s(0), false);
                Value::Null
            }
            "conn:break" => {
                self.manager.send_break(&s(0));
                Value::Null
            }
            "conn:log" => {
                if !truthy(&v(1)) {
                    self.manager.stop_log(&s(0));
                    return Ok(Value::Null);
                }
                let mut file = None;
                if truthy(&v(2)) {
                    let Some(f) = self.one(self.save_dialog(Some("Log Session As"), &home().join("session.log"), &[]), Kind::Save).await else {
                        return Ok(Value::Null);
                    };
                    file = Some(f.path().to_string_lossy().into_owned());
                }
                json!(self.manager.start_log(&s(0), file))
            }
            "serial:list" => json!(tokio::task::spawn_blocking(serial::list).await?),

            // ---- sftp ----
            "sftp:open" => {
                self.warm_keychain().await;
                self.sftp.open(&s(0), &v(1)).await?
            }
            "sftp:close" => {
                self.sftp.close(&s(0));
                Value::Null
            }
            "sftp:listRemote" => self.sftp.list_remote(&s(0), &s(1)).await?,
            "sftp:listLocal" => {
                let r = SftpService::list_local(&s(0)).await?;
                // The user is browsing here; allow file operations in it.
                self.approved.lock().approve_dir(&str_at(&r, &["path"]));
                r
            }
            "sftp:remoteOp" => {
                self.sftp.remote_op(&s(0), &s(1), &s(2), &s(3)).await?;
                Value::Null
            }
            "sftp:localOp" => {
                // Only inside folders the user has browsed in the SFTP local pane.
                let ok = {
                    let ap = self.approved.lock();
                    ap.is_in_approved_dir(&s(1)) && (v(2).is_null() || ap.is_in_approved_dir(&s(2)))
                };
                if !ok {
                    bail!("Path is outside the browsed folders");
                }
                SftpService::local_op(&s(0), &s(1), &s(2)).await?;
                Value::Null
            }
            "sftp:download" => json!(self.sftp.download(&s(0), &v(1), &s(2), Path::new(&s(3))).await?),
            "sftp:upload" => {
                self.check_upload_source(&s(2))?;
                json!(self.sftp.upload(&s(0), &v(1), Path::new(&s(2)), &s(3)).await?)
            }

            // ---- remote desktops ----
            "remote:vncOpen" => {
                self.warm_keychain().await;
                self.vnc.open(&s(0), &v(1)).await?
            }
            "remote:vncClose" => {
                self.vnc.close(&s(0));
                Value::Null
            }
            "remote:rdpLaunch" => {
                self.warm_keychain().await;
                self.rdp.launch(&s(0), &v(1)).await?
            }
            "remote:rdpClose" => {
                self.rdp.close(&s(0));
                Value::Null
            }
            // Save a login entered in the page (VNC authenticates there), after it succeeded.
            "store:saveCredentials" => {
                self.warm_keychain().await;
                self.store.lock().save_credentials(&v(0), &v(1))?
            }

            // ---- scp ----
            "scp:open" => {
                self.warm_keychain().await;
                let jump = if v(2).is_object() { v(2) } else { json!({ "mode": "default" }) };
                self.scp.open(&s(0), &v(1), &jump).await?
            }
            "scp:close" => {
                self.scp.close(&s(0));
                Value::Null
            }
            "scp:upload" => {
                for p in arr(&v(2)) {
                    self.check_upload_source(&string(p))?;
                }
                let paths: Vec<PathBuf> = arr(&v(2)).iter().map(string).map(PathBuf::from).collect();
                self.scp.upload(&s(0), &s(1), paths, &s(3), &v(4)).await?
            }
            "scp:download" => self.scp.download(&s(0), &s(1), &s(2), PathBuf::from(s(3)), &v(4)).await?,
            "scp:cancel" => {
                self.scp.cancel(&s(0));
                Value::Null
            }
            "dialog:openPaths" => {
                let opts = v(0);
                let props: Vec<String> = arr(&opts["properties"]).iter().map(string).collect();
                let props = if opts["properties"].is_array() { props } else { vec!["openFile".into(), "multiSelections".into()] };
                let title = Some(str_at(&opts, &["title"])).filter(|t| !t.is_empty());
                let d = self.open_dialog(title, &Value::Null);
                let multi = props.iter().any(|p| p == "multiSelections");
                let dirs = props.iter().any(|p| p == "openDirectory");
                let kind = match (dirs, multi) {
                    (true, true) => Kind::Folders,
                    (true, false) => Kind::Folder,
                    (false, true) => Kind::Files,
                    (false, false) => Kind::File,
                };
                let picked: Vec<PathBuf> = self.dialog(d, kind).await.unwrap_or_default().into_iter().map(|f| f.0).collect();
                let mut ap = self.approved.lock();
                for f in &picked {
                    ap.approve_file(&f.to_string_lossy());
                }
                json!(picked)
            }

            // ---- shared credentials and bulk host import ----
            "cred:save" => {
                self.warm_keychain().await;
                self.store.lock().save_credential(&v(0))?
            }
            "cred:delete" => {
                self.store.lock().delete_credential(&s(0))?;
                Value::Null
            }
            "hosts:parse" => {
                let text: String = s(0).chars().take(5_000_000).collect();
                crate::host_import::parse_hosts(&text, &if v(1).is_object() { v(1) } else { json!({}) })
            }
            "hosts:import" => self.store.lock().import_hosts(&v(0), &if v(1).is_object() { v(1) } else { json!({}) })?,

            // ---- run commands on many sessions ----
            // Output goes to ~/TermCraft Output/<date time> or to a folder the user picked.
            "batch:start" => {
                self.warm_keychain().await;
                let opts = v(1);
                let chosen = str_at(&opts, &["outputDir"]);
                let base = if chosen.is_empty() {
                    home().join("TermCraft Output")
                } else if self.approved.lock().is_chosen_dir(&chosen) {
                    resolve(&chosen)
                } else {
                    bail!("Choose the output folder with Browse…");
                };
                let stamp: String = timestamp().split('.').next().unwrap_or("").replace(':', "").replace(' ', "-");
                // Progress arrives as batch:update events; the summary is returned and sent as batch:done.
                self.batch.start(&s(0), &opts, base.join(stamp)).await?
            }
            "batch:cancel" => {
                self.batch.cancel(&s(0));
                Value::Null
            }

            // ---- TFTP server ----
            "tftp:status" => {
                let mut st = self.tftp_status().await;
                st["defaultRoot"] = json!(home().join("TermCraft TFTP").to_string_lossy());
                st["addresses"] = json!(local_addresses());
                st
            }
            "tftp:start" => {
                let opts = v(0);
                if let Some(old) = self.tftp.lock().await.take() {
                    old.stop();
                }
                let default_root = home().join("TermCraft TFTP");
                let root = if truthy(&opts["root"]) { resolve(expand_tilde(&str_at(&opts, &["root"]))) } else { default_root.clone() };
                // The TFTP folder is shared on the network: only the default or a folder picked
                // in a dialog.
                if root != default_root && !self.approved.lock().is_chosen_dir(&root.to_string_lossy()) {
                    bail!("Choose the TFTP folder with Browse…");
                }
                std::fs::create_dir_all(&root)?;
                let port = num_or(&opts["port"], 69.0);
                if !(port > 0.0 && port < 65536.0) {
                    bail!("Invalid port");
                }
                let req_host = str_at(&opts, &["host"]);
                let host = if req_host == "127.0.0.1" || (!req_host.is_empty() && local_addresses().iter().any(|a| a["address"] == req_host.as_str())) {
                    req_host
                } else {
                    "0.0.0.0".into()
                };
                let bus = self.bus.clone();
                let emit: crate::tftp::Emit = Arc::new(move |kind, v| bus.send(if kind == "log" { "tftp:log" } else { "tftp:transfer" }, vec![v]));
                let srv = TftpServer::start(
                    TftpOptions { root, port: port as u16, host, allow_write: truthy(&opts["allowWrite"]), allow_overwrite: truthy(&opts["allowOverwrite"]) },
                    emit,
                )
                .await?;
                *self.tftp.lock().await = Some(srv);
                self.tftp_status().await
            }
            "tftp:stop" => {
                if let Some(s) = self.tftp.lock().await.take() {
                    s.stop();
                }
                self.tftp_status().await
            }

            // ---- XMODEM / YMODEM / ZMODEM in a terminal tab ----
            "xfer:send" => {
                let (tab, protocol) = (s(0), s(1));
                if !["xmodem", "xmodem-1k", "ymodem", "zmodem"].contains(&protocol.as_str()) {
                    bail!("Unknown protocol");
                }
                let Some(files) = self.choose_files_to_send(&tab, &protocol, protocol == "ymodem" || protocol == "zmodem").await else {
                    return Ok(Value::Null);
                };
                let p = protocol.clone();
                self.run_xfer(&tab, &protocol, "send", None, move |io, signal, progress| async move {
                    if p == "zmodem" {
                        zmodem::send(io, &files, signal, Some(&progress)).await?;
                    } else {
                        xmodem::send(io, &files, &p, signal, Some(&progress)).await?;
                    }
                    Ok(Some(files))
                })
                .await?
            }
            "xfer:receive" => {
                let (tab, protocol) = (s(0), s(1));
                if !["xmodem", "ymodem", "zmodem"].contains(&protocol.as_str()) {
                    bail!("Unknown protocol");
                }
                let (dir, name) = if protocol == "xmodem" {
                    let Some(f) =
                        self.one(self.save_dialog(Some("Receive XMODEM — save as"), &home().join("Downloads").join("received.bin"), &[]), Kind::Save).await
                    else {
                        return Ok(Value::Null);
                    };
                    let p = f.path().to_path_buf();
                    if p.exists() {
                        std::fs::remove_file(&p)?; // the user confirmed replacing it in the dialog
                    }
                    (p.parent().map(Path::to_path_buf).unwrap_or_default(), p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
                } else {
                    let Some(d) =
                        self.one(self.open_dialog(Some(format!("Receive {} — choose a folder", protocol.to_uppercase())), &Value::Null), Kind::Folder).await
                    else {
                        return Ok(Value::Null);
                    };
                    (d.path().to_path_buf(), String::new())
                };
                let p = protocol.clone();
                self.run_xfer(&tab, &protocol, "receive", None, move |io, signal, progress| async move {
                    Ok(Some(if p == "zmodem" {
                        zmodem::receive(io, &dir, signal, Some(&progress)).await?
                    } else {
                        xmodem::receive(io, &dir, &p, &name, signal, Some(&progress)).await?
                    }))
                })
                .await?
            }
            "xfer:cancel" => {
                if let Some(sig) = self.xfers.lock().get(&s(0)) {
                    sig.cancel();
                }
                Value::Null
            }

            // ---- SSH keys ----
            "keys:list" => json!(ssh_keys::list_public_keys(None)),
            "keys:generate" => {
                let o = v(0);
                tokio::task::spawn_blocking(move || ssh_keys::generate_key(&o, None)).await??
            }
            "keys:install" => {
                self.warm_keychain().await;
                let key = ssh_keys::list_public_keys(None)
                    .into_iter()
                    .find(|k| k["file"] == s(1).as_str())
                    .ok_or_else(|| anyhow!("Choose a public key from ~/.ssh"))?;
                let mut session = self.store.lock().resolve_session(&v(0))?;
                if str_at(&session, &["protocol"]) != "ssh2" {
                    bail!("Keys can only be installed on SSH2 sessions");
                }
                session["forwards"] = json!([]);
                let (ev, _rx) = tokio::sync::mpsc::unbounded_channel();
                let conn = connect_client(session, self.prompt_ctx(None), ev, Mode::Tunnel).await?;
                let out = exec_text(&conn, &ssh_keys::install_command(&str_at(&key, &["line"]))?, Duration::from_secs(15))
                    .await
                    .map_err(|_| anyhow!("The server did not answer"));
                conn.close();
                let out = out?;
                if out.contains("TERMCRAFT_KEY_PRESENT") {
                    json!({ "status": "present", "privateKey": key["privateKey"] })
                } else if out.contains("TERMCRAFT_KEY_ADDED") {
                    json!({ "status": "added", "privateKey": key["privateKey"] })
                } else {
                    bail!("The server did not accept the key (it may not be a Unix shell): {}", out.trim().chars().take(200).collect::<String>());
                }
            }

            // ---- save terminal output ----
            "file:saveOutput" => {
                let name: String = regex::Regex::new(r"[^\w.@ -]+")
                    .unwrap()
                    .replace_all(&Some(s(0)).filter(|n| !n.is_empty()).unwrap_or_else(|| "output".into()), "_")
                    .chars()
                    .take(100)
                    .collect();
                let Some(f) =
                    self.one(self.save_dialog(Some("Save Output As"), &home().join(format!("{name}.txt")), &[("Text", &["txt", "log"])]), Kind::Save).await
                else {
                    return Ok(Value::Null);
                };
                write_mode(f.path(), s(1).as_bytes(), 0o600)?;
                json!(f.path().to_string_lossy())
            }

            // ---- scripts ----
            "script:run" => {
                let mut file = s(0);
                if !file.is_empty() && !self.is_approved_script(&file) {
                    bail!("That script has not been chosen or configured in TermCraft");
                }
                if file.is_empty() {
                    let mut d = self.open_dialog(Some("Run Script".into()), &json!([{ "name": "JavaScript", "extensions": ["js"] }]));
                    d = d.set_directory(self.resources.join("examples").join("scripts"));
                    let Some(f) = self.one(d, Kind::File).await else { return Ok(Value::Null) };
                    file = f.path().to_string_lossy().into_owned();
                    self.approved.lock().approve_file(&file);
                }
                {
                    let mut st = self.store.lock();
                    let mut recent: Vec<Value> = vec![json!(file)];
                    recent.extend(arr(&st.settings()["recentScripts"]).iter().filter(|f| f.as_str() != Some(&file)).cloned());
                    recent.truncate(8);
                    st.save_settings(&json!({ "recentScripts": recent }))?;
                }
                self.refresh_menu();
                let tab = v(1).as_str().map(String::from);
                match self.scripts.run(&expand_tilde(&file), tab, vec![]).await {
                    Ok(()) => json!({ "ok": true }),
                    Err(e) => json!({ "ok": false, "error": e.to_string() }),
                }
            }
            "script:cancel" => {
                self.scripts.cancel_all();
                Value::Null
            }

            // ---- misc ----
            // Dialog results are what the user explicitly chose, so they become approved paths.
            "dialog:openFile" => {
                let o = v(0);
                let Some(f) = self.one(self.open_dialog(Some(str_at(&o, &["title"])).filter(|t| !t.is_empty()), &o["filters"]), Kind::File).await else {
                    return Ok(Value::Null);
                };
                let p = f.path().to_string_lossy().into_owned();
                self.approved.lock().approve_file(&p);
                json!(p)
            }
            "dialog:openDir" => {
                let o = v(0);
                let Some(f) = self.one(self.open_dialog(Some(str_at(&o, &["title"])).filter(|t| !t.is_empty()), &Value::Null), Kind::Folder).await else {
                    return Ok(Value::Null);
                };
                let p = f.path().to_string_lossy().into_owned();
                self.approved.lock().choose_dir(&p);
                json!(p)
            }
            "file:readText" => {
                if !self.approved.lock().is_approved_file(&s(0)) {
                    bail!("File was not chosen in a dialog");
                }
                json!(std::fs::read_to_string(s(0))?)
            }
            "file:saveText" => {
                let Some(f) = self.one(self.save_dialog(None, &home().join(s(0)), &[("JSON", &["json"])]), Kind::Save).await else { return Ok(Value::Null) };
                std::fs::write(f.path(), s(1))?;
                json!(f.path().to_string_lossy())
            }
            // "Launch Application" buttons: run a program configured on a saved button, without a
            // shell, after the user approves that exact command in a native dialog.
            "shell:run" => {
                let command = s(0);
                let configured = arr(&self.store.lock().settings()["buttonBars"])
                    .iter()
                    .any(|b| arr(&b["buttons"]).iter().any(|x| x["action"] == "run" && x["value"] == command.as_str()));
                if !configured {
                    bail!("Command is not configured on any button");
                }
                json!(self.launcher.lock().await.run(&command).await?)
            }
            "clipboard:read" => json!(self.clipboard(|c| c.get_text().unwrap_or_default()).unwrap_or_default()),
            "clipboard:write" => {
                let t = s(0);
                self.clipboard(|c| c.set_text(t));
                Value::Null
            }
            "app:info" => json!({
                "platform": platform(), "version": env!("CARGO_PKG_VERSION"), "home": home().to_string_lossy(),
                "defaultShell": default_shell(), "encryption": self.secrets.is_available(),
            }),
            // Folders only: opening a file could launch an executable.
            "shell:openPath" => {
                let target = resolve(expand_tilde(&s(0)));
                if !target.exists() {
                    mkdir_private(&target)?;
                }
                if !target.is_dir() {
                    self.reveal(&target);
                    return Ok(json!(""));
                }
                json!(self.open_path(&target))
            }
            "shell:openExternal" => {
                let url = s(0);
                json!(is_safe_external_url(&url) && self.open_external(&url))
            }
            "menu:state" => {
                {
                    let mut m = self.menu_state.lock();
                    for (k, x) in v(0).as_object().into_iter().flatten() {
                        m[k] = x.clone();
                    }
                }
                self.refresh_menu();
                Value::Null
            }
            // Native parts (title bar, window controls, scrollbars, system dialogs) follow the
            // app's theme.
            "app:chrome" => {
                let o = v(0);
                if let Some(w) = self.window() {
                    match str_at(&o, &["source"]).as_str() {
                        "system" => {
                            let _ = w.set_theme(None);
                        }
                        "light" => {
                            let _ = w.set_theme(Some(tauri::Theme::Light));
                        }
                        "dark" => {
                            let _ = w.set_theme(Some(tauri::Theme::Dark));
                        }
                        _ => {}
                    }
                    let bg = str_at(&o, &["bg"]);
                    if regex::Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap().is_match(&bg) {
                        let c = u32::from_str_radix(&bg[1..], 16).unwrap_or(0);
                        let _ = w.set_background_color(Some(tauri::window::Color((c >> 16) as u8, (c >> 8) as u8, c as u8, 255)));
                    }
                }
                Value::Null
            }
            "app:about" => json!({
                "version": env!("CARGO_PKG_VERSION"), "copyright": COPYRIGHT, "notice": LICENSE_NOTICE,
                "tauri": tauri::VERSION, "webview": tauri::webview_version().unwrap_or_default(), "rust": env!("TERMCRAFT_RUSTC"),
            }),
            "app:keychainStatus" => {
                let needs = self.store.lock().has_encrypted_secrets();
                if !needs {
                    json!("none")
                } else {
                    let sb = self.secrets.clone();
                    let ok = tokio::task::spawn_blocking(move || sb.is_available() && sb.encrypt("termcraft-keychain-check").is_ok()).await.unwrap_or(false);
                    json!(if ok { "ok" } else { "denied" })
                }
            }
            "app:licenseText" => json!(std::fs::read_to_string(self.resources.join("LICENSE"))?),
            "app:examplesDir" => json!(self.resources.join("examples").join("scripts").to_string_lossy()),
            _ => bail!("Unknown call {ch}"),
        })
    }

    async fn tftp_status(&self) -> Value {
        match &*self.tftp.lock().await {
            Some(t) => {
                json!({ "running": true, "root": t.opts.root.to_string_lossy(), "port": t.port, "host": t.opts.host, "allowWrite": t.opts.allow_write, "allowOverwrite": t.opts.allow_overwrite })
            }
            None => json!({ "running": false }),
        }
    }

    pub fn create_window(self: &Arc<Self>) -> tauri::Result<WebviewWindow> {
        self.allow_close.store(false, Ordering::SeqCst);
        let bounds = self.store.lock().settings()["windowBounds"].clone();
        let mut b = WebviewWindowBuilder::new(&self.handle, "main", WebviewUrl::App(INDEX.into()))
            .title("TermCraft")
            .inner_size(num_or(&bounds["width"], 1280.0), num_or(&bounds["height"], 800.0))
            .min_inner_size(640.0, 400.0)
            .background_color(tauri::window::Color(0x1b, 0x1d, 0x23, 255))
            .disable_drag_drop_handler_if(false)
            .devtools(cfg!(debug_assertions))
            // The page never navigates; links open in the system browser.
            .on_navigation(is_app_url)
            .on_new_window({
                let me = Arc::downgrade(self);
                move |url, _features| {
                    if let Some(me) = me.upgrade() {
                        if is_safe_external_url(url.as_str()) {
                            me.open_external(url.as_str());
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                }
            })
            .on_download(|_, _| false)
            // Deny every web permission (camera, microphone, geolocation, notifications…). Without
            // this, the macOS web view grants camera and microphone requests.
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny);
        if bounds["x"].is_number() && bounds["y"].is_number() {
            b = b.position(num_or(&bounds["x"], 0.0), num_or(&bounds["y"], 0.0));
        }
        #[cfg(target_os = "macos")]
        {
            // The toolbar is the title bar (window controls inset into it), like native Mac apps.
            b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(14.0, 14.0));
        }
        let w = b.build()?;
        self.refresh_menu();
        Ok(w)
    }

    pub fn save_bounds(&self, w: &tauri::Window) {
        let scale = w.scale_factor().unwrap_or(1.0);
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
            let p = p.to_logical::<f64>(scale);
            let s = s.to_logical::<f64>(scale);
            let _ = self
                .store
                .lock()
                .save_settings(&json!({ "windowBounds": { "x": p.x.round(), "y": p.y.round(), "width": s.width.round(), "height": s.height.round() } }));
        }
    }
}

trait DragDropExt {
    fn disable_drag_drop_handler_if(self, disable: bool) -> Self;
}
impl<'a, R: tauri::Runtime, M: tauri::Manager<R>> DragDropExt for WebviewWindowBuilder<'a, R, M> {
    fn disable_drag_drop_handler_if(self, disable: bool) -> Self {
        if disable { self.disable_drag_drop_handler() } else { self }
    }
}

/// TermCraft's own page (tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows).
pub fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Native (not page-drawn) approval for a Launch Application command.
async fn confirm_launch(handle: &AppHandle, argv: &[String], command: &str) -> Approval {
    let args = &argv[1..];
    let detail = format!(
        "Program: {}\n{}\nCommand: {command}\n\nOnly allow programs you trust. Button bars imported from someone else can contain commands.",
        argv[0],
        if args.is_empty() {
            String::new()
        } else {
            format!("Arguments: {}\n", args.iter().map(|a| serde_json::to_string(a).unwrap_or_default()).collect::<Vec<_>>().join(" "))
        }
    );
    if let Some(app) = handle.try_state::<Arc<App>>() {
        let answer = app.test.boxes.lock().pop_front();
        if let Some(a) = answer {
            app.test.box_calls.lock().push(detail);
            return match a.as_str() {
                "once" => Approval::Once,
                "always" => Approval::Always,
                _ => Approval::Cancel,
            };
        }
    }
    let mut d = rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("Launch Application")
        .set_description(format!("Allow this button to run a program on your computer?\n\n{detail}"))
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom("Run Once".into(), "Always Allow".into(), "Cancel".into()));
    if let Some(w) = handle.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    match d.show().await {
        rfd::MessageDialogResult::Custom(c) if c == "Run Once" => Approval::Once,
        rfd::MessageDialogResult::Custom(c) if c == "Always Allow" => Approval::Always,
        rfd::MessageDialogResult::Yes => Approval::Once,
        rfd::MessageDialogResult::No => Approval::Always,
        _ => Approval::Cancel,
    }
}

#[cfg(test)]
mod write_queue_tests {
    use super::WriteQueue;

    fn push(q: &mut WriteQueue, n: u64, d: &str) -> Vec<String> {
        q.push(n, d.to_string())
    }

    #[test]
    fn keystrokes_come_out_in_order_whatever_order_they_arrive_in() {
        let mut q = WriteQueue::default();
        assert!(push(&mut q, 2, "b").is_empty(), "the second keystroke waits for the first");
        assert!(push(&mut q, 3, "c").is_empty());
        assert_eq!(push(&mut q, 1, "a"), vec!["a", "b", "c"], "nothing held is lost when #1 arrives");
        assert!(push(&mut q, 5, "e").is_empty());
        assert_eq!(push(&mut q, 4, "d"), vec!["d", "e"]);
        // The page reloads and counts from 1 again.
        assert_eq!(push(&mut q, 1, "x"), vec!["x"]);
        assert_eq!(push(&mut q, 2, "y"), vec!["y"]);
    }
}
