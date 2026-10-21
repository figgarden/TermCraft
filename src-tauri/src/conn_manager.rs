// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Terminal tabs' connections: output decoding and batching, session logs, logon actions,
//! auto-login, anti-idle, script waits (WaitForString) and ZMODEM auto-start.

use crate::auto_login::AutoLogin;
use crate::bus::Bus;
use crate::json::{arr, at, num_at, str_at, string, truthy};
use crate::proto::{self, Conn, Ctx, Event};
use crate::store::{Store, mkdir_private};
use crate::util::{expand_escapes, expand_log_path, strip_ansi, timestamp};
use crate::xmodem::Io;
use anyhow::{Result, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Chars of recent output kept for expect/WaitForString matching.
const MATCH_WINDOW: usize = 8192;

/// Keep the last `n` characters of `s`.
fn tail_chars(s: &mut String, n: usize) {
    if s.len() <= n {
        return;
    }
    let count = s.chars().count();
    if count > n {
        let cut = s.char_indices().nth(count - n).map(|(i, _)| i).unwrap_or(0);
        s.drain(..cut);
    }
}

struct Waiter {
    patterns: Vec<String>,
    buf: String,
    tx: Option<oneshot::Sender<(i64, String)>>,
}

impl Waiter {
    /// Feed text; true when finished.
    fn feed(&mut self, text: &str) -> bool {
        self.buf.push_str(text);
        tail_chars(&mut self.buf, MATCH_WINDOW * 4);
        let mut best: Option<(usize, usize)> = None;
        for (i, p) in self.patterns.iter().enumerate() {
            if let Some(at) = self.buf.find(p.as_str()) {
                if best.is_none_or(|(_, b)| at < b) {
                    best = Some((i, at));
                }
            }
        }
        if let Some((i, at)) = best {
            let before = self.buf[..at].to_string();
            self.finish(i as i64, Some(before));
            return true;
        }
        false
    }

    fn finish(&mut self, index: i64, before: Option<String>) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send((index, before.unwrap_or_else(|| self.buf.clone())));
        }
    }
}

struct Log {
    file: std::io::BufWriter<std::fs::File>,
    path: String,
    strip: bool,
    timestamps: bool,
}

struct TabState {
    conn: Option<Conn>,
    state: String,
    decoder: encoding_rs::Decoder,
    log: Option<Log>,
    log_line_start: bool,
    recent: String,
    waiters: HashMap<u64, Waiter>,
    logon: Option<usize>,
    last_input: Instant,
    pending: String,
    auto_login: Option<AutoLogin>,
    raw: Option<mpsc::UnboundedSender<Vec<u8>>>,
    z_tail: Vec<u8>,
    anti_idle: Option<tokio::task::JoinHandle<()>>,
}

pub struct Tab {
    pub id: String,
    pub session: Value,
    generation: u64,
    st: Mutex<TabState>,
}

pub type ZmodemHook = Arc<dyn Fn(String, &'static str, Io) + Send + Sync>;
pub type ScriptHook = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<()>> + Send + Sync>;

pub struct Manager {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
    seq: AtomicU64,
    on_zmodem: Mutex<Option<ZmodemHook>>,
    run_script: Mutex<Option<ScriptHook>>,
}

fn decoder_for(encoding: &str) -> encoding_rs::Decoder {
    encoding_rs::Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8).new_decoder()
}

fn decode(dec: &mut encoding_rs::Decoder, bytes: &[u8], last: bool) -> String {
    let mut out = String::with_capacity(dec.max_utf8_buffer_length(bytes.len()).unwrap_or(bytes.len() * 3));
    let _ = dec.decode_to_string(bytes, &mut out, last);
    out
}

