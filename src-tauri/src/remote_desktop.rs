// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Remote desktops.
//!
//! VNC: the page embeds noVNC, which speaks RFB over a WebSocket. VncBridge runs a private
//! WebSocket server on 127.0.0.1 (random port, random per-tab token) and pipes each connection to
//! the VNC server — directly, or through an SSH tunnel when the session says so.
//!
//! RDP: there is no GPL-compatible embeddable RDP client, so RdpService opens the optional SSH
//! tunnel and launches the platform's own client (Windows App / Microsoft Remote Desktop on
//! macOS, mstsc on Windows, xfreerdp on Linux) with a generated .rdp file or arguments.

use crate::bus::Bus;
use crate::json::{at, bool_at, num_at, str_at};
use crate::proto::Ctx;
use crate::proto::ssh::{Mode, SshClient, connect_client};
use crate::security::build_argv;
use crate::store::{Store, mkdir_private, write_mode};
use anyhow::{Result, anyhow, bail};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// The way to reach a host: directly, or through the session's SSH tunnel.
pub struct Route {
    pub via: String,
    pub ssh: Option<Arc<SshClient>>,
}

impl Route {
    async fn dial(&self, host: &str, port: u16) -> Result<Box<dyn Duplex>> {
        match &self.ssh {
            Some(ssh) => Ok(Box::new(ssh.direct_tcpip(host, port).await?)),
            None => Ok(Box::new(TcpStream::connect((host, port)).await?)),
        }
    }
}

/// Open the session's SSH tunnel, if it has one.
pub async fn open_route(store: &Arc<Mutex<Store>>, session: &Value, ctx: Ctx) -> Result<Route> {
    let tunnel = str_at(session, &["tunnel", "sshSessionId"]);
    if tunnel.is_empty() {
        return Ok(Route { via: String::new(), ssh: None });
    }
    let mut cfg = store.lock().resolve_session(&json!(tunnel))?;
    cfg["forwards"] = json!([]);
    let (ev, _rx) = tokio::sync::mpsc::unbounded_channel();
    let ssh = connect_client(cfg.clone(), ctx, ev, Mode::Tunnel).await?;
    let via = Some(str_at(&cfg, &["name"])).filter(|n| !n.is_empty()).unwrap_or_else(|| str_at(&cfg, &["host"]));
    Ok(Route { via, ssh: Some(ssh) })
}

fn prompt_ctx(bus: &Bus, store: &Arc<Mutex<Store>>, tab_id: &str) -> Ctx {
    let bus = bus.clone();
    let tid = tab_id.to_string();
    Ctx {
        store: store.clone(),
        prompt: Arc::new(move |mut req: Value| {
            req["tabId"] = json!(tid);
            bus.request("prompt", req)
        }),
    }
}

struct VncRoute {
    tab_id: String,
    route: Arc<Route>,
    host: String,
    port: u16,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

pub struct VncBridge {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    routes: Arc<Mutex<HashMap<String, VncRoute>>>,
    server: tokio::sync::Mutex<Option<(u16, tokio::task::JoinHandle<()>)>>,
}

impl VncBridge {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>) -> Arc<VncBridge> {
        Arc::new(VncBridge { bus, store, routes: Default::default(), server: Default::default() })
    }

