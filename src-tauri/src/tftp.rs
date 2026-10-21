// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! A small TFTP server (RFC 1350 with the RFC 2347/2348/2349 option extensions: blksize, tsize,
//! timeout) for copying IOS images and configs to and from network devices:
//!   copy tftp://<this computer>/c2960-image.bin flash:      copy running-config tftp://<this computer>/sw1.cfg
//! Files are served from one folder only. Uploads (device -> here) are off unless enabled, never
//! overwrite unless allowed, and are written to a temporary file that is renamed when complete.

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::watch;

const RRQ: u16 = 1;
const WRQ: u16 = 2;
const DATA: u16 = 3;
const ACK: u16 = 4;
const ERROR: u16 = 5;
const OACK: u16 = 6;
const ERR_NOT_DEFINED: u16 = 0;
const ERR_NOT_FOUND: u16 = 1;
const ERR_ACCESS: u16 = 2;
const ERR_DISK_FULL: u16 = 3;
const ERR_ILLEGAL: u16 = 4;
const ERR_UNKNOWN_TID: u16 = 5;
const ERR_EXISTS: u16 = 6;
const MAX_RETRIES: u32 = 5;

#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub port: u16,
    pub host: String,
    pub allow_write: bool,
    pub allow_overwrite: bool,
}

/// Events: ("transfer", {...}) and ("log", "message").
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

fn error_packet(code: u16, msg: &str) -> Vec<u8> {
    let mut b = Vec::with_capacity(5 + msg.len());
    b.extend_from_slice(&ERROR.to_be_bytes());
    b.extend_from_slice(&code.to_be_bytes());
    b.extend(msg.chars().take(200).map(|c| if c.is_ascii() { c as u8 } else { b'?' }));
    b.push(0);
    b
}

pub struct Request {
    pub filename: String,
    pub mode: String,
    pub options: BTreeMap<String, String>,
}

/// Parse RRQ/WRQ: filename, mode and options. None when malformed.
pub fn parse_request(buf: &[u8]) -> Option<Request> {
    let text: String = buf[2..].iter().map(|&b| b as char).collect();
    let parts: Vec<&str> = text.split('\0').collect();
    if parts.len() < 3 || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    let mut options = BTreeMap::new();
    let mut i = 2;
    while i + 1 < parts.len() {
        if !parts[i].is_empty() {
            options.insert(parts[i].to_lowercase(), parts[i + 1].to_string());
        }
        i += 2;
    }
    Some(Request { filename: parts[0].to_string(), mode: parts[1].to_lowercase(), options })
}

/// Resolve a requested name inside root. Rejects absolute paths, drive letters and "..".
pub fn resolve_in_root(root: &Path, name: &str) -> Option<PathBuf> {
    let clean = name.replace('\\', "/");
    let clean = clean.trim_start_matches('/');
    let b = clean.as_bytes();
    if clean.is_empty() || clean.split('/').any(|p| p == "..") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || clean.contains('\0') {
        return None;
    }
    let root_full = crate::util::resolve(root);
    let full = crate::util::resolve(root_full.join(clean));
    (full.starts_with(&root_full) && full != root_full).then_some(full)
}

pub struct TftpServer {
    pub opts: Options,
    pub port: u16,
    stop: watch::Sender<bool>,
}

impl TftpServer {
    pub async fn start(opts: Options, emit: Emit) -> Result<TftpServer> {
        let addr = format!("{}:{}", opts.host, opts.port);
        let sock = UdpSocket::bind(&addr).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => anyhow!(
                "Port {} needs administrator rights on this system. Use a port above 1023, or allow it (Linux: sudo setcap cap_net_bind_service=+ep on the app).",
                opts.port
            ),
            std::io::ErrorKind::AddrInUse => anyhow!("Port {} is already in use (another TFTP server?)", opts.port),
            _ => anyhow!(e),
        })?;
        let port = sock.local_addr()?.port();
        let (stop, stop_rx) = watch::channel(false);
        let seq = Arc::new(AtomicU64::new(0));
        let o = opts.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            let mut stop_rx2 = stop_rx.clone();
            loop {
                tokio::select! {
                    r = sock.recv_from(&mut buf) => match r {
                        Ok((n, peer)) => on_request(&sock, &buf[..n], peer, &o, &emit, &seq, stop_rx.clone()).await,
                        Err(e) => emit("log", json!(format!("Server error: {e}"))),
                    },
                    _ = stop_rx2.changed() => break,
                }
            }
        });
        Ok(TftpServer { opts, port, stop })
    }

    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
}

