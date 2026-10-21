// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! SFTP tabs: browse both sides, transfer files and folders, rename/delete/mkdir/chmod.

use crate::bus::Bus;
use crate::json::{str_at, truthy};
use crate::proto::ssh::{Mode, SshClient, connect_client};
use crate::proto::{Ctx, Event};
use crate::security::is_safe_file_name;
use crate::store::Store;
use crate::util::{expand_tilde, home, resolve};
use anyhow::{Result, anyhow, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn mode_string(mode: u32, is_dir: bool, is_link: bool) -> String {
    let t = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let bits = [(0o400, 'r'), (0o200, 'w'), (0o100, 'x'), (0o40, 'r'), (0o20, 'w'), (0o10, 'x'), (0o4, 'r'), (0o2, 'w'), (0o1, 'x')];
    std::iter::once(t).chain(bits.iter().map(|(m, c)| if mode & m != 0 { *c } else { '-' })).collect()
}

fn posix_join(a: &str, b: &str) -> String {
    if a.ends_with('/') { format!("{a}{b}") } else { format!("{a}/{b}") }
}

fn posix_basename(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

/// The operations SFTP transfers need (a trait so tests can use a fake server).
pub trait Remote: Send + Sync {
    fn stat<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<(bool, u64)>>;
    fn list<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<Vec<String>>>;
    fn fetch<'a>(&'a self, remote: &'a str, local: &'a Path, step: &'a (dyn Fn(u64, u64) + Send + Sync)) -> BoxFuture<'a, Result<()>>;
}

struct Sftp(Arc<SftpSession>);

impl Remote for Sftp {
    fn stat<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<(bool, u64)>> {
        Box::pin(async move {
            let m = self.0.metadata(p).await?;
            Ok((m.is_dir(), m.size.unwrap_or(0)))
        })
    }
    fn list<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move { Ok(self.0.read_dir(p).await?.map(|e| e.file_name()).collect()) })
    }
    fn fetch<'a>(&'a self, remote: &'a str, local: &'a Path, step: &'a (dyn Fn(u64, u64) + Send + Sync)) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let total = self.0.metadata(remote).await?.size.unwrap_or(0);
            let mut src = self.0.open(remote).await?;
            let mut dst = tokio::fs::File::create(local).await?;
            let mut buf = vec![0u8; 64 * 1024];
            let mut done = 0u64;
            loop {
                let n = src.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await?;
                done += n as u64;
                step(done, total);
            }
            dst.flush().await?;
            Ok(())
        })
    }
}

struct Entry {
    client: Option<Arc<SshClient>>,
    sftp: Arc<dyn Remote>,
    raw: Option<Arc<SftpSession>>,
}

pub struct SftpService {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    sessions: Mutex<HashMap<String, Entry>>,
}

