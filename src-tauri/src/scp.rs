// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! SCP protocol (the rcp-style protocol behind `scp -t` / `scp -f`) over an SSH exec channel.
//! Works with any server that has an scp binary, including network devices without SFTP.
//!
//! Wire format: control records end with "\n" and are acknowledged with a single byte:
//!   0 = OK, 1 = warning (message follows), 2 = fatal error (message follows).
//!   T<mtime> 0 <atime> 0   times for the next file/dir   (with -p)
//!   C<mode> <size> <name>  file; <size> bytes follow, then a 0 byte
//!   D<mode> 0 <name>       enter directory
//!   E                      leave directory

use crate::xmodem::Signal;
use anyhow::{Result, anyhow, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

const CHUNK: usize = 64 * 1024;

/// A remote command's channel: stdout chunks in, stdin out, stderr collected.
pub struct ExecStream {
    pub rx: mpsc::Receiver<Vec<u8>>,
    pub stderr: Arc<Mutex<String>>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
}

pub type Exec = Arc<dyn Fn(String) -> BoxFuture<'static, Result<ExecStream>> + Send + Sync>;

/// Escape a remote path for the remote shell. Glob characters (* ? [ ]) stay active so wildcard
/// downloads work like OpenSSH scp; a leading ~/ stays expandable.
pub fn quote_remote(p: &str) -> Result<String> {
    if p.is_empty() || p == "~" {
        return Ok(".".into());
    }
    if p.contains(['\n', '\r', '\0']) {
        bail!("Remote path contains a line break");
    }
    let (prefix, rest) = match p.strip_prefix("~/") {
        Some(r) => ("~/", r),
        None => ("", p),
    };
    let mut out = String::from(prefix);
    for c in rest.chars() {
        if c.is_ascii_alphanumeric() || "_-.,:/@%+=*?[]".contains(c) {
            out.push(c);
        } else {
            out.push('\\');
            out.push(c);
        }
    }
    Ok(out)
}

/// A remote-supplied file name must be a single, plain path component (blocks ../ traversal).
pub fn safe_name(name: &str) -> bool {
    crate::security::is_safe_file_name(name)
}

/// Buffered async reader over a channel.
struct ChannelReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: VecDeque<u8>,
    pub ended: bool,
    stderr: Arc<Mutex<String>>,
    signal: Arc<Signal>,
}

impl ChannelReader {
    async fn need(&mut self) -> Result<()> {
        while self.buf.is_empty() {
            if self.ended {
                let msg = self.stderr.lock().trim().to_string();
                bail!(if msg.is_empty() { "Connection closed during transfer".to_string() } else { msg });
            }
            if self.signal.is_cancelled() {
                bail!("Transfer cancelled");
            }
            tokio::select! {
                d = self.rx.recv() => match d {
                    Some(d) => self.buf.extend(d),
                    None => {
                        self.ended = true;
                        // Give stderr a moment to arrive (it travels separately from stdout).
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                },
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }
        Ok(())
    }

    /// Take up to n bytes (at least 1).
    async fn take(&mut self, n: usize) -> Result<Vec<u8>> {
        self.need().await?;
        let k = n.min(self.buf.len());
        Ok(self.buf.drain(..k).collect())
    }

    async fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1).await?[0])
    }

    async fn line(&mut self) -> Result<String> {
        let mut bytes = Vec::new();
        loop {
            let b = self.byte().await?;
            if b == b'\n' {
                return Ok(String::from_utf8_lossy(&bytes).into_owned());
            }
            bytes.push(b);
            if bytes.len() > 64 * 1024 {
                bail!("Protocol error: line too long");
            }
        }
    }

    /// Read one acknowledgement byte; fails on warning/error replies.
    async fn ack(&mut self) -> Result<()> {
        let b = self.byte().await?;
        if b == 0 {
            return Ok(());
        }
        let msg = self.line().await?.trim().to_string();
        bail!(if msg.is_empty() { if b == 1 { "Remote warning".into() } else { "Remote error".into() } } else { msg })
    }
}