impl Drop for TftpServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn on_request(sock: &UdpSocket, msg: &[u8], peer: SocketAddr, opts: &Options, emit: &Emit, seq: &AtomicU64, stop: watch::Receiver<bool>) {
    if msg.len() < 4 {
        return;
    }
    let op = u16::from_be_bytes([msg[0], msg[1]]);
    if op != RRQ && op != WRQ {
        return; // stray packets to the listening port are ignored
    }
    let reply = |b: Vec<u8>| async move {
        let _ = sock.send_to(&b, peer).await;
    };
    let Some(req) = parse_request(msg) else { return reply(error_packet(ERR_ILLEGAL, "Malformed request")).await };
    if !["octet", "netascii", "binary"].contains(&req.mode.as_str()) {
        return reply(error_packet(ERR_ILLEGAL, &format!("Unsupported mode {}", req.mode))).await;
    }
    let Some(file) = resolve_in_root(&opts.root, &req.filename) else {
        emit("log", json!(format!("Refused {peer}: \"{}\" is outside the TFTP folder", req.filename)));
        return reply(error_packet(ERR_ACCESS, "Access violation")).await;
    };
    if op == WRQ && !opts.allow_write {
        emit("log", json!(format!("Refused upload of \"{}\" from {peer}: uploads are turned off", req.filename)));
        return reply(error_packet(ERR_ACCESS, "Uploads are disabled")).await;
    }
    let id = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let t = Transfer::new(id, op == RRQ, file, req, peer, opts.clone(), emit.clone());
    tokio::spawn(t.run(stop));
}

/// One transfer on its own UDP socket (the server's transfer ID).
struct Transfer {
    id: u64,
    send: bool,
    file: PathBuf,
    name: String,
    req: Request,
    peer: SocketAddr,
    opts: Options,
    emit: Emit,
    blksize: usize,
    timeout: Duration,
    bytes: u64,
    size: u64,
    last_info: Option<Instant>,
}