    async fn ensure_server(self: &Arc<Self>) -> Result<u16> {
        let mut srv = self.server.lock().await;
        if let Some((port, _)) = &*srv {
            return Ok(*port);
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let me = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let Some(me) = me.upgrade() else { break };
                tokio::spawn(async move { me.on_connection(sock).await });
            }
        });
        *srv = Some((port, task));
        Ok(port)
    }

    async fn on_connection(self: Arc<Self>, sock: TcpStream) {
        let path = Arc::new(Mutex::new(String::new()));
        let p2 = path.clone();
        // The handshake callback's error type is tungstenite's (a full HTTP response).
        #[allow(clippy::result_large_err)]
        let ws = tokio_tungstenite::accept_hdr_async_with_config(
            sock,
            move |req: &Request, mut res: Response| {
                *p2.lock() = req.uri().path().to_string();
                // noVNC asks for the "binary" subprotocol.
                let wants_binary =
                    req.headers().get_all("sec-websocket-protocol").iter().any(|h| h.to_str().unwrap_or("").split(',').any(|p| p.trim() == "binary"));
                if wants_binary {
                    res.headers_mut().insert("sec-websocket-protocol", "binary".parse().unwrap());
                }
                Ok(res)
            },
            None,
        )
        .await;
        let Ok(mut ws) = ws else { return };
        let token = path.lock().trim_start_matches("/vnc/").to_string();
        let entry = self.routes.lock().get(&token).map(|e| (e.tab_id.clone(), e.route.clone(), e.host.clone(), e.port));
        let Some((tab_id, route, host, port)) = entry else {
            let _ = ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 1008.into(), reason: "Unknown session".into() })).await;
            return;
        };
        let remote = match route.dial(&host, port).await {
            Ok(s) => s,
            Err(e) => {
                self.bus.send("remote:status", vec![json!(tab_id), json!({ "error": format!("Cannot reach {host}:{port}: {e}") })]);
                let _ = ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 1011.into(), reason: "Connection failed".into() })).await;
                return;
            }
        };
        let task = tokio::spawn(async move {
            let (mut rd, mut wr) = tokio::io::split(remote);
            let (mut wtx, mut wrx) = ws.split();
            let up = async {
                while let Some(Ok(m)) = wrx.next().await {
                    let data = match m {
                        Message::Binary(b) => b.to_vec(),
                        Message::Text(t) => t.as_bytes().to_vec(),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    if wr.write_all(&data).await.is_err() {
                        break;
                    }
                }
                let _ = wr.shutdown().await;
            };
            let down = async {
                let mut buf = vec![0u8; 65536];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if wtx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = wtx.close().await;
            };
            tokio::select! { _ = up => {}, _ = down => {} }
        });
        if let Some(e) = self.routes.lock().get_mut(&token) {
            e.tasks.push(task);
        }
    }

    /// Prepare a VNC connection for a tab. Returns the WebSocket URL for noVNC plus the stored
    /// login (noVNC performs RFB authentication in the page).
    pub async fn open(self: &Arc<Self>, tab_id: &str, session_ref: &Value) -> Result<Value> {
        self.close(tab_id);
        let session = self.store.lock().resolve_session(session_ref)?;
        if str_at(&session, &["protocol"]) != "vnc" {
            bail!("Not a VNC session");
        }
        let ws_port = self.ensure_server().await?;
        let route = open_route(&self.store, &session, prompt_ctx(&self.bus, &self.store, tab_id)).await?;
        let token = hex::encode(rand::random::<[u8; 24]>());
        let port = num_at(&session, &["port"], 5900.0) as u16;
        let via = route.via.clone();
        self.routes
            .lock()
            .insert(token.clone(), VncRoute { tab_id: tab_id.to_string(), route: Arc::new(route), host: str_at(&session, &["host"]), port, tasks: vec![] });
        Ok(json!({
            "url": format!("ws://127.0.0.1:{ws_port}/vnc/{token}"),
            "host": session["host"],
            "port": port,
            "via": via,
            "username": str_at(&session, &["username"]),
            "password": str_at(&session, &["auth", "password"]),
        }))
    }

    pub fn close(&self, tab_id: &str) {
        let mut routes = self.routes.lock();
        let tokens: Vec<String> = routes.iter().filter(|(_, e)| e.tab_id == tab_id).map(|(t, _)| t.clone()).collect();
        for t in tokens {
            if let Some(e) = routes.remove(&t) {
                for task in e.tasks {
                    task.abort();
                }
                if let Some(ssh) = &e.route.ssh {
                    ssh.close();
                }
            }
        }
    }

    pub fn close_all(&self) {
        let tabs: Vec<String> = self.routes.lock().values().map(|e| e.tab_id.clone()).collect();
        for t in tabs {
            self.close(&t);
        }
        if let Ok(mut s) = self.server.try_lock() {
            if let Some((_, task)) = s.take() {
                task.abort();
            }
        }
    }
}

// ---- RDP ------------------------------------------------------------------------------

pub struct RdpTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub domain: String,
    pub rdp: Value,
}