impl Manager {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>) -> Arc<Manager> {
        Arc::new(Manager { bus, store, tabs: Mutex::new(HashMap::new()), seq: AtomicU64::new(0), on_zmodem: Mutex::new(None), run_script: Mutex::new(None) })
    }

    pub fn set_hooks(&self, on_zmodem: ZmodemHook, run_script: ScriptHook) {
        *self.on_zmodem.lock() = Some(on_zmodem);
        *self.run_script.lock() = Some(run_script);
    }

    pub fn get(&self, tab_id: &str) -> Option<Arc<Tab>> {
        self.tabs.lock().get(tab_id).cloned()
    }

    pub fn state(&self, tab_id: &str) -> Option<String> {
        self.get(tab_id).map(|t| t.st.lock().state.clone())
    }

    pub fn info(&self, tab_id: &str, msg: &str, color: u8) {
        self.bus.send("conn:data", vec![json!(tab_id), json!(format!("\r\n\x1b[{color}m[TermCraft] {msg}\x1b[0m\r\n"))]);
    }

    fn set_state(&self, t: &Tab, state: &str, extra: Value) {
        t.st.lock().state = state.to_string();
        let mut payload = json!({ "state": state });
        if let Some(m) = extra.as_object() {
            for (k, v) in m {
                payload[k] = v.clone();
            }
        }
        self.bus.send("conn:state", vec![json!(t.id), payload]);
    }

    fn is_current(&self, t: &Arc<Tab>) -> bool {
        self.tabs.lock().get(&t.id).is_some_and(|x| x.generation == t.generation)
    }

    pub async fn open(self: &Arc<Self>, tab_id: &str, session_ref: &Value, cols: u16, rows: u16) -> Result<()> {
        self.close(tab_id, true);
        let session = self.store.lock().resolve_session(session_ref)?;
        let protocol = str_at(&session, &["protocol"]);
        if !proto::PROTOCOLS.contains(&protocol.as_str()) {
            bail!("Unknown protocol {protocol}");
        }
        let t = Arc::new(Tab {
            id: tab_id.to_string(),
            generation: self.seq.fetch_add(1, Ordering::SeqCst),
            st: Mutex::new(TabState {
                conn: None,
                state: "idle".into(),
                decoder: decoder_for(&str_at(&session, &["terminal", "encoding"])),
                log: None,
                log_line_start: true,
                recent: String::new(),
                waiters: HashMap::new(),
                logon: None,
                last_input: Instant::now(),
                pending: String::new(),
                auto_login: None,
                raw: None,
                z_tail: Vec::new(),
                anti_idle: None,
            }),
            session: session.clone(),
        });
        self.tabs.lock().insert(tab_id.to_string(), t.clone());

        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        self.spawn_events(t.clone(), ev_rx, session_ref.clone());
        let bus = self.bus.clone();
        let tid = tab_id.to_string();
        let ctx = Ctx {
            store: self.store.clone(),
            prompt: Arc::new(move |mut req: Value| {
                req["tabId"] = json!(tid);
                bus.request("prompt", req)
            }),
        };
        let target = match protocol.as_str() {
            "serial" => str_at(&session, &["serial", "path"]),
            "local" => "local shell".into(),
            "rnsh" => format!("rnsh {}", str_at(&session, &["host"])),
            "rntool" => "Reticulum".into(),
            _ => format!("{}:{}", str_at(&session, &["host"]), crate::json::string(&session["port"])),
        };
        self.set_state(&t, "connecting", json!({ "target": target }));
        // Open the log before connecting so banners and MOTD are captured.
        if at(&session, &["logging", "enabled"]) == true {
            self.start_log(tab_id, None);
        }
        let conn = match proto::connect(session.clone(), ctx, cols, rows, ev_tx).await {
            Ok(c) => c,
            Err(e) => {
                if !self.is_current(&t) {
                    return Ok(()); // replaced or closed while connecting
                }
                let msg = e.to_string();
                self.info(tab_id, &format!("Connection to {target} failed: {msg}"), 31);
                self.set_state(&t, "failed", json!({ "error": msg }));
                self.stop_log(tab_id);
                return Ok(());
            }
        };
        if !self.is_current(&t) {
            conn.close();
            return Ok(());
        }
        let connected_at = chrono::Utc::now().timestamp_millis();
        let username = if conn.username.is_empty() { str_at(&session, &["username"]) } else { conn.username.clone() };
        {
            let mut st = t.st.lock();
            st.conn = Some(conn);
            st.auto_login = AutoLogin::new(&session);
            if !arr(&session["logonActions"]).is_empty() {
                st.logon = Some(0);
            }
        }
        self.set_state(&t, "connected", json!({ "connectedAt": connected_at, "username": username }));
        self.advance_logon(&t);
        self.start_anti_idle(&t);
        let script = str_at(&session, &["logonScript"]);
        if !script.is_empty() {
            if let Some(run) = self.run_script.lock().clone() {
                let me = self.clone();
                let tid = tab_id.to_string();
                tokio::spawn(async move {
                    if let Err(e) = run(script, tid.clone()).await {
                        me.info(&tid, &format!("Logon script: {e}"), 31);
                    }
                });
            }
        }
        Ok(())
    }

    fn spawn_events(self: &Arc<Self>, t: Arc<Tab>, mut rx: mpsc::UnboundedReceiver<Event>, session_ref: Value) {
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                let mut closed = me.handle_event(&t, e, &session_ref);
                // Coalesce bursts into a single message per batch.
                let mut n = 0;
                while !closed && n < 256 {
                    match rx.try_recv() {
                        Ok(e) => closed = me.handle_event(&t, e, &session_ref),
                        Err(_) => break,
                    }
                    n += 1;
                }
                me.flush(&t);
                if closed {
                    break;
                }
            }
        });
    }

    fn flush(&self, t: &Tab) {
        let out = {
            let mut st = t.st.lock();
            if let Some(log) = st.log.as_mut() {
                let _ = log.file.flush();
            }
            std::mem::take(&mut st.pending)
        };
        if !out.is_empty() {
            self.bus.send("conn:data", vec![json!(t.id), json!(out)]);
        }
    }

    /// Returns true when the connection closed.
    fn handle_event(self: &Arc<Self>, t: &Arc<Tab>, e: Event, session_ref: &Value) -> bool {
        match e {
            Event::Data(d) => self.on_data(t, d),
            Event::Info(m) => {
                self.flush(t);
                self.info(&t.id, &m, 90);
            }
            Event::Status(s) => self.bus.send("conn:status", vec![json!(t.id), s]),
            Event::Credentials(c) => self.save_credentials(&t.id, if truthy(&c["target"]) { c["target"].clone() } else { session_ref.clone() }, c),
            Event::Error(m) => {
                self.flush(t);
                self.info(&t.id, &format!("Error: {m}"), 31);
            }
            Event::Close => {
                self.flush(t);
                self.on_close(t);
                return true;
            }
        }
        false
    }

    /// Persist a login the user chose to save, then tell the page which session now holds it.
    fn save_credentials(&self, tab_id: &str, r: Value, creds: Value) {
        let res = self.store.lock().save_credentials(&r, &creds);
        match res {
            Ok(saved) => self.bus.send("session:saved", vec![json!(tab_id), json!({ "session": saved, "forTab": !truthy(&creds["target"]) })]),
            Err(e) => self.info(tab_id, &format!("Could not save login: {e}"), 31),
        }
    }

    fn encode(t: &Tab, s: &str) -> Vec<u8> {
        let enc = str_at(&t.session, &["terminal", "encoding"]).to_lowercase();
        if ["iso-8859-1", "latin1", "windows-1252", "us-ascii"].contains(&enc.as_str()) {
            return s.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect();
        }
        s.as_bytes().to_vec()
    }

    fn on_data(self: &Arc<Self>, t: &Arc<Tab>, buf: Vec<u8>) {
        // Output still arriving for a tab that was closed or replaced is dropped.
        if !self.is_current(t) {
            return;
        }
        // During an XMODEM/YMODEM/ZMODEM transfer the bytes belong to the transfer, not the screen.
        {
            let st = t.st.lock();
            if let Some(raw) = &st.raw {
                let _ = raw.send(buf);
                return;
            }
        }
        // The device started ZMODEM ("rz" waits for files, "sz" sends): hand the rest to a transfer.
        let hook = self.on_zmodem.lock().clone();
        if let Some(hook) = hook.filter(|_| self.store.lock().settings()["zmodemAutoStart"] != false) {
            let mut scan = std::mem::take(&mut t.st.lock().z_tail);
            let tail_len = scan.len();
            scan.extend_from_slice(&buf);
            if let Some((direction, at)) = crate::zmodem::detect(&scan) {
                let before = if at > tail_len { scan[tail_len..at].to_vec() } else { vec![] };
                let rest = scan[at..].to_vec();
                if !before.is_empty() {
                    self.on_data(t, before);
                }
                self.flush(t);
                if let Ok(io) = self.begin_raw(&t.id, rest) {
                    hook(t.id.clone(), direction, io);
                }
                return;
            }
            t.st.lock().z_tail = scan[scan.len().saturating_sub(5)..].to_vec();
        }
        let (plain, answer, logon_needed, waiter_done) = {
            let mut st = t.st.lock();
            let text = decode(&mut st.decoder, &buf, false);
            if text.is_empty() {
                return;
            }
            st.pending.push_str(&text);
            Self::write_log(&mut st, &text);
            let plain = strip_ansi(&text);
            st.recent.push_str(&plain);
            tail_chars(&mut st.recent, MATCH_WINDOW);
            let answer = st.auto_login.as_mut().and_then(|a| a.feed(&plain));
            let mut done = Vec::new();
            for (id, w) in st.waiters.iter_mut() {
                if w.feed(&plain) {
                    done.push(*id);
                }
            }
            for id in &done {
                st.waiters.remove(id);
            }
            (plain, answer, st.logon.is_some(), done)
        };
        let _ = (plain, waiter_done);
        if let Some(a) = answer {
            self.write(&t.id, &a, true);
        }
        if logon_needed {
            self.advance_logon(t);
        }
    }

    fn advance_logon(&self, t: &Tab) {
        let actions = arr(&t.session["logonActions"]).to_vec();
        loop {
            let send = {
                let mut st = t.st.lock();
                let Some(i) = st.logon else { return };
                if i >= actions.len() {
                    st.logon = None;
                    return;
                }
                let a = &actions[i];
                let expect = str_at(a, &["expect"]);
                if !expect.is_empty() {
                    let Some(at) = st.recent.find(&expect) else { return };
                    st.recent = st.recent[at + expect.len()..].to_string();
                }
                st.logon = Some(i + 1);
                a.get("send").filter(|s| !s.is_null()).map(|s| expand_escapes(&string(s)))
            };
            if let Some(s) = send {
                self.write(&t.id, &s, true);
            }
        }
    }

    fn start_anti_idle(self: &Arc<Self>, t: &Arc<Tab>) {
        let ai = &t.session["antiIdle"];
        let interval = num_at(ai, &["interval"], 0.0);
        if ai["enabled"] != true || interval <= 0.0 {
            return;
        }
        let me = Arc::downgrade(self);
        let tab = Arc::downgrade(t);
        let text = expand_escapes(&str_at(ai, &["string"]));
        let period = Duration::from_secs_f64(interval.min(10.0));
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(period);
            tick.tick().await;
            loop {
                tick.tick().await;
                let (Some(me), Some(t)) = (me.upgrade(), tab.upgrade()) else { break };
                let idle = t.st.lock().last_input.elapsed();
                if idle >= Duration::from_secs_f64(interval) {
                    me.write(&t.id, &text, true);
                }
            }
        });
        t.st.lock().anti_idle = Some(task);
    }

    fn on_close(&self, t: &Arc<Tab>) {
        if !self.is_current(t) {
            return;
        }
        self.finish_tab(t);
        let was_connected = t.st.lock().state == "connected";
        let reconnect = if was_connected && at(&t.session, &["reconnect", "enabled"]) == true { num_at(&t.session, &["reconnect", "delay"], 5.0) } else { 0.0 };
        self.set_state(t, "disconnected", json!({ "reconnect": reconnect }));
        if was_connected {
            self.info(&t.id, &format!("Disconnected ({})", chrono::Local::now().format("%-I:%M:%S %p")), 33);
        }
    }

    /// Flush the decoder, stop timers, the log and script waits.
    fn finish_tab(&self, t: &Tab) {
        let tail = {
            let mut st = t.st.lock();
            if let Some(a) = st.anti_idle.take() {
                a.abort();
            }
            for (_, mut w) in st.waiters.drain() {
                w.finish(-1, None);
            }
            let tail = decode(&mut st.decoder, &[], true);
            // A finished decoder can't be used again; output that still arrives gets a new one.
            st.decoder = decoder_for(&str_at(&t.session, &["terminal", "encoding"]));
            tail
        };
        if !tail.is_empty() {
            self.bus.send("conn:data", vec![json!(t.id), json!(tail)]);
        }
        self.stop_log(&t.id);
    }

    /// `automated`: sent by logon actions / anti-idle / scripts (doesn't reset the idle timer).
    pub fn write(&self, tab_id: &str, data: &str, automated: bool) -> bool {
        let Some(t) = self.get(tab_id) else { return false };
        let mut st = t.st.lock();
        if st.state != "connected" {
            return false;
        }
        let Some(conn) = st.conn.clone() else { return false };
        if !automated {
            st.last_input = Instant::now();
        }
        drop(st);
        conn.write(Self::encode(&t, data));
        true
    }

    pub fn resize(&self, tab_id: &str, cols: u16, rows: u16) {
        if let Some(t) = self.get(tab_id) {
            let st = t.st.lock();
            if st.state == "connected" {
                if let Some(c) = &st.conn {
                    c.resize(cols, rows);
                }
            }
        }
    }

    pub fn send_break(&self, tab_id: &str) {
        if let Some(c) = self.get(tab_id).and_then(|t| t.st.lock().conn.clone()) {
            c.send_break();
        }
    }

    pub fn close(&self, tab_id: &str, silent: bool) {
        let Some(t) = self.get(tab_id) else { return };
        let conn = t.st.lock().conn.take();
        if silent {
            self.tabs.lock().remove(tab_id);
            self.finish_tab(&t);
        } else {
            // As if the connection closed by itself: the page shows "Disconnected".
            self.on_close(&t);
            self.tabs.lock().remove(tab_id);
        }
        if let Some(c) = conn {
            c.close();
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.tabs.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id, true);
        }
    }

    /// Hand a connected tab's byte stream to a transfer protocol until `end_raw`. `initial` is
    /// data that already arrived (e.g. the start of a ZMODEM frame).
    pub fn begin_raw(&self, tab_id: &str, initial: Vec<u8>) -> Result<Io> {
        let Some(t) = self.get(tab_id) else { bail!("Connect the tab first") };
        let mut st = t.st.lock();
        if st.state != "connected" {
            bail!("Connect the tab first");
        }
        if st.raw.is_some() {
            bail!("A file transfer is already running in this tab");
        }
        let Some(conn) = st.conn.clone() else { bail!("Connect the tab first") };
        let (tx, rx) = mpsc::unbounded_channel();
        if !initial.is_empty() {
            let _ = tx.send(initial);
        }
        st.raw = Some(tx);
        Ok(Io { write: Arc::new(move |b: &[u8]| conn.write(b.to_vec())), rx })
    }

    pub fn end_raw(&self, tab_id: &str) {
        if let Some(t) = self.get(tab_id) {
            let mut st = t.st.lock();
            st.raw = None;
            st.z_tail.clear();
        }
    }

    // ---- logging -------------------------------------------------------
    pub fn start_log(&self, tab_id: &str, file: Option<String>) -> Option<String> {
        let t = self.get(tab_id)?;
        self.stop_log(tab_id);
        let cfg = &t.session["logging"];
        let template = Some(str_at(cfg, &["path"])).filter(|p| !p.is_empty()).unwrap_or_else(|| "~/TermCraft Logs/%S-%Y%M%D-%h%m%s.log".into());
        let target = file.unwrap_or_else(|| expand_log_path(&template, &t.session, chrono::Local::now()));
        // Session logs can contain sensitive output: private directory and file.
        let path = PathBuf::from(&target);
        let opened = (|| -> std::io::Result<std::fs::File> {
            if let Some(dir) = path.parent() {
                mkdir_private(dir)?;
            }
            let mut o = std::fs::OpenOptions::new();
            o.create(true);
            if cfg["append"] == false {
                o.write(true).truncate(true)
            } else {
                o.append(true)
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            o.open(&path)
        })();
        let f = match opened {
            Ok(f) => f,
            Err(e) => {
                self.info(tab_id, &format!("Log error: {e}"), 31);
                return None;
            }
        };
        let name = Some(str_at(&t.session, &["name"])).filter(|n| !n.is_empty()).unwrap_or_else(|| str_at(&t.session, &["host"]));
        let mut log = Log { file: std::io::BufWriter::new(f), path: target.clone(), strip: cfg["stripAnsi"] != false, timestamps: cfg["timestamps"] == true };
        let _ = write!(log.file, "\n===== Session log started {} ({name}) =====\n", timestamp());
        let _ = log.file.flush();
        {
            let mut st = t.st.lock();
            st.log = Some(log);
            st.log_line_start = true;
        }
        self.bus.send("conn:log", vec![json!(tab_id), json!({ "logging": true, "path": target })]);
        Some(target)
    }

    pub fn stop_log(&self, tab_id: &str) {
        let Some(t) = self.get(tab_id) else { return };
        let Some(mut log) = t.st.lock().log.take() else { return };
        let _ = write!(log.file, "\n===== Session log stopped {} =====\n", timestamp());
        let _ = log.file.flush();
        let _ = log.path;
        self.bus.send("conn:log", vec![json!(tab_id), json!({ "logging": false })]);
    }

    fn write_log(st: &mut TabState, text: &str) {
        let Some(log) = st.log.as_mut() else { return };
        let mut out = if log.strip { strip_ansi(text).replace("\r\n", "\n").replace('\r', "") } else { text.to_string() };
        if log.timestamps {
            let mut res = String::with_capacity(out.len() + 32);
            for ch in out.chars() {
                if st.log_line_start {
                    res.push_str(&format!("[{}] ", timestamp()));
                    st.log_line_start = false;
                }
                res.push(ch);
                if ch == '\n' {
                    st.log_line_start = true;
                }
            }
            out = res;
        }
        let _ = log.file.write_all(out.as_bytes());
    }

    // ---- scripting support ----------------------------------------------
    /// Wait until one of `patterns` appears in output received after this call. Returns
    /// (index, text before the match); index -1 on timeout or disconnect.
    pub async fn wait_for(&self, tab_id: &str, patterns: Vec<String>, timeout_ms: u64) -> (i64, String) {
        let Some(t) = self.get(tab_id) else { return (-1, String::new()) };
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut st = t.st.lock();
            if st.state != "connected" {
                return (-1, String::new());
            }
            st.waiters.insert(id, Waiter { patterns, buf: String::new(), tx: Some(tx) });
        }
        let r = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
                Ok(r) => r.ok(),
                Err(_) => None,
            }
        } else {
            rx.await.ok()
        };
        match r {
            Some(r) => r,
            None => {
                let w = t.st.lock().waiters.remove(&id);
                (-1, w.map(|w| w.buf).unwrap_or_default())
            }
        }
    }

    pub fn session_of(&self, tab_id: &str) -> Option<Value> {
        self.get(tab_id).map(|t| t.session.clone())
    }

    pub fn store(&self) -> &Arc<Mutex<Store>> {
        &self.store
    }
}