async fn write(w: &mut (dyn AsyncWrite + Send + Unpin), signal: &Signal, data: &[u8]) -> Result<()> {
    if signal.is_cancelled() {
        bail!("Transfer cancelled");
    }
    w.write_all(data).await.map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

/// Total bytes under a local path (for progress).
fn scan_local(p: &Path) -> Result<u64> {
    let st = std::fs::metadata(p)?;
    if !st.is_dir() {
        return Ok(st.len());
    }
    let mut bytes = 0;
    for e in std::fs::read_dir(p)? {
        bytes += scan_local(&e?.path())?;
    }
    Ok(bytes)
}

fn secs(t: std::io::Result<SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn mode_octal(meta: &std::fs::Metadata, fallback: u32) -> String {
    #[cfg(unix)]
    let m = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o7777
    };
    #[cfg(not(unix))]
    let m = {
        let _ = meta;
        0
    };
    format!("{:04o}", if m == 0 { fallback } else { m })
}

fn base_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct Up<'a> {
    w: Box<dyn AsyncWrite + Send + Unpin>,
    rd: ChannelReader,
    preserve: bool,
    done: u64,
    total: u64,
    progress: &'a (dyn Fn(Value) + Send + Sync),
    signal: Arc<Signal>,
}

impl Up<'_> {
    fn report(&self, file: &str) {
        (self.progress)(json!({ "done": self.done, "total": self.total, "file": file }));
    }

    async fn send_times(&mut self, meta: &std::fs::Metadata) -> Result<()> {
        if !self.preserve {
            return Ok(());
        }
        write(&mut *self.w, &self.signal, format!("T{} 0 {} 0\n", secs(meta.modified()), secs(meta.accessed())).as_bytes()).await?;
        self.rd.ack().await
    }

    async fn send_file(&mut self, p: &Path, meta: &std::fs::Metadata) -> Result<()> {
        let name = base_name(p);
        self.send_times(meta).await?;
        write(&mut *self.w, &self.signal, format!("C{} {} {}\n", mode_octal(meta, 0o644), meta.len(), name).as_bytes()).await?;
        self.rd.ack().await?;
        let mut fh = tokio::fs::File::open(p).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut left = meta.len();
        while left > 0 {
            let want = (CHUNK as u64).min(left) as usize;
            let n = fh.read(&mut buf[..want]).await?;
            if n == 0 {
                bail!("{name}: file shrank during upload");
            }
            write(&mut *self.w, &self.signal, &buf[..n]).await?;
            left -= n as u64;
            self.done += n as u64;
            self.report(&name);
        }
        write(&mut *self.w, &self.signal, &[0]).await?;
        self.rd.ack().await
    }

    fn send_dir<'b>(&'b mut self, p: &'b Path, meta: &'b std::fs::Metadata) -> BoxFuture<'b, Result<()>> {
        Box::pin(async move {
            self.send_times(meta).await?;
            write(&mut *self.w, &self.signal, format!("D{} 0 {}\n", mode_octal(meta, 0o755), base_name(p)).as_bytes()).await?;
            self.rd.ack().await?;
            let mut children: Vec<PathBuf> = std::fs::read_dir(p)?.filter_map(|e| e.ok().map(|e| e.path())).collect();
            children.sort();
            for cp in children {
                if self.signal.is_cancelled() {
                    bail!("Transfer cancelled");
                }
                let cst = std::fs::metadata(&cp)?;
                if cst.is_dir() {
                    self.send_dir(&cp, &cst).await?;
                } else if cst.is_file() {
                    self.send_file(&cp, &cst).await?;
                }
            }
            write(&mut *self.w, &self.signal, b"E\n").await?;
            self.rd.ack().await
        })
    }
}

/// Upload local files/directories to remote_dir.
pub async fn upload(
    exec: &Exec,
    local_paths: &[PathBuf],
    remote_dir: &str,
    preserve: bool,
    signal: Arc<Signal>,
    progress: &(dyn Fn(Value) + Send + Sync),
) -> Result<Value> {
    let mut total = 0;
    let mut any_dir = false;
    for p in local_paths {
        total += scan_local(p)?;
        any_dir |= std::fs::metadata(p)?.is_dir();
    }
    let flags = format!("{}{}", if any_dir { " -r" } else { "" }, if preserve { " -p" } else { "" });
    let stream = exec(format!("scp{flags} -t -- {}", quote_remote(remote_dir)?)).await?;
    let rd = ChannelReader { rx: stream.rx, buf: VecDeque::new(), ended: false, stderr: stream.stderr, signal: signal.clone() };
    let mut up = Up { w: stream.writer, rd, preserve, done: 0, total, progress, signal: signal.clone() };
    let res: Result<()> = async {
        up.rd.ack().await?; // remote scp is ready
        for p in local_paths {
            if signal.is_cancelled() {
                bail!("Transfer cancelled");
            }
            let st = std::fs::metadata(p)?;
            if st.is_dir() {
                up.send_dir(p, &st).await?;
            } else {
                up.send_file(p, &st).await?;
            }
        }
        up.report("");
        Ok(())
    }
    .await;
    let _ = up.w.shutdown().await;
    res?;
    Ok(json!({ "bytes": up.done, "total": total }))
}