impl SftpService {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>) -> Arc<SftpService> {
        Arc::new(SftpService { bus, store, sessions: Mutex::new(HashMap::new()) })
    }

    pub async fn open(self: &Arc<Self>, sftp_id: &str, session_ref: &Value) -> Result<Value> {
        let mut session = self.store.lock().resolve_session(session_ref)?;
        if str_at(&session, &["protocol"]) != "ssh2" {
            bail!("SFTP requires an SSH2 session");
        }
        session["forwards"] = json!([]);
        let bus = self.bus.clone();
        let sid = sftp_id.to_string();
        let ctx = Ctx {
            store: self.store.clone(),
            prompt: Arc::new(move |mut req: Value| {
                req["tabId"] = json!(sid);
                bus.request("prompt", req)
            }),
        };
        let (ev, mut rx) = tokio::sync::mpsc::unbounded_channel();
        {
            let me = self.clone();
            let sid = sftp_id.to_string();
            let r = session_ref.clone();
            tokio::spawn(async move {
                while let Some(e) = rx.recv().await {
                    if let Event::Credentials(c) = e {
                        let target = if truthy(&c["target"]) { c["target"].clone() } else { r.clone() };
                        let saved = me.store.lock().save_credentials(&target, &c);
                        match saved {
                            Ok(saved) => me.bus.send("session:saved", vec![json!(sid), json!({ "session": saved, "forTab": !truthy(&c["target"]) })]),
                            Err(e) => eprintln!("[sftp] save login failed: {e}"),
                        }
                    }
                }
            });
        }
        let client = connect_client(session.clone(), ctx, ev, Mode::Sftp).await?;
        let sftp = match client.sftp().await {
            Ok(s) => Arc::new(s),
            Err(e) => {
                client.close();
                return Err(e);
            }
        };
        let home = sftp.canonicalize(".").await?;
        self.sessions.lock().insert(sftp_id.to_string(), Entry { client: Some(client.clone()), sftp: Arc::new(Sftp(sftp.clone())), raw: Some(sftp) });
        // Tell the page when the connection ends.
        let me = Arc::downgrade(self);
        let sid = sftp_id.to_string();
        tokio::spawn(async move {
            client.wait_closed().await;
            if let Some(me) = me.upgrade() {
                if me.sessions.lock().remove(&sid).is_some() {
                    me.bus.send("sftp:closed", vec![json!(sid)]);
                }
            }
        });
        Ok(json!({ "home": home, "host": session["host"], "username": self.username(sftp_id) }))
    }

    fn username(&self, id: &str) -> String {
        self.sessions.lock().get(id).and_then(|e| e.client.as_ref().map(|c| c.username.clone())).unwrap_or_default()
    }

    pub fn close(&self, sftp_id: &str) {
        if let Some(e) = self.sessions.lock().remove(sftp_id) {
            if let Some(c) = e.client {
                c.close();
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    fn raw(&self, id: &str) -> Result<Arc<SftpSession>> {
        self.sessions.lock().get(id).and_then(|e| e.raw.clone()).ok_or_else(|| anyhow!("SFTP session is not connected"))
    }

    fn remote(&self, id: &str) -> Result<Arc<dyn Remote>> {
        self.sessions.lock().get(id).map(|e| e.sftp.clone()).ok_or_else(|| anyhow!("SFTP session is not connected"))
    }

    pub async fn list_remote(&self, id: &str, dir: &str) -> Result<Value> {
        let sftp = self.raw(id)?;
        let real = sftp.canonicalize(dir).await?;
        let entries: Vec<Value> = sftp
            .read_dir(real.clone())
            .await?
            .map(|e| {
                let m = e.metadata();
                let (is_dir, is_link) = (m.is_dir(), m.is_symlink());
                json!({
                    "name": e.file_name(), "isDir": is_dir, "isLink": is_link, "size": m.size.unwrap_or(0),
                    "mtime": m.mtime.unwrap_or(0) as u64 * 1000, "mode": mode_string(m.permissions.unwrap_or(0), is_dir, is_link),
                })
            })
            .collect();
        Ok(json!({ "path": real, "entries": entries }))
    }

    pub async fn list_local(dir: &str) -> Result<Value> {
        let real = resolve(if dir.is_empty() { home().to_string_lossy().into_owned() } else { expand_tilde(dir) });
        let mut entries = Vec::new();
        let mut rd = tokio::fs::read_dir(&real).await?;
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(lst) = tokio::fs::symlink_metadata(e.path()).await else { continue };
            let is_link = lst.file_type().is_symlink();
            let mut is_dir = lst.is_dir();
            if is_link {
                if let Ok(m) = tokio::fs::metadata(e.path()).await {
                    is_dir = m.is_dir();
                }
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                lst.permissions().mode()
            };
            #[cfg(not(unix))]
            let mode = if lst.permissions().readonly() { 0o444 } else { 0o666 };
            let mtime = lst.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            entries.push(
                json!({ "name": name, "isDir": is_dir, "isLink": is_link, "size": lst.len(), "mtime": mtime, "mode": mode_string(mode, is_dir, is_link) }),
            );
        }
        let parent = real.parent().map(Path::to_path_buf).unwrap_or_else(|| real.clone());
        Ok(json!({ "path": real.to_string_lossy(), "entries": entries, "sep": std::path::MAIN_SEPARATOR.to_string(), "parent": parent.to_string_lossy() }))
    }

    pub async fn remote_op(&self, id: &str, op: &str, a: &str, b: &str) -> Result<()> {
        let sftp = self.raw(id)?;
        match op {
            "mkdir" => sftp.create_dir(a).await?,
            "rename" => sftp.rename(a, b).await?,
            "delete" => remove_remote(&sftp, a.to_string()).await?,
            "chmod" => {
                let mode = u32::from_str_radix(b.trim(), 8).map_err(|_| anyhow!("Invalid mode {b}"))?;
                let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                attrs.permissions = Some(mode);
                sftp.set_metadata(a, attrs).await?
            }
            _ => bail!("Unknown op {op}"),
        }
        Ok(())
    }

    pub async fn local_op(op: &str, a: &str, b: &str) -> Result<()> {
        match op {
            "mkdir" => tokio::fs::create_dir_all(a).await?,
            "rename" => tokio::fs::rename(a, b).await?,
            "delete" => {
                let m = tokio::fs::symlink_metadata(a).await;
                match m {
                    Ok(m) if m.is_dir() => tokio::fs::remove_dir_all(a).await?,
                    Ok(_) => tokio::fs::remove_file(a).await?,
                    Err(_) => {}
                }
            }
            _ => bail!("Unknown op {op}"),
        }
        Ok(())
    }

    /// Download a remote file or directory tree. Reports progress via sftp:progress events.
    pub fn download<'a>(&'a self, id: &'a str, transfer_id: &'a Value, remote: &'a str, local_dir: &'a Path) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let sftp = self.remote(id)?;
            let name = posix_basename(remote);
            // Names come from the server; one containing a separator could escape local_dir
            // (e.g. "..\\x" on Windows).
            if !is_safe_file_name(&name) {
                bail!("Refusing unsafe file name from server: \"{name}\"");
            }
            let target = local_dir.join(&name);
            let (is_dir, size) = sftp.stat(remote).await?;
            if is_dir {
                tokio::fs::create_dir_all(&target).await?;
                for child in sftp.list(remote).await? {
                    if !is_safe_file_name(&child) {
                        continue; // skip entries a hostile server crafted
                    }
                    self.download(id, transfer_id, &posix_join(remote, &child), &target).await?;
                }
                return Ok(target.to_string_lossy().into_owned());
            }
            let bus = self.bus.clone();
            let tid = transfer_id.clone();
            let n2 = name.clone();
            let step = move |done: u64, total: u64| bus.send("sftp:progress", vec![json!({ "transferId": tid, "file": n2, "done": done, "total": total })]);
            sftp.fetch(remote, &target, &step).await?;
            self.bus.send("sftp:progress", vec![json!({ "transferId": transfer_id, "file": name, "done": size, "total": size })]);
            Ok(target.to_string_lossy().into_owned())
        })
    }

    pub fn upload<'a>(&'a self, id: &'a str, transfer_id: &'a Value, local: &'a Path, remote_dir: &'a str) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let sftp = self.raw(id)?;
            let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let target = posix_join(remote_dir, &name);
            let st = tokio::fs::metadata(local).await?;
            if st.is_dir() {
                let _ = sftp.create_dir(target.clone()).await; // may already exist
                let mut rd = tokio::fs::read_dir(local).await?;
                let mut children: Vec<PathBuf> = Vec::new();
                while let Ok(Some(e)) = rd.next_entry().await {
                    children.push(e.path());
                }
                for c in children {
                    self.upload(id, transfer_id, &c, &target).await?;
                }
                return Ok(target);
            }
            let total = st.len();
            let mut src = tokio::fs::File::open(local).await?;
            let mut dst = sftp.create(target.clone()).await?;
            let mut buf = vec![0u8; 64 * 1024];
            let mut done = 0u64;
            loop {
                let n = src.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await?;
                done += n as u64;
                self.bus.send("sftp:progress", vec![json!({ "transferId": transfer_id, "file": name, "done": done, "total": total })]);
            }
            dst.shutdown().await?;
            self.bus.send("sftp:progress", vec![json!({ "transferId": transfer_id, "file": name, "done": total, "total": total })]);
            Ok(target)
        })
    }

    #[cfg(test)]
    pub fn insert_fake(&self, id: &str, remote: Arc<dyn Remote>) {
        self.sessions.lock().insert(id.to_string(), Entry { client: None, sftp: remote, raw: None });
    }
}