/// Contents of a .rdp file for the given target and options.
pub fn rdp_file(t: &RdpTarget) -> String {
    let full = bool_at(&t.rdp, &["fullscreen"]);
    let mut lines = vec![format!("full address:s:{}:{}", t.host, t.port)];
    if !t.username.is_empty() {
        lines.push(format!("username:s:{}", if t.domain.is_empty() { t.username.clone() } else { format!("{}\\{}", t.domain, t.username) }));
    }
    lines.push(format!("screen mode id:i:{}", if full { 2 } else { 1 }));
    if !full {
        lines.push(format!("desktopwidth:i:{}", num_at(&t.rdp, &["width"], 1600.0) as u32));
        lines.push(format!("desktopheight:i:{}", num_at(&t.rdp, &["height"], 1000.0) as u32));
    }
    lines.push(format!("use multimon:i:{}", if bool_at(&t.rdp, &["multimon"]) { 1 } else { 0 }));
    lines.push(format!("administrative session:i:{}", if bool_at(&t.rdp, &["admin"]) { 1 } else { 0 }));
    for l in ["session bpp:i:32", "dynamic resolution:i:1", "redirectclipboard:i:1", "prompt for credentials:i:0", "authentication level:i:2"] {
        lines.push(l.into());
    }
    lines.join("\r\n") + "\r\n"
}

/// xfreerdp arguments. The password, if any, is sent on stdin (/from-stdin), never on the
/// command line.
pub fn freerdp_args(t: &RdpTarget, has_password: bool) -> Vec<String> {
    let mut args = vec![format!("/v:{}:{}", t.host, t.port), "/cert:tofu".into(), "+clipboard".into(), "/dynamic-resolution".into()];
    if !t.username.is_empty() {
        args.push(format!("/u:{}", t.username));
    }
    if !t.domain.is_empty() {
        args.push(format!("/d:{}", t.domain));
    }
    if bool_at(&t.rdp, &["fullscreen"]) {
        args.push("/f".into());
    } else {
        args.push(format!("/size:{}x{}", num_at(&t.rdp, &["width"], 1600.0) as u32, num_at(&t.rdp, &["height"], 1000.0) as u32));
    }
    if bool_at(&t.rdp, &["multimon"]) {
        args.push("/multimon".into());
    }
    if bool_at(&t.rdp, &["admin"]) {
        args.push("/admin".into());
    }
    if has_password {
        args.push("/from-stdin".into());
    }
    args
}