fn set_times(p: &Path, atime: u64, mtime: u64) {
    let t = std::fs::FileTimes::new().set_accessed(UNIX_EPOCH + Duration::from_secs(atime)).set_modified(UNIX_EPOCH + Duration::from_secs(mtime));
    if let Ok(f) = std::fs::File::options().write(!p.is_dir()).read(p.is_dir()).open(p) {
        let _ = f.set_times(t);
    }
}

/// Download a remote file or directory (recursively) into local_dir. Remote-supplied names are
/// validated so a malicious server can't write outside local_dir.
pub async fn download(
    exec: &Exec,
    remote_path: &str,
    local_dir: &Path,
    preserve: bool,
    signal: Arc<Signal>,
    progress: &(dyn Fn(Value) + Send + Sync),
) -> Result<Value> {
    let stream = exec(format!("scp -r{} -f -- {}", if preserve { " -p" } else { "" }, quote_remote(remote_path)?)).await?;
    let mut w = stream.writer;
    let mut rd = ChannelReader { rx: stream.rx, buf: VecDeque::new(), ended: false, stderr: stream.stderr.clone(), signal: signal.clone() };
    let mut dirs = vec![crate::util::resolve(local_dir)];
    let mut times: Option<(u64, u64)> = None;
    let (mut done, mut total, mut files, mut dirs_created) = (0u64, 0u64, 0u64, 0u64);
    let trimmed = remote_path.trim_end_matches('/');
    let top = trimmed.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(remote_path).to_string();
    // With wildcards the server legitimately sends names other than the one requested.
    let expect_top = if top.contains(['*', '?', '[', ']', '{', '}']) || top == "~" || top == "." { None } else { Some(top.clone()) };
    let t_re = Regex::new(r"^(\d+) \d+ (\d+) \d+$").unwrap();
    let d_re = Regex::new(r"^([0-7]{3,4}) \d+ (.+)$").unwrap();
    let c_re = Regex::new(r"^([0-7]{3,4}) (\d+) (.+)$").unwrap();

    let res: Result<()> = async {
        write(&mut *w, &signal, &[0]).await?;
        loop {
            if signal.is_cancelled() {
                bail!("Transfer cancelled");
            }
            let typ = match rd.byte().await {
                Ok(b) => b,
                Err(e) => {
                    if rd.ended && dirs.len() == 1 {
                        break; // remote finished at top level: normal end
                    }
                    return Err(e);
                }
            };
            if typ == 1 || typ == 2 {
                let msg = rd.line().await?.trim().to_string();
                bail!(if msg.is_empty() { "Remote error".into() } else { msg });
            }
            let line = rd.line().await?.trim().to_string();
            let cur = dirs.last().unwrap().clone();
            match typ {
                b'T' => {
                    let m = t_re.captures(&line).ok_or_else(|| anyhow!("Protocol error: bad time record \"T{line}\""))?;
                    times = Some((m[1].parse()?, m[2].parse()?));
                    write(&mut *w, &signal, &[0]).await?;
                }
                b'D' => {
                    let m = d_re.captures(&line);
                    let name = m.as_ref().map(|m| m[2].to_string());
                    let Some(name) = name.filter(|n| safe_name(n)) else {
                        bail!("Refusing unsafe directory name from server: \"{}\"", m.map(|m| m[2].to_string()).unwrap_or(line));
                    };
                    if dirs.len() == 1 && expect_top.as_ref().is_some_and(|t| *t != name) {
                        bail!("Server sent unexpected directory \"{name}\" (asked for \"{top}\")");
                    }
                    let dir = cur.join(&name);
                    tokio::fs::create_dir_all(&dir).await?;
                    if let (Some((mtime, atime)), true) = (times, preserve) {
                        set_times(&dir, atime, mtime);
                    }
                    dirs.push(dir);
                    dirs_created += 1;
                    times = None;
                    write(&mut *w, &signal, &[0]).await?;
                }
                b'E' => {
                    if dirs.len() == 1 {
                        bail!("Protocol error: unbalanced directory end");
                    }
                    dirs.pop();
                    write(&mut *w, &signal, &[0]).await?;
                }
                b'C' => {
                    let m = c_re.captures(&line);
                    let name = m.as_ref().map(|m| m[3].to_string());
                    let Some(name) = name.filter(|n| safe_name(n)) else {
                        bail!("Refusing unsafe file name from server: \"{}\"", m.map(|m| m[3].to_string()).unwrap_or(line));
                    };
                    if dirs.len() == 1 && expect_top.as_ref().is_some_and(|t| *t != name) {
                        bail!("Server sent unexpected file \"{name}\" (asked for \"{top}\")");
                    }
                    let m = m.unwrap();
                    let size: u64 = m[2].parse()?;
                    let mode = u32::from_str_radix(&m[1], 8)?;
                    let file = cur.join(&name);
                    total += size;
                    write(&mut *w, &signal, &[0]).await?;
                    let mut out = tokio::fs::File::create(&file).await?;
                    let mut left = size;
                    while left > 0 {
                        if signal.is_cancelled() {
                            bail!("Transfer cancelled");
                        }
                        let chunk = rd.take((left as usize).min(CHUNK)).await?;
                        left -= chunk.len() as u64;
                        done += chunk.len() as u64;
                        out.write_all(&chunk).await?;
                        progress(json!({ "done": done, "total": total, "file": name, "fileSize": size }));
                    }
                    out.flush().await?;
                    drop(out);
                    rd.ack().await?; // trailing 0 after file data
                    if preserve {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode & 0o777));
                        }
                        let _ = mode;
                        if let Some((mtime, atime)) = times {
                            set_times(&file, atime, mtime);
                        }
                    }
                    times = None;
                    files += 1;
                    write(&mut *w, &signal, &[0]).await?;
                }
                _ => bail!("Protocol error: unexpected record \"{}{line}\"", typ as char),
            }
        }
        Ok(())
    }
    .await;
    let _ = w.shutdown().await;
    res?;
    if files == 0 && dirs_created == 0 {
        let msg = stream.stderr.lock().trim().to_string();
        bail!(if msg.is_empty() { "Nothing was downloaded".to_string() } else { msg });
    }
    progress(json!({ "done": done, "total": total, "file": "" }));
    Ok(json!({ "bytes": done, "files": files }))
}

