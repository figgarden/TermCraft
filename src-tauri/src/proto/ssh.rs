// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! SSH2 client: authentication (agent, key file, keyboard-interactive, password), host key
//! checks against TermCraft's known hosts, jump hosts, local/remote/dynamic port forwarding,
//! X11 and agent forwarding, shells, exec channels (SCP), SFTP and tunnels (VNC/RDP).

use super::{Conn, Ctl, Ctx, Event, EventTx};
use crate::json::{arr, at, bool_at, num_at, str_at, string, truthy};
use crate::scp::ExecStream;
use crate::util::{expand_tilde, host_key_info};
use anyhow::{Result, anyhow, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelStream, MethodKind, Sig};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Shell,
    Sftp,
    Tunnel,
}

const AUTH_FAILED: &str = "All configured authentication methods failed";

fn default_agent() -> String {
    if cfg!(windows) {
        // Prefer the Windows OpenSSH agent pipe.
        return std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".into());
    }
    std::env::var("SSH_AUTH_SOCK").unwrap_or_default()
}

fn agent_path(session: &Value) -> String {
    if at(session, &["auth", "useAgent"]) == false { String::new() } else { default_agent() }
}

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

async fn connect_agent(path: &str) -> Result<Box<dyn Duplex>> {
    #[cfg(unix)]
    {
        Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
    }
    #[cfg(windows)]
    {
        Ok(Box::new(tokio::net::windows::named_pipe::ClientOptions::new().open(path)?))
    }
}

async fn connect_x11() -> Result<Box<dyn Duplex>> {
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    #[cfg(unix)]
    if display.starts_with('/') {
        return Ok(Box::new(tokio::net::UnixStream::connect(&display).await?)); // XQuartz launchd socket
    }
    let re = regex::Regex::new(r"^(.*?):(\d+)(?:\.\d+)?$").unwrap();
    let (host, n) = match re.captures(&display) {
        Some(m) => (m[1].to_string(), m[2].parse::<u16>().unwrap_or(0)),
        None => (String::new(), 0),
    };
    #[cfg(unix)]
    if host.is_empty() || host == "unix" {
        return Ok(Box::new(tokio::net::UnixStream::connect(format!("/tmp/.X11-unix/X{n}")).await?));
    }
    let host = if host.is_empty() { "127.0.0.1".to_string() } else { host };
    Ok(Box::new(TcpStream::connect((host.as_str(), 6000 + n)).await?))
}

/// Ask the user; tracks that a prompt is open (the ready timeout pauses meanwhile).
#[derive(Clone)]
struct Asker {
    ctx: Ctx,
    prompting: Arc<AtomicBool>,
}

impl Asker {
    async fn raw(&self, req: Value) -> Value {
        self.prompting.store(true, Ordering::SeqCst);
        let r = (self.ctx.prompt)(req).await;
        self.prompting.store(false, Ordering::SeqCst);
        r
    }

    /// Only password prompts (offer_save) show the "Save login" checkbox. Returns (value, save),
    /// or None on cancel. Accepts plain-string answers too (scripts, tests).
    async fn ask(&self, mut req: Value, offer_save: bool) -> Option<(String, bool)> {
        if offer_save {
            req["offerSave"] = json!(true);
        }
        match self.raw(req).await {
            Value::Null => None,
            Value::Object(o) => Some((o.get("value").map(string).unwrap_or_default(), o.get("save").is_some_and(truthy))),
            v => Some((string(&v), false)),
        }
    }
}

/// russh event handler for one connection.
pub struct Client {
    host_port: String,
    asker: Asker,
    ev: EventTx,
    remote_forwards: Arc<Mutex<Vec<(u32, String, u16)>>>,
    agent_path: String,
    closed: watch::Sender<bool>,
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.closed.send(true);
    }
}