fn which(cmd: &str) -> Option<String> {
    let out = std::process::Command::new(if cfg!(windows) { "where" } else { "which" }).arg(cmd).stderr(std::process::Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

#[derive(Debug, PartialEq)]
pub enum RdpClient {
    MacApp { app: String, name: String },
    Mstsc,
    FreeRdp { cmd: String, name: String },
    Remmina { cmd: String },
}

impl RdpClient {
    fn name(&self) -> String {
        match self {
            RdpClient::MacApp { name, .. } | RdpClient::FreeRdp { name, .. } => name.clone(),
            RdpClient::Mstsc => "Remote Desktop Connection (mstsc)".into(),
            RdpClient::Remmina { .. } => "Remmina".into(),
        }
    }
}

/// Find the platform's RDP client.
pub fn find_rdp_client() -> Option<RdpClient> {
    if cfg!(target_os = "macos") {
        for app in ["/Applications/Windows App.app", "/Applications/Microsoft Remote Desktop.app"] {
            if Path::new(app).exists() {
                let name = Path::new(app).file_stem().unwrap().to_string_lossy().into_owned();
                return Some(RdpClient::MacApp { app: app.into(), name });
            }
        }
        return None;
    }
    if cfg!(windows) {
        return Some(RdpClient::Mstsc);
    }
    for c in ["xfreerdp3", "xfreerdp", "wlfreerdp"] {
        if let Some(p) = which(c) {
            return Some(RdpClient::FreeRdp { cmd: p, name: c.into() });
        }
    }
    which("remmina").map(|cmd| RdpClient::Remmina { cmd })
}

struct RdpEntry {
    listener: Option<tokio::task::JoinHandle<()>>,
    route: Option<Arc<Route>>,
    child: Option<Arc<Mutex<Option<std::process::Child>>>>,
    file: Option<PathBuf>,
}

pub struct RdpService {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    sessions: Mutex<HashMap<String, RdpEntry>>,
    dir: PathBuf,
}

impl RdpService {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>) -> Arc<RdpService> {
        Arc::new(RdpService { bus, store, sessions: Default::default(), dir: std::env::temp_dir().join("TermCraft-rdp") })
    }

    /// Open the tunnel (if any) and launch the RDP client.
    pub async fn launch(self: &Arc<Self>, tab_id: &str, session_ref: &Value) -> Result<Value> {
        self.close(tab_id);
        let session = self.store.lock().resolve_session(session_ref)?;
        if str_at(&session, &["protocol"]) != "rdp" {
            bail!("Not an RDP session");
        }
        let custom = str_at(self.store.lock().settings(), &["rdpClient"]).trim().to_string();
        let client = if custom.is_empty() {
            Some(find_rdp_client().ok_or_else(|| {
                anyhow!(if cfg!(target_os = "macos") {
                    "No RDP client found. Install \"Windows App\" from the Mac App Store (it replaces Microsoft Remote Desktop), or set a custom RDP client in Settings."
                } else if cfg!(target_os = "linux") {
                    "No RDP client found. Install FreeRDP (e.g. \"sudo apt install freerdp3-x11\" or \"freerdp2-x11\") or Remmina, or set a custom RDP client in Settings."
                } else {
                    "No RDP client found. Set a custom RDP client in Settings."
                })
            })?)
        } else {
            None
        };
        let mut entry = RdpEntry { listener: None, route: None, child: None, file: None };
        let remote_port = num_at(&session, &["port"], 3389.0) as u16; // the RDP host's port (never reassigned)
        let mut host = str_at(&session, &["host"]);
        let mut port = remote_port; // what the client connects to: the host, or the local end of the tunnel
        let mut via = String::new();
        let mut local_port = Value::Null;
        if !str_at(&session, &["tunnel", "sshSessionId"]).is_empty() {
            // Local listener → SSH → RDP host. The client connects to 127.0.0.1:<local port>.
            let route = Arc::new(open_route(&self.store, &session, prompt_ctx(&self.bus, &self.store, tab_id)).await?);
            via = route.via.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            port = listener.local_addr()?.port();
            local_port = json!(port);
            let r = route.clone();
            let target = str_at(&session, &["host"]);
            let bus = self.bus.clone();
            let tid = tab_id.to_string();
            entry.listener = Some(tokio::spawn(async move {
                while let Ok((mut sock, _)) = listener.accept().await {
                    let r = r.clone();
                    let target = target.clone();
                    let bus = bus.clone();
                    let tid = tid.clone();
                    tokio::spawn(async move {
                        match r.dial(&target, remote_port).await {
                            Ok(mut remote) => {
                                let _ = tokio::io::copy_bidirectional(&mut sock, &mut remote).await;
                            }
                            Err(e) => bus.send("remote:status", vec![json!(tid), json!({ "error": format!("Tunnel to {target}:{remote_port} failed: {e}") })]),
                        }
                    });
                }
            }));
            entry.route = Some(route);
            host = "127.0.0.1".into();
        }
        let target = RdpTarget {
            host: host.clone(),
            port,
            username: str_at(&session, &["username"]),
            domain: str_at(&session, &["rdp", "domain"]),
            rdp: at(&session, &["rdp"]).clone(),
        };
        let password = str_at(&session, &["auth", "password"]);
        mkdir_private(&self.dir)?;
        let file = self.dir.join(format!("{}.rdp", tab_id.replace(['/', '\\', ':'], "_")));
        write_mode(&file, rdp_file(&target).as_bytes(), 0o600)?;
        entry.file = Some(file.clone());
        let file_s = file.to_string_lossy().into_owned();

        let mut note = String::new();
        let name = client.as_ref().map(|c| c.name()).unwrap_or_else(|| "custom command".into());
        let spawn_res: Result<Option<std::process::Child>> = (|| {
            use std::process::{Command, Stdio};
            Ok(match &client {
                None => {
                    // No shell: the template is split into argv first, so host/user values can't
                    // inject commands.
                    let mut vals = HashMap::new();
                    vals.insert("file", file_s.clone());
                    vals.insert("host", host.clone());
                    vals.insert("port", port.to_string());
                    vals.insert("user", str_at(&session, &["username"]));
                    let argv = build_argv(&custom, &vals)?;
                    if argv.is_empty() {
                        bail!("The custom RDP client command is empty");
                    }
                    crate::launcher::spawn_detached(&argv[0], &argv[1..])?;
                    None
                }
                Some(RdpClient::MacApp { app, name }) => {
                    note = format!("{name} will ask for the password (it does not accept one from other apps) and can save it in your keychain.");
                    Some(Command::new("open").args(["-a", app, &file_s]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?)
                }
                Some(RdpClient::Mstsc) => {
                    note = "Remote Desktop Connection will ask for the password and can remember it.".into();
                    crate::launcher::spawn_detached("mstsc.exe", std::slice::from_ref(&file_s))?;
                    None
                }
                Some(RdpClient::FreeRdp { cmd, .. }) => {
                    let mut child = Command::new(cmd)
                        .args(freerdp_args(&target, !password.is_empty()))
                        .stdin(Stdio::piped())
                        .stdout(Stdio::null())
                        .stderr(Stdio::piped())
                        .spawn()?;
                    if let Some(mut stdin) = child.stdin.take() {
                        use std::io::Write;
                        if !password.is_empty() {
                            let _ = writeln!(stdin, "{password}");
                        }
                    }
                    Some(child)
                }
                Some(RdpClient::Remmina { cmd }) => {
                    crate::launcher::spawn_detached(cmd, &["-c".to_string(), file_s.clone()])?;
                    None
                }
            })
        })();
        let child = match spawn_res {
            Ok(c) => c,
            Err(e) => {
                self.bus.send("remote:status", vec![json!(tab_id), json!({ "error": format!("Could not start {name}: {e}") })]);
                None
            }
        };
        if let Some(mut child) = child {
            let stderr = child.stderr.take();
            let shared = Arc::new(Mutex::new(Some(child)));
            entry.child = Some(shared.clone());
            if matches!(client, Some(RdpClient::FreeRdp { .. })) {
                let bus = self.bus.clone();
                let tid = tab_id.to_string();
                std::thread::spawn(move || {
                    let mut err_text = String::new();
                    if let Some(mut e) = stderr {
                        use std::io::Read;
                        let _ = e.read_to_string(&mut err_text);
                    }
                    let code = shared.lock().as_mut().and_then(|c| c.wait().ok()).and_then(|s| s.code());
                    let last = if code.unwrap_or(0) != 0 { err_text.trim().lines().last().unwrap_or("").to_string() } else { String::new() };
                    bus.send("remote:status", vec![json!(tid), json!({ "exited": true, "code": code, "error": last })]);
                });
            }
        }
        self.sessions.lock().insert(tab_id.to_string(), entry);
        Ok(
            json!({ "client": name, "host": session["host"], "port": remote_port, "localPort": local_port, "via": via, "username": str_at(&session, &["username"]), "note": note }),
        )
    }

    pub fn close(&self, tab_id: &str) {
        let Some(e) = self.sessions.lock().remove(tab_id) else { return };
        if let Some(l) = e.listener {
            l.abort();
        }
        if let Some(r) = e.route.and_then(|r| r.ssh.clone()) {
            r.close();
        }
        if cfg!(target_os = "linux") {
            if let Some(c) = e.child.and_then(|c| c.lock().take()) {
                let mut c = c;
                let _ = c.kill();
            }
        }
        if let Some(f) = e.file {
            let _ = std::fs::remove_file(f);
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> RdpTarget {
        RdpTarget { host: "win".into(), port: 3389, username: "admin".into(), domain: "CORP".into(), rdp: json!({ "width": 1280, "height": 720 }) }
    }

    #[test]
    fn rdp_file_and_freerdp_args() {
        let f = rdp_file(&target());
        assert!(f.contains("full address:s:win:3389\r\n"));
        assert!(f.contains("username:s:CORP\\admin\r\n"));
        assert!(f.contains("desktopwidth:i:1280"));
        let a = freerdp_args(&target(), true);
        assert!(a.contains(&"/from-stdin".to_string()) && a.contains(&"/size:1280x720".to_string()));
        assert!(!a.iter().any(|x| x.contains("secret")));
        let mut t = target();
        t.rdp = json!({ "fullscreen": true });
        assert!(!rdp_file(&t).contains("desktopwidth"));
        assert!(freerdp_args(&t, false).contains(&"/f".to_string()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn custom_client_gets_values_as_single_arguments() {
        let dir = crate::store::tests::tmp("rdp");
        let pwned = dir.join("PWNED");
        let out = dir.join("argv.txt");
        let recorder = dir.join("record.sh");
        std::fs::write(&recorder, "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$OUT\"\n").unwrap();
        // SAFETY-free: set the output path through the environment for the recorder.
        let store = Arc::new(Mutex::new(Store::new(&dir.join("data"), None).unwrap()));
        let p = pwned.display();
        store
            .lock()
            .save_settings(&json!({ "rdpClient": format!("/usr/bin/env OUT={} /bin/sh \"{}\" {{host}} {{user}}", out.display(), recorder.display()) }))
            .unwrap();
        let hostile_user = format!("x; touch {p}; echo $(touch {p})`touch {p}`");
        let sess = store
            .lock()
            .save_session(&json!({ "name": "w", "protocol": "rdp", "host": format!("win;touch {p}"), "port": 3389, "username": hostile_user }))
            .unwrap();
        let (bus, _) = Bus::fake(|_, _| Value::Null);
        let rdp = RdpService::new(bus, store);
        rdp.launch("t1", &sess["id"]).await.unwrap();
        for _ in 0..100 {
            if out.exists() && std::fs::read_to_string(&out).unwrap().lines().count() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        let lines: Vec<String> = std::fs::read_to_string(&out).unwrap().lines().map(String::from).collect();
        assert_eq!(lines, vec![format!("win;touch {p}"), hostile_user], "values passed verbatim as single arguments");
        assert!(!pwned.exists(), "no shell command was executed");
        rdp.close_all();
    }

    #[tokio::test]
    async fn vnc_bridge_pipes_websocket_to_tcp() {
        // A fake VNC server that echoes.
        let vnc = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let vport = vnc.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = vnc.accept().await.unwrap();
            s.write_all(b"RFB 003.008\n").await.unwrap();
            let mut buf = [0u8; 64];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(&buf[..n]).await.unwrap();
        });
        let store = Arc::new(Mutex::new(Store::new(&crate::store::tests::tmp("vnc"), None).unwrap()));
        let sess =
            store.lock().save_session(&json!({ "name": "v", "protocol": "vnc", "host": "127.0.0.1", "port": vport, "auth": { "password": "pw" } })).unwrap();
        let (bus, _) = Bus::fake(|_, _| Value::Null);
        let bridge = VncBridge::new(bus, store);
        let info = bridge.open("t", &sess["id"]).await.unwrap();
        assert_eq!(info["password"], "pw");
        let url = info["url"].as_str().unwrap().to_string();
        // A wrong token is refused.
        let bad = url.rsplit_once('/').unwrap().0.to_string() + "/nope";
        let (mut ws_bad, _) = tokio_tungstenite::connect_async(bad).await.unwrap();
        assert!(matches!(ws_bad.next().await, Some(Ok(Message::Close(_))) | None));
        let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url).unwrap();
        req.headers_mut().insert("sec-websocket-protocol", "binary".parse().unwrap());
        let (mut ws, resp) = tokio_tungstenite::connect_async(req).await.unwrap();
        assert_eq!(resp.headers().get("sec-websocket-protocol").unwrap(), "binary");
        let Some(Ok(Message::Binary(hello))) = ws.next().await else { panic!("no hello") };
        assert_eq!(&hello[..], b"RFB 003.008\n");
        ws.send(Message::Binary(b"ping".to_vec().into())).await.unwrap();
        let Some(Ok(Message::Binary(echo))) = ws.next().await else { panic!("no echo") };
        assert_eq!(&echo[..], b"ping");
        bridge.close_all();
    }
}