impl Transfer {
    fn new(id: u64, send: bool, file: PathBuf, req: Request, peer: SocketAddr, opts: Options, emit: Emit) -> Self {
        let root = crate::util::resolve(&opts.root);
        let name = file.strip_prefix(&root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        Transfer { id, send, file, name, req, peer, opts, emit, blksize: 512, timeout: Duration::from_secs(3), bytes: 0, size: 0, last_info: None }
    }

    fn info(&self, state: &str, error: Option<&str>) {
        let mut v = json!({
            "id": self.id, "dir": if self.send { "send" } else { "receive" }, "name": self.name,
            "peer": self.peer.to_string(), "state": state, "bytes": self.bytes, "size": self.size,
        });
        if let Some(e) = error {
            v["error"] = json!(e);
        }
        (self.emit)("transfer", v);
    }

    fn progress(&mut self) {
        if self.last_info.is_none_or(|t| t.elapsed() > Duration::from_millis(250)) {
            self.last_info = Some(Instant::now());
            self.info("progress", None);
        }
    }

    fn negotiate(&mut self) -> Option<Vec<(String, String)>> {
        let o = &self.req.options;
        let mut ack = Vec::new();
        if let Some(b) = o.get("blksize") {
            let n = b.trim().parse::<f64>().ok().filter(|n| *n != 0.0).unwrap_or(512.0).clamp(8.0, 65464.0) as usize;
            self.blksize = n;
            ack.push(("blksize".to_string(), n.to_string()));
        }
        if let Some(t) = o.get("timeout") {
            let n = t.trim().parse::<f64>().ok().filter(|n| *n != 0.0).unwrap_or(3.0).clamp(1.0, 255.0) as u64;
            self.timeout = Duration::from_secs(n);
            ack.push(("timeout".to_string(), n.to_string()));
        }
        if let Some(ts) = o.get("tsize") {
            let v = if self.send { self.size } else { ts.trim().parse::<f64>().unwrap_or(0.0) as u64 };
            ack.push(("tsize".to_string(), v.to_string()));
            if !self.send {
                self.size = v;
            }
        }
        (!ack.is_empty()).then_some(ack)
    }

    async fn run(mut self, stop: watch::Receiver<bool>) {
        let bind = if self.peer.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
        let sock = match UdpSocket::bind(bind).await {
            Ok(s) => s,
            Err(e) => return self.info("failed", Some(&e.to_string())),
        };
        let mut tmp: Option<PathBuf> = None;
        let res = self.transfer(&sock, stop, &mut tmp).await;
        if let Some(t) = tmp {
            let _ = tokio::fs::remove_file(t).await;
        }
        match res {
            Ok(()) => self.info("done", None),
            Err((code, msg, notify)) => {
                if notify {
                    let _ = sock.send_to(&error_packet(code, &msg), self.peer).await;
                }
                self.info("failed", Some(&msg));
            }
        }
    }

    /// Send `pkt` and wait for the reply the transfer expects, re-sending on timeout.
    async fn exchange(
        &self,
        sock: &UdpSocket,
        pkt: &[u8],
        stop: &mut watch::Receiver<bool>,
        mut accept: impl FnMut(&[u8]) -> Option<Reply>,
    ) -> std::result::Result<Vec<u8>, (u16, String, bool)> {
        sock.send_to(pkt, self.peer).await.map_err(|e| (ERR_NOT_DEFINED, e.to_string(), false))?;
        let mut retries = 0;
        let mut buf = vec![0u8; 65536 + 4];
        let mut deadline = tokio::time::Instant::now() + self.timeout;
        loop {
            tokio::select! {
                r = sock.recv_from(&mut buf) => {
                    let (n, from) = r.map_err(|e| (ERR_NOT_DEFINED, e.to_string(), false))?;
                    if from != self.peer {
                        let _ = sock.send_to(&error_packet(ERR_UNKNOWN_TID, "Unknown transfer ID"), from).await;
                        continue;
                    }
                    let msg = &buf[..n];
                    if msg.len() < 4 { continue; }
                    if u16::from_be_bytes([msg[0], msg[1]]) == ERROR {
                        let text: String = msg[4..].iter().take_while(|&&b| b != 0).map(|&b| b as char).collect();
                        return Err((0, format!("Peer error: {text}"), false));
                    }
                    match accept(msg) {
                        Some(Reply::Take) => return Ok(msg.to_vec()),
                        Some(Reply::Resend) => { sock.send_to(pkt, self.peer).await.ok(); }
                        Some(Reply::Fail(code, m)) => return Err((code, m, true)),
                        None => {}
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    retries += 1;
                    if retries > MAX_RETRIES { return Err((ERR_NOT_DEFINED, "Timed out".into(), false)); }
                    sock.send_to(pkt, self.peer).await.ok();
                    deadline = tokio::time::Instant::now() + self.timeout;
                }
                _ = stop.changed() => return Err((ERR_NOT_DEFINED, "Server stopped".into(), false)),
            }
        }
    }

    fn oack(ack: &[(String, String)]) -> Vec<u8> {
        let mut b = OACK.to_be_bytes().to_vec();
        for (k, v) in ack {
            b.extend_from_slice(k.as_bytes());
            b.push(0);
            b.extend_from_slice(v.as_bytes());
            b.push(0);
        }
        b
    }

    fn ack(n: u64) -> Vec<u8> {
        let mut b = ACK.to_be_bytes().to_vec();
        b.extend_from_slice(&((n & 0xffff) as u16).to_be_bytes());
        b
    }

    async fn transfer(&mut self, sock: &UdpSocket, mut stop: watch::Receiver<bool>, tmp: &mut Option<PathBuf>) -> std::result::Result<(), (u16, String, bool)> {
        let io = |e: std::io::Error| (ERR_NOT_DEFINED, e.to_string(), true);
        if self.send {
            let meta = tokio::fs::metadata(&self.file).await.map_err(|_| (ERR_NOT_FOUND, "File not found".to_string(), true))?;
            if !meta.is_file() {
                return Err((ERR_NOT_FOUND, "File not found".into(), true));
            }
            self.size = meta.len();
            let mut fd = tokio::fs::File::open(&self.file).await.map_err(io)?;
            self.info("started", None);
            let mut block: u64 = 0;
            if let Some(ack) = self.negotiate() {
                // The client ACKs block 0, then data starts.
                let pkt = Self::oack(&ack);
                self.exchange(sock, &pkt, &mut stop, |m| {
                    (u16::from_be_bytes([m[0], m[1]]) == ACK && u16::from_be_bytes([m[2], m[3]]) == 0).then_some(Reply::Take)
                })
                .await?;
            }
            loop {
                block += 1;
                let mut data = vec![0u8; self.blksize];
                fd.seek(std::io::SeekFrom::Start((block - 1) * self.blksize as u64)).await.map_err(io)?;
                let mut got = 0;
                while got < self.blksize {
                    let n = fd.read(&mut data[got..]).await.map_err(io)?;
                    if n == 0 {
                        break;
                    }
                    got += n;
                }
                // Block numbers roll over after 65535 for large images.
                let mut pkt = DATA.to_be_bytes().to_vec();
                pkt.extend_from_slice(&((block & 0xffff) as u16).to_be_bytes());
                pkt.extend_from_slice(&data[..got]);
                self.bytes = self.size.min((block - 1) * self.blksize as u64 + got as u64);
                self.progress();
                let want = (block & 0xffff) as u16;
                // Duplicate ACKs are ignored (no sorcerer's apprentice).
                self.exchange(sock, &pkt, &mut stop, |m| {
                    let op = u16::from_be_bytes([m[0], m[1]]);
                    if op == ACK {
                        (u16::from_be_bytes([m[2], m[3]]) == want).then_some(Reply::Take)
                    } else {
                        Some(Reply::Fail(ERR_ILLEGAL, "Unexpected packet".into()))
                    }
                })
                .await?;
                if got < self.blksize {
                    return Ok(());
                }
            }
        } else {
            if self.file.exists() && !self.opts.allow_overwrite {
                return Err((ERR_EXISTS, "File already exists".into(), true));
            }
            if let Some(dir) = self.file.parent() {
                tokio::fs::create_dir_all(dir).await.map_err(io)?;
            }
            let part = PathBuf::from(format!("{}.part-{}-{}", self.file.display(), std::process::id(), self.id));
            *tmp = Some(part.clone());
            let mut fd = tokio::fs::File::create(&part).await.map_err(io)?;
            self.info("started", None);
            let ack = self.negotiate();
            let mut pkt = match &ack {
                Some(a) => Self::oack(a),
                None => Self::ack(0),
            };
            let mut block: u64 = 0;
            loop {
                let expected = ((block + 1) & 0xffff) as u16;
                let current = (block & 0xffff) as u16;
                let blksize = self.blksize;
                let msg = self
                    .exchange(sock, &pkt, &mut stop, |m| {
                        let op = u16::from_be_bytes([m[0], m[1]]);
                        if op != DATA {
                            return Some(Reply::Fail(ERR_ILLEGAL, "Unexpected packet".into()));
                        }
                        let n = u16::from_be_bytes([m[2], m[3]]);
                        if n == expected {
                            if m.len() - 4 > blksize { Some(Reply::Fail(ERR_ILLEGAL, "Block too large".into())) } else { Some(Reply::Take) }
                        } else if n == current {
                            Some(Reply::Resend)
                        } else {
                            None
                        }
                    })
                    .await?;
                let data = &msg[4..];
                fd.write_all(data).await.map_err(|e| (ERR_DISK_FULL, e.to_string(), true))?;
                block += 1;
                self.bytes += data.len() as u64;
                pkt = Self::ack(block);
                if data.len() < self.blksize {
                    // Last block: the file is complete and renamed before the device is told it
                    // succeeded.
                    fd.flush().await.map_err(io)?;
                    drop(fd);
                    tokio::fs::rename(&part, &self.file).await.map_err(|e| (ERR_NOT_DEFINED, e.to_string(), false))?;
                    *tmp = None;
                    sock.send_to(&pkt, self.peer).await.ok();
                    // Keep the socket briefly so a lost final ACK can be re-sent when the client
                    // retransmits.
                    let mut buf = vec![0u8; 65536 + 4];
                    let until = tokio::time::Instant::now() + self.timeout;
                    while let Ok(Ok((n, from))) = tokio::time::timeout_at(until, sock.recv_from(&mut buf)).await {
                        if from == self.peer
                            && n >= 4
                            && u16::from_be_bytes([buf[0], buf[1]]) == DATA
                            && u16::from_be_bytes([buf[2], buf[3]]) == (block & 0xffff) as u16
                        {
                            sock.send_to(&pkt, self.peer).await.ok();
                        }
                    }
                    return Ok(());
                }
                self.progress();
            }
        }
    }
}

enum Reply {
    Take,
    Resend,
    Fail(u16, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xmodem::tests::random_bytes;

    /// Minimal TFTP client (what a router does for "copy tftp: flash:").
    async fn client(port: u16, get: bool, name: &str, data: &[u8], options: &[(&str, &str)]) -> Value {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut req = (if get { 1u16 } else { 2u16 }).to_be_bytes().to_vec();
        let mut parts = vec![name, "octet"];
        for (k, v) in options {
            parts.push(k);
            parts.push(v);
        }
        for p in parts {
            req.extend(p.chars().map(|c| c as u8));
            req.push(0);
        }
        sock.send_to(&req, ("127.0.0.1", port)).await.unwrap();
        let mut blksize = 512usize;
        let mut chunks = Vec::new();
        let mut sent: usize = 0;
        let mut last_len: isize = -1;
        let mut oack = serde_json::Map::new();
        let mut buf = vec![0u8; 70000];
        let send_data = |n: usize, blk: usize| -> Vec<u8> {
            let start = ((n - 1) * blk).min(data.len());
            let end = (n * blk).min(data.len());
            let mut b = vec![0, 3, (n >> 8) as u8, n as u8];
            b.extend_from_slice(&data[start..end]);
            b
        };
        loop {
            let (n, r) = tokio::time::timeout(Duration::from_secs(15), sock.recv_from(&mut buf)).await.expect("client timeout").unwrap();
            let msg = &buf[..n];
            let code = u16::from_be_bytes([msg[0], msg[1]]);
            if code == 5 {
                return json!({ "error": u16::from_be_bytes([msg[2], msg[3]]) });
            }
            if code == 6 {
                let text: String = msg[2..].iter().map(|&b| b as char).collect();
                let items: Vec<&str> = text.split('\0').filter(|s| !s.is_empty()).collect();
                for kv in items.chunks(2) {
                    oack.insert(kv[0].to_string(), json!(kv[1]));
                }
                if let Some(b) = oack.get("blksize") {
                    blksize = b.as_str().unwrap().parse().unwrap();
                }
                if get {
                    sock.send_to(&[0, 4, 0, 0], r).await.unwrap();
                } else {
                    let p = send_data(1, blksize);
                    last_len = p.len() as isize - 4;
                    sent = 1;
                    sock.send_to(&p, r).await.unwrap();
                }
                continue;
            }
            if get && code == 3 {
                chunks.extend_from_slice(&msg[4..]);
                sock.send_to(&[0, 4, msg[2], msg[3]], r).await.unwrap();
                if n - 4 < blksize {
                    return json!({ "data": hex::encode(&chunks), "oack": oack });
                }
            } else if !get && code == 4 {
                let ackn = u16::from_be_bytes([msg[2], msg[3]]) as usize;
                if ackn != (sent & 0xffff) {
                    continue;
                }
                if sent > 0 && last_len < blksize as isize {
                    return json!({ "ok": true, "oack": oack });
                }
                let p = send_data(sent + 1, blksize);
                last_len = p.len() as isize - 4;
                sent += 1;
                sock.send_to(&p, r).await.unwrap();
            }
        }
    }

    async fn server(allow_write: bool) -> (TftpServer, PathBuf, Arc<std::sync::Mutex<Vec<String>>>) {
        let root = crate::store::tests::tmp("tftp");
        let log: Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let l = log.clone();
        let emit: Emit = Arc::new(move |kind, v| {
            if kind == "log" {
                l.lock().unwrap().push(v.as_str().unwrap().to_string());
            }
        });
        let srv =
            TftpServer::start(Options { root: root.clone(), port: 0, host: "127.0.0.1".into(), allow_write, allow_overwrite: false }, emit).await.unwrap();
        (srv, root, log)
    }

    #[tokio::test]
    async fn download_with_and_without_options() {
        let (srv, root, _) = server(false).await;
        let image = random_bytes(512 * 40); // exact multiple of 512: needs a final empty block
        std::fs::write(root.join("ios.bin"), &image).unwrap();
        let plain = client(srv.port, true, "ios.bin", &[], &[]).await;
        assert_eq!(plain["data"], hex::encode(&image));
        let fast = client(srv.port, true, "ios.bin", &[], &[("blksize", "1428"), ("tsize", "0")]).await;
        assert_eq!(fast["data"], hex::encode(&image));
        assert_eq!(fast["oack"], json!({ "blksize": "1428", "tsize": image.len().to_string() }));
    }

    #[tokio::test]
    async fn uploads_off_by_default_then_never_overwrite() {
        let (srv, _, _) = server(false).await;
        assert_eq!(client(srv.port, false, "sw1.cfg", b"hostname sw1\n", &[]).await["error"], 2);
        let (srv, root, _) = server(true).await;
        let cfg = random_bytes(3000);
        assert_eq!(client(srv.port, false, "backups/sw1.cfg", &cfg, &[("blksize", "1024")]).await["ok"], true);
        assert_eq!(std::fs::read(root.join("backups/sw1.cfg")).unwrap(), cfg);
        assert_eq!(client(srv.port, false, "backups/sw1.cfg", b"x", &[]).await["error"], 6);
        let names: Vec<String> = std::fs::read_dir(root.join("backups")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["sw1.cfg"], "no partial files left");
    }

    #[tokio::test]
    async fn requests_outside_the_folder_are_refused() {
        let (srv, _, log) = server(true).await;
        for name in ["../secret", "a/../../x", "C:\\Windows\\win.ini", "..\\x"] {
            assert_eq!(client(srv.port, true, name, &[], &[]).await["error"], 2, "{name}");
        }
        // A leading "/" means the TFTP folder (as with tftpd -s), never the real root.
        assert_eq!(client(srv.port, true, "/etc/passwd", &[], &[]).await["error"], 1);
        assert_eq!(client(srv.port, false, "../evil", b"x", &[]).await["error"], 2);
        assert!(log.lock().unwrap().iter().any(|l| l.contains("outside the TFTP folder")));
        assert_eq!(client(srv.port, true, "missing.bin", &[], &[]).await["error"], 1);
        assert_eq!(resolve_in_root(Path::new("/srv/tftp"), "ok/file.bin"), Some(PathBuf::from("/srv/tftp/ok/file.bin")));
    }
}