/// An exec channel backed by a local `/bin/sh -c` process (tests, and the shape of a real one).
#[cfg(test)]
pub fn local_exec(cwd: PathBuf) -> Exec {
    use std::process::Stdio;
    Arc::new(move |cmd: String| {
        let cwd = cwd.clone();
        Box::pin(async move {
            let mut child = tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                .current_dir(&cwd)
                .env("HOME", &cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            let stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let (tx, rx) = mpsc::channel(64);
            let err = Arc::new(Mutex::new(String::new()));
            let e2 = err.clone();
            tokio::spawn(async move {
                let mut s = String::new();
                let _ = stderr.read_to_string(&mut s).await;
                e2.lock().push_str(&s);
            });
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                while let Ok(n) = stdout.read(&mut buf).await {
                    if n == 0 || tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                let _ = child.wait().await;
            });
            Ok(ExecStream { rx, stderr: err, writer: Box::new(stdin) })
        })
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A scripted server response (for malicious-server tests).
    fn fake_exec(server: &'static [u8]) -> Exec {
        Arc::new(move |_cmd| {
            Box::pin(async move {
                let (tx, rx) = mpsc::channel(4);
                tx.send(server.to_vec()).await.unwrap();
                drop(tx);
                Ok(ExecStream { rx, stderr: Default::default(), writer: Box::new(tokio::io::sink()) })
            })
        })
    }

    pub fn none(_: Value) {}

    #[tokio::test]
    async fn refuses_path_traversal() {
        let dir = crate::store::tests::tmp("scpevil");
        let sig = || Arc::new(Signal::default());
        for body in [&b"C0644 4 ../escape.txt\nevil\0"[..], b"C0644 4 /etc/passwd\nevil\0", b"C0644 4 ..\nevil\0", b"C0644 4 a/b.txt\nevil\0"] {
            let e = download(&fake_exec(body), "x", &dir, true, sig(), &none).await.unwrap_err().to_string();
            assert!(e.contains("unsafe file name") || e.contains("unexpected file"), "{e}");
        }
        let e = download(&fake_exec(b"D0755 0 ..\nE\n"), "x", &dir, true, sig(), &none).await.unwrap_err().to_string();
        assert!(e.contains("unsafe directory name"), "{e}");
        let e = download(&fake_exec(b"C0644 4 .bashrc\nevil\0"), "report.txt", &dir, true, sig(), &none).await.unwrap_err().to_string();
        assert!(e.contains("unexpected file"), "{e}");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nothing written");
    }

    pub fn make_local_tree() -> PathBuf {
        let dir = crate::store::tests::tmp("scplocal");
        std::fs::write(dir.join("hello.txt"), "hello scp\n").unwrap();
        std::fs::create_dir_all(dir.join("proj/sub")).unwrap();
        std::fs::write(dir.join("proj/a.txt"), "A".repeat(1000)).unwrap();
        std::fs::write(dir.join("proj/sub/big.bin"), vec![7u8; 3 * 1024 * 1024 + 17]).unwrap();
        std::fs::write(dir.join("it's here.txt"), "quote in name").unwrap();
        set_times(&dir.join("hello.txt"), 1577934245, 1577934245); // 2020-01-02T03:04:05Z
        dir
    }

    fn mtime(p: &Path) -> u64 {
        secs(std::fs::metadata(p).unwrap().modified())
    }

    /// Upload, download, wildcards and errors against an exec channel (local or over SSH).
    pub async fn exercise(exec: &Exec, remote: &Path) {
        std::fs::create_dir_all(remote.join("uploads")).unwrap();
        let local = make_local_tree();
        let progress: Arc<Mutex<Vec<Value>>> = Default::default();
        let p2 = progress.clone();
        let rec = move |v: Value| p2.lock().push(v);
        let up = upload(exec, &[local.join("hello.txt"), local.join("proj"), local.join("it's here.txt")], "uploads", true, Arc::new(Signal::default()), &rec)
            .await
            .unwrap();
        assert_eq!(up["bytes"], up["total"]);
        assert_eq!(std::fs::read_to_string(remote.join("uploads/hello.txt")).unwrap(), "hello scp\n");
        assert_eq!(std::fs::read(remote.join("uploads/proj/sub/big.bin")).unwrap(), vec![7u8; 3 * 1024 * 1024 + 17]);
        assert_eq!(std::fs::read_to_string(remote.join("uploads/it's here.txt")).unwrap(), "quote in name");
        assert_eq!(mtime(&remote.join("uploads/hello.txt")), 1577934245, "mtime preserved");
        {
            let p = progress.lock();
            assert!(p.len() > 3 && p.last().unwrap()["done"] == up["total"]);
        }
        let back = crate::store::tests::tmp("scpback");
        let down = download(exec, "uploads/proj", &back, true, Arc::new(Signal::default()), &none).await.unwrap();
        assert_eq!(down["files"], 2);
        assert_eq!(std::fs::read(back.join("proj/sub/big.bin")).unwrap(), vec![7u8; 3 * 1024 * 1024 + 17]);
        download(exec, "~/uploads/hello.txt", &back, true, Arc::new(Signal::default()), &none).await.unwrap();
        assert_eq!(std::fs::read_to_string(back.join("hello.txt")).unwrap(), "hello scp\n");
        assert_eq!(mtime(&back.join("hello.txt")), 1577934245);
        let wild = crate::store::tests::tmp("scpwild");
        assert_eq!(download(exec, "uploads/*.txt", &wild, true, Arc::new(Signal::default()), &none).await.unwrap()["files"], 2);
        let e = upload(exec, &[local.join("hello.txt")], "no/such/dir", true, Arc::new(Signal::default()), &none).await.unwrap_err().to_string();
        assert!(e.to_lowercase().contains("no such file") || e.to_lowercase().contains("not a directory"), "{e}");
        let e = download(exec, "missing.txt", &back, true, Arc::new(Signal::default()), &none).await.unwrap_err().to_string();
        assert!(e.to_lowercase().contains("no such file"), "{e}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn with_the_real_scp_binary() {
        let remote = crate::store::tests::tmp("scpremote");
        exercise(&local_exec(remote.clone()), &remote).await;
    }

    #[test]
    fn quoting_and_names() {
        assert_eq!(quote_remote("it's").unwrap(), "it\\'s");
        assert_eq!(quote_remote("~/my dir/*.log").unwrap(), "~/my\\ dir/*.log");
        assert_eq!(quote_remote("a;rm -rf x").unwrap(), "a\\;rm\\ -rf\\ x");
        assert!(quote_remote("a\nb").unwrap_err().to_string().contains("line break"));
        assert_eq!(quote_remote("").unwrap(), ".");
        assert!(safe_name("report.txt"));
        assert!(!safe_name("../x") && !safe_name("a/b") && !safe_name("C:evil") && !safe_name(".."));
    }
}