fn remove_remote(sftp: &SftpSession, p: String) -> BoxFuture<'_, Result<()>> {
    Box::pin(async move {
        let st = sftp.symlink_metadata(p.clone()).await?;
        if !st.is_dir() {
            sftp.remove_file(p).await?;
            return Ok(());
        }
        for e in sftp.read_dir(p.clone()).await? {
            remove_remote(sftp, posix_join(&p, &e.file_name())).await?;
        }
        sftp.remove_dir(p).await?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Remote for Fake {
        fn stat<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<(bool, u64)>> {
            Box::pin(async move { Ok((p == "/share", 2)) })
        }
        fn list<'a>(&'a self, p: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
            Box::pin(async move {
                Ok(if p == "/share" {
                    vec!["ok.txt".into(), "../evil1".into(), "..\\..\\evil2".into(), "a/../../evil3".into(), "C:evil4".into()]
                } else {
                    vec![]
                })
            })
        }
        fn fetch<'a>(&'a self, _r: &'a str, local: &'a Path, _s: &'a (dyn Fn(u64, u64) + Send + Sync)) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move {
                std::fs::write(local, "hi")?;
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn hostile_server_cannot_write_outside_the_folder() {
        let dest = crate::store::tests::tmp("sftp-dest");
        let outside = dest.parent().unwrap().to_path_buf();
        let (bus, _) = Bus::fake(|_, _| Value::Null);
        let svc = SftpService::new(bus, Arc::new(Mutex::new(Store::new(&crate::store::tests::tmp("s"), None).unwrap())));
        svc.insert_fake("s1", Arc::new(Fake));
        svc.download("s1", &json!(1), "/share", &dest).await.unwrap();
        let names: Vec<String> = std::fs::read_dir(dest.join("share")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["ok.txt"]);
        for n in ["evil1", "evil2", "evil3", "evil4"] {
            assert!(!outside.join(n).exists(), "{n}");
        }
        assert!(svc.download("s1", &json!(2), "/share/..\\..\\evil", &dest).await.unwrap_err().to_string().contains("unsafe file name"));
    }

    #[test]
    fn modes() {
        assert_eq!(mode_string(0o100644, false, false), "-rw-r--r--");
        assert_eq!(mode_string(0o755, true, false), "drwxr-xr-x");
    }
}