async fn pipe<A: AsyncRead + AsyncWrite + Unpin, B: AsyncRead + AsyncWrite + Unpin>(mut a: A, mut b: B) {
    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        let text = banner.replace("\r\n", "\n").replace('\n', "\r\n");
        let _ = self.ev.send(Event::Data(text.into_bytes()));
        Ok(())
    }

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let blob = key.public_key().to_bytes().map_err(|_| russh::Error::WrongServerSig)?;
        let info = host_key_info(&blob);
        let known = self.asker.ctx.store.lock().known_host(&self.host_port).cloned();
        if let Some(k) = &known {
            if k["fingerprint"] == info["fingerprint"] {
                return Ok(true);
            }
        }
        let answer = self
            .asker
            .raw(json!({
                "kind": "hostkey",
                "changed": known.is_some(),
                "host": self.host_port,
                "keyType": info["type"],
                "fingerprint": info["fingerprint"],
                "md5": info["md5"],
                "oldFingerprint": known.as_ref().map(|k| k["fingerprint"].clone()),
            }))
            .await;
        if answer == "save" {
            let _ = self.asker.ctx.store.lock().set_known_host(&self.host_port, &info);
            return Ok(true);
        }
        Ok(answer == "once")
    }

    async fn kex_done(&mut self, _secret: Option<&[u8]>, names: &russh::Names, _session: &mut client::Session) -> Result<(), Self::Error> {
        let compress: &str = match names.client_compression {
            russh::compression::Compression::None => "none",
            russh::compression::Compression::Zlib => "zlib",
            russh::compression::Compression::ZlibOpenSSH => "zlib@openssh.com",
        };
        let _ = self.ev.send(Event::Status(json!({
            "cipher": names.cipher.as_ref(),
            "mac": names.client_mac.as_ref(),
            "kex": names.kex.as_ref(),
            "hostKey": names.key.to_string(),
            "compress": compress,
        })));
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let f = self.remote_forwards.lock().iter().find(|(p, ..)| *p == connected_port).cloned();
        tokio::spawn(async move {
            let Some((_, host, port)) = f else {
                return reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            };
            let host = if host.is_empty() { "127.0.0.1".to_string() } else { host };
            match TcpStream::connect((host.as_str(), port)).await {
                Ok(sock) => {
                    reply.accept().await;
                    pipe(channel.into_stream(), sock).await;
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<Msg>,
        _addr: &str,
        _port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        tokio::spawn(async move {
            match connect_x11().await {
                Ok(local) => {
                    reply.accept().await;
                    pipe(channel.into_stream(), local).await;
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let path = self.agent_path.clone();
        tokio::spawn(async move {
            match connect_agent(&path).await {
                Ok(agent) if !path.is_empty() => {
                    reply.accept().await;
                    pipe(channel.into_stream(), agent).await;
                }
                _ => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }
}

/// An authenticated SSH connection.
pub struct SshClient {
    pub handle: Arc<Handle<Client>>,
    pub username: String,
    jump: Option<Arc<SshClient>>,
    closed: watch::Receiver<bool>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    remote_forwards: Arc<Mutex<Vec<(u32, String, u16)>>>,
}

impl SshClient {
    /// Run a remote command on a new exec channel (SCP, key install).
    pub async fn exec(&self, command: &str) -> Result<ExecStream> {
        let ch = self.handle.channel_open_session().await?;
        ch.exec(true, command).await?;
        let (mut read, write) = ch.split();
        let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
        let stderr: Arc<Mutex<String>> = Default::default();
        let err = stderr.clone();
        tokio::spawn(async move {
            while let Some(msg) = read.wait().await {
                match msg {
                    ChannelMsg::Data { data } => {
                        if tx.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => err.lock().push_str(&String::from_utf8_lossy(&data)),
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        });
        Ok(ExecStream { rx, stderr, writer: Box::new(ExecWriter { inner: Box::pin(write.make_writer()), half: Some(write) }) })
    }

    /// Open the SFTP subsystem.
    pub async fn sftp(&self) -> Result<russh_sftp::client::SftpSession> {
        let ch = self.handle.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        Ok(russh_sftp::client::SftpSession::new(ch.into_stream()).await?)
    }

    /// A TCP connection from the server to host:port.
    pub async fn direct_tcpip(&self, host: &str, port: u16) -> Result<ChannelStream<Msg>> {
        let ch = self.handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await?;
        Ok(ch.into_stream())
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow() || self.handle.is_closed()
    }

    /// Resolves when the connection ends.
    pub async fn wait_closed(&self) {
        let mut rx = self.closed.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    pub fn close(&self) {
        for t in self.tasks.lock().drain(..) {
            t.abort();
        }
        let h = self.handle.clone();
        tokio::spawn(async move {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        });
        if let Some(j) = &self.jump {
            j.close();
        }
    }

    fn start_forwards(self: &Arc<Self>, session: &Value, ev: &EventTx) {
        for f in arr(&session["forwards"]) {
            if f["enabled"] == false {
                continue;
            }
            match str_at(f, &["type"]).as_str() {
                "L" | "D" => self.listen_local(f, ev),
                "R" => self.listen_remote(f, ev),
                _ => {}
            }
        }
    }

    fn listen_local(self: &Arc<Self>, f: &Value, ev: &EventTx) {
        let bind_host = Some(str_at(f, &["bindHost"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
        let bind_port = num_at(f, &["bindPort"], 0.0) as u16;
        let dynamic = f["type"] == "D";
        let dest_host = str_at(f, &["destHost"]);
        let dest_port = num_at(f, &["destPort"], 0.0) as u16;
        let me = Arc::downgrade(self);
        let ev = ev.clone();
        let task = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind((bind_host.as_str(), bind_port)).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = ev.send(Event::Info(format!("Port forward {bind_host}:{bind_port}: {e}")));
                    return;
                }
            };
            let _ = ev.send(Event::Info(if dynamic {
                format!("Dynamic SOCKS forward listening on {bind_host}:{bind_port}")
            } else {
                format!("Local forward {bind_host}:{bind_port} -> {dest_host}:{dest_port}")
            }));
            while let Ok((sock, peer)) = listener.accept().await {
                let Some(client) = me.upgrade() else { break };
                let ev = ev.clone();
                let dest_host = dest_host.clone();
                tokio::spawn(async move {
                    if dynamic {
                        let h = client.handle.clone();
                        let r = super::socks::handle_socks_connection(sock, |host, port| async move {
                            Ok(h.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await?.into_stream())
                        })
                        .await;
                        if let Err(e) = r {
                            let _ = ev.send(Event::Info(format!("SOCKS: {e}")));
                        }
                    } else {
                        match client.handle.channel_open_direct_tcpip(dest_host.as_str(), dest_port as u32, peer.ip().to_string(), peer.port() as u32).await {
                            Ok(ch) => pipe(sock, ch.into_stream()).await,
                            Err(e) => {
                                let _ = ev.send(Event::Info(format!("Forward to {dest_host}:{dest_port} failed: {e}")));
                            }
                        }
                    }
                });
            }
        });
        self.tasks.lock().push(task);
    }

    fn listen_remote(self: &Arc<Self>, f: &Value, ev: &EventTx) {
        let bind_host = Some(str_at(f, &["bindHost"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "localhost".into());
        let bind_port = num_at(f, &["bindPort"], 0.0) as u32;
        let dest_host = str_at(f, &["destHost"]);
        let dest_port = num_at(f, &["destPort"], 0.0) as u16;
        let h = self.handle.clone();
        let forwards = self.remote_forwards.clone();
        let ev = ev.clone();
        tokio::spawn(async move {
            match h.tcpip_forward(bind_host.as_str(), bind_port).await {
                Ok(port) => {
                    let bound = if port == 0 { bind_port } else { port };
                    forwards.lock().push((bound, dest_host.clone(), dest_port));
                    let _ = ev.send(Event::Info(format!("Remote forward {bind_host}:{bound} -> {dest_host}:{dest_port}")));
                }
                Err(e) => {
                    let _ = ev.send(Event::Info(format!("Remote forward {bind_host}:{bind_port} failed: {e}")));
                }
            }
        });
    }
}

/// Writes go to the channel; dropping it (or shutdown) sends EOF so the remote command finishes.
struct ExecWriter {
    inner: std::pin::Pin<Box<dyn AsyncWrite + Send>>,
    half: Option<russh::ChannelWriteHalf<Msg>>,
}

impl AsyncWrite for ExecWriter {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        self.inner.as_mut().poll_write(cx, buf)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_flush(cx)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        let r = self.inner.as_mut().poll_shutdown(cx);
        if r.is_ready() {
            if let Some(half) = self.half.take() {
                tokio::spawn(async move {
                    let _ = half.eof().await;
                    let _ = half.close().await;
                });
            }
        }
        r
    }
}

impl Drop for ExecWriter {
    fn drop(&mut self) {
        if let Some(half) = self.half.take() {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    let _ = half.eof().await;
                    let _ = half.close().await;
                });
            }
        }
    }
}

/// Run `fut`, failing after `secs` seconds — not counting time spent waiting for the user.
async fn ready_timeout<T>(fut: impl std::future::Future<Output = Result<T>>, secs: f64, prompting: &AtomicBool) -> Result<T> {
    tokio::pin!(fut);
    let step = Duration::from_millis(250);
    let mut left = Duration::from_secs_f64(secs.max(1.0));
    loop {
        tokio::select! {
            r = &mut fut => return r,
            _ = tokio::time::sleep(step) => {
                if !prompting.load(Ordering::SeqCst) {
                    if left <= step { bail!("Timed out while waiting for handshake") }
                    left -= step;
                }
            }
        }
    }
}

/// Connect and authenticate. `ev` receives banners, status, info and saved-login events.
pub fn connect_client(session: Value, ctx: Ctx, ev: EventTx, mode: Mode) -> BoxFuture<'static, Result<Arc<SshClient>>> {
    Box::pin(async move {
        let prompting = Arc::new(AtomicBool::new(false));
        let asker = Asker { ctx: ctx.clone(), prompting: prompting.clone() };
        let secs = num_at(&session, &["ssh", "readyTimeout"], 20.0);
        let client = ready_timeout(connect_inner(session.clone(), ctx, ev.clone(), mode, asker), secs, &prompting).await?;
        if mode != Mode::Tunnel {
            client.start_forwards(&session, &ev);
        }
        Ok(client)
    })
}

async fn connect_inner(s: Value, ctx: Ctx, ev: EventTx, _mode: Mode, asker: Asker) -> Result<Arc<SshClient>> {
    let host = str_at(&s, &["host"]);
    let port = num_at(&s, &["port"], 22.0) as u16;
    let ssh = &s["ssh"];

    // Jump host: a saved session id, or an ad-hoc session object (e.g. user@host typed in the SCP
    // manager).
    let jump_ref = if truthy(&ssh["jumpSession"]) { ssh["jumpSession"].clone() } else { ssh["jumpSessionId"].clone() };
    let mut jump: Option<Arc<SshClient>> = None;
    let stream: Box<dyn Duplex> = if truthy(&jump_ref) {
        let mut jump_cfg = ctx.store.lock().resolve_session(&jump_ref)?;
        if truthy(&jump_cfg["id"]) && jump_cfg["id"] == s["id"] {
            bail!("A session cannot use itself as its jump host");
        }
        jump_cfg["forwards"] = json!([]);
        let _ = ev.send(Event::Info(format!("Connecting to jump host {}:{}...", str_at(&jump_cfg, &["host"]), num_at(&jump_cfg, &["port"], 22.0))));
        // `target` says whose login this is, so it is saved on the jump host, not on this session.
        let target = if truthy(&jump_cfg["id"]) { jump_cfg["id"].clone() } else { jump_ref.clone() };
        let (jtx, mut jrx) = mpsc::unbounded_channel();
        let fwd = ev.clone();
        tokio::spawn(async move {
            while let Some(e) = jrx.recv().await {
                match e {
                    Event::Info(m) => {
                        let _ = fwd.send(Event::Info(format!("[jump] {m}")));
                    }
                    Event::Credentials(mut c) => {
                        if !truthy(&c["target"]) {
                            c["target"] = target.clone();
                        }
                        let _ = fwd.send(Event::Credentials(c));
                    }
                    _ => {}
                }
            }
        });
        let j = Box::pin(connect_inner(jump_cfg.clone(), ctx.clone(), jtx, Mode::Tunnel, asker.clone())).await?;
        let st = j.direct_tcpip(&host, port).await.map_err(|e| anyhow!("Jump host could not reach {host}:{port}: {e}"))?;
        let _ = ev.send(Event::Info(format!("Tunnel through {} established", str_at(&jump_cfg, &["host"]))));
        jump = Some(j);
        Box::new(st)
    } else {
        let sock = TcpStream::connect((host.as_str(), port)).await?;
        sock.set_nodelay(true)?;
        Box::new(sock)
    };
    let fail = |e: anyhow::Error, jump: &Option<Arc<SshClient>>| {
        if let Some(j) = jump {
            j.close();
        }
        e
    };

    let mut username = str_at(&s, &["username"]);
    if username.is_empty() {
        match asker.ask(json!({ "kind": "text", "title": "Username", "message": format!("Username for {host}:") }), false).await {
            Some((u, _)) => username = u,
            None => return Err(fail(anyhow!("Authentication cancelled"), &jump)),
        }
    }

    let mut config = client::Config::default();
    let keepalive = num_at(&s, &["ssh", "keepAlive"], 0.0);
    if keepalive > 0.0 {
        config.keepalive_interval = Some(Duration::from_secs_f64(keepalive));
        config.keepalive_max = 3;
    }
    config.nodelay = true;
    config.preferred = russh::Preferred {
        compression: if bool_at(&s, &["ssh", "compression"]) {
            std::borrow::Cow::Owned(vec![russh::compression::ZLIB_LEGACY, russh::compression::ZLIB, russh::compression::NONE])
        } else {
            std::borrow::Cow::Owned(vec![russh::compression::NONE])
        },
        ..Default::default()
    };

    let (closed_tx, closed_rx) = watch::channel(false);
    let remote_forwards: Arc<Mutex<Vec<(u32, String, u16)>>> = Default::default();
    let agent = agent_path(&s);
    let handler = Client {
        host_port: format!("{host}:{port}"),
        asker: asker.clone(),
        ev: ev.clone(),
        remote_forwards: remote_forwards.clone(),
        agent_path: if bool_at(&s, &["ssh", "agentForward"]) { agent.clone() } else { String::new() },
        closed: closed_tx,
    };
    let mut handle = client::connect_stream(Arc::new(config), stream, handler).await.map_err(|e| fail(handshake_error(e), &jump))?;

    let to_save = authenticate(&mut handle, &s, &username, &agent, &asker, &ev).await.map_err(|e| fail(e, &jump))?;
    // A login is saved as a unit: the password together with the username it belongs to.
    if let Some(password) = to_save {
        let _ = ev.send(Event::Credentials(json!({ "username": username, "password": password })));
    }
    Ok(Arc::new(SshClient { handle: Arc::new(handle), username, jump, closed: closed_rx, tasks: Mutex::new(Vec::new()), remote_forwards }))
}

fn handshake_error(e: russh::Error) -> anyhow::Error {
    match e {
        russh::Error::UnknownKey => anyhow!("Host key verification failed"),
        e => anyhow!("{e}"),
    }
}

/// Try the configured methods in order. Returns a password the user asked to save.
async fn authenticate(handle: &mut Handle<Client>, s: &Value, username: &str, agent: &str, asker: &Asker, ev: &EventTx) -> Result<Option<String>> {
    let info = |msg: String| {
        let _ = ev.send(Event::Info(msg));
    };
    let host = str_at(s, &["host"]);
    let methods: Vec<String> = arr(at(s, &["auth", "methods"])).iter().map(string).filter(|m| !m.is_empty()).collect();
    let order = if methods.is_empty() { vec!["publickey".to_string(), "keyboard-interactive".into(), "password".into()] } else { methods };
    let mut queue: std::collections::VecDeque<String> = Default::default();
    if !agent.is_empty() && order.iter().any(|m| m == "publickey") {
        queue.push_back("agent".into());
    }
    queue.extend(order);
    let mut remaining: Option<Vec<MethodKind>> = None;
    let mut password_attempts = 0;
    let mut kbd_attempts = 0;
    let mut known_password = str_at(s, &["auth", "password"]);
    let mut to_save: Option<String> = None;
    let rsa_hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();

    let note = |r: AuthResult, remaining: &mut Option<Vec<MethodKind>>| -> bool {
        match r {
            AuthResult::Success => true,
            AuthResult::Failure { remaining_methods, .. } => {
                *remaining = Some(remaining_methods.to_vec());
                false
            }
        }
    };

    while let Some(m) = queue.pop_front() {
        let wire = match m.as_str() {
            "agent" | "publickey" => MethodKind::PublicKey,
            "keyboard-interactive" => MethodKind::KeyboardInteractive,
            "password" => MethodKind::Password,
            "none" => MethodKind::None,
            _ => continue,
        };
        if remaining.as_ref().is_some_and(|r| !r.contains(&wire)) {
            continue;
        }
        match m.as_str() {
            "agent" => {
                let Ok(stream) = connect_agent(agent).await else { continue };
                let mut client = russh::keys::agent::client::AgentClient::connect(stream);
                let Ok(ids) = client.request_identities().await else { continue };
                for id in ids {
                    let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id else { continue };
                    if remaining.as_ref().is_some_and(|r| !r.contains(&MethodKind::PublicKey)) {
                        break;
                    }
                    if let Ok(r) = handle.authenticate_publickey_with(username, key, rsa_hash, &mut client).await {
                        if note(r, &mut remaining) {
                            return Ok(to_save);
                        }
                    }
                }
            }
            "publickey" => {
                let key_file = str_at(s, &["auth", "keyFile"]);
                if key_file.is_empty() {
                    continue;
                }
                let key_path = expand_tilde(&key_file);
                let text = match std::fs::read_to_string(&key_path) {
                    Ok(t) => t,
                    Err(e) => {
                        info(format!("Cannot read key {key_path}: {e}"));
                        continue;
                    }
                };
                let mut passphrase = Some(str_at(s, &["auth", "passphrase"])).filter(|p| !p.is_empty());
                let mut parsed = russh::keys::decode_secret_key(&text, passphrase.as_deref());
                let mut tries = 0;
                while parsed.is_err() && tries < 3 && needs_passphrase(parsed.as_ref().err().unwrap(), passphrase.is_some()) {
                    let Some((p, _)) =
                        asker.ask(json!({ "kind": "password", "title": "Key Passphrase", "message": format!("Passphrase for {key_path}:") }), false).await
                    else {
                        break;
                    };
                    passphrase = Some(p);
                    parsed = russh::keys::decode_secret_key(&text, passphrase.as_deref());
                    tries += 1;
                }
                let key = match parsed {
                    Ok(k) => k,
                    Err(e) => {
                        info(format!("Key {key_path}: {e}"));
                        continue;
                    }
                };
                let r = handle.authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash)).await?;
                if note(r, &mut remaining) {
                    return Ok(to_save);
                }
            }
            "keyboard-interactive" => {
                if kbd_attempts >= 3 {
                    continue;
                }
                kbd_attempts += 1;
                let mut resp = handle.authenticate_keyboard_interactive_start(username, None::<String>).await?;
                loop {
                    match resp {
                        KeyboardInteractiveAuthResponse::Success => return Ok(to_save),
                        KeyboardInteractiveAuthResponse::Failure { remaining_methods, .. } => {
                            remaining = Some(remaining_methods.to_vec());
                            break;
                        }
                        KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                            // Auto-answer a lone password prompt with the saved password once.
                            let answers = if prompts.len() == 1 && !prompts[0].echo && !known_password.is_empty() && kbd_attempts == 1 {
                                vec![known_password.clone()]
                            } else if prompts.is_empty() {
                                vec![]
                            } else {
                                // A single hidden prompt is a password (macOS and many Linux servers
                                // use keyboard-interactive for passwords) and can be saved;
                                // multi-step MFA cannot.
                                let is_password = prompts.len() == 1 && !prompts[0].echo;
                                let res = asker
                                    .raw(json!({
                                        "kind": "kbdint",
                                        "title": if name.is_empty() { format!("Login to {host}") } else { name },
                                        "message": instructions,
                                        "prompts": prompts.iter().map(|p| json!({ "prompt": p.prompt, "echo": p.echo })).collect::<Vec<_>>(),
                                        "offerSave": is_password,
                                        "retry": is_password && kbd_attempts > 1,
                                    }))
                                    .await;
                                let answers = if res.is_array() { Some(res.clone()) } else { res.get("answers").filter(|a| a.is_array()).cloned() };
                                match answers {
                                    Some(a) => {
                                        let a: Vec<String> = arr(&a).iter().map(string).collect();
                                        if is_password {
                                            to_save = if res.get("save").is_some_and(truthy) { a.first().cloned() } else { None };
                                        }
                                        a
                                    }
                                    None => prompts.iter().map(|_| String::new()).collect(),
                                }
                            };
                            resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
                        }
                    }
                }
            }
            "password" => {
                if password_attempts >= 3 {
                    continue;
                }
                let mut password = if password_attempts == 0 { known_password.clone() } else { String::new() };
                if password.is_empty() {
                    let req = json!({ "kind": "password", "title": "Password", "message": format!("Password for {username}@{host}:"), "retry": password_attempts > 0 });
                    let Some((p, save)) = asker.ask(req, true).await else { bail!(AUTH_FAILED) };
                    password = p;
                    // The latest attempt wins, so only a password that actually works gets saved.
                    to_save = save.then(|| password.clone());
                }
                password_attempts += 1;
                known_password = password.clone();
                if password_attempts < 3 {
                    queue.push_front("password".into());
                }
                let r = handle.authenticate_password(username, password).await?;
                if note(r, &mut remaining) {
                    return Ok(to_save);
                }
            }
            "none" => {
                let r = handle.authenticate_none(username).await?;
                if note(r, &mut remaining) {
                    return Ok(to_save);
                }
            }
            _ => {}
        }
    }
    bail!(AUTH_FAILED)
}

fn needs_passphrase(e: &russh::keys::Error, had_passphrase: bool) -> bool {
    matches!(e, russh::keys::Error::KeyIsEncrypted) || (had_passphrase && e.to_string().to_lowercase().contains("crypt"))
}

/// Open an interactive shell (a terminal tab).
pub async fn open_shell(session: Value, ctx: Ctx, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    let client = connect_client(session.clone(), ctx, ev.clone(), Mode::Shell).await?;
    let ch = match open_shell_channel(&client, &session, cols, rows).await {
        Ok(ch) => ch,
        Err(e) => {
            client.close();
            return Err(e);
        }
    };
    let (mut read, write) = ch.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Ctl>();
    let username = client.username.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                m = read.wait() => match m {
                    Some(ChannelMsg::Data { data }) => { let _ = ev.send(Event::Data(data.to_vec())); }
                    Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = ev.send(Event::Data(data.to_vec())); }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                c = rx.recv() => match c {
                    Some(Ctl::Write(d)) => { if write.data_bytes(d).await.is_err() { break } }
                    Some(Ctl::Resize(c, r)) => { let _ = write.window_change(c as u32, r as u32, 0, 0).await; }
                    Some(Ctl::Break) => { let _ = write.signal(Sig::INT).await; }
                    Some(Ctl::Close) | None => { let _ = write.eof().await; let _ = write.close().await; break }
                },
                _ = client.wait_closed() => break,
            }
        }
        client.close();
        let _ = ev.send(Event::Close);
    });
    Ok(Conn::new(tx, username))
}

async fn open_shell_channel(client: &Arc<SshClient>, s: &Value, cols: u16, rows: u16) -> Result<russh::Channel<Msg>> {
    let ch = client.handle.channel_open_session().await?;
    if bool_at(s, &["ssh", "agentForward"]) && !agent_path(s).is_empty() {
        let _ = ch.agent_forward(false).await;
    }
    if bool_at(s, &["ssh", "x11"]) {
        let cookie = hex::encode(rand::random::<[u8; 16]>());
        let _ = ch.request_x11(false, false, "MIT-MAGIC-COOKIE-1", cookie, 0).await;
    }
    if let Some(env) = s["env"].as_object() {
        for (k, v) in env {
            let _ = ch.set_env(false, k.as_str(), string(v)).await;
        }
    }
    let term = Some(str_at(s, &["terminal", "termType"])).filter(|t| !t.is_empty()).unwrap_or_else(|| "xterm-256color".into());
    ch.request_pty(false, &term, cols as u32, rows as u32, 0, 0, &[]).await?;
    ch.request_shell(true).await?;
    Ok(ch)
}
