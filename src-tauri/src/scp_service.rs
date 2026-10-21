// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Backs the SCP Transfer Manager: one SSH connection per manager tab (optionally through a jump
//! host), with each transfer running on its own exec channel so several can run at once.

use crate::bus::Bus;
use crate::json::{str_at, string, truthy};
use crate::proto::ssh::{Mode, SshClient, connect_client};
use crate::proto::{Ctx, Event};
use crate::scp::{self, Exec};
use crate::store::Store;
use crate::util::parse_connect_string;
use crate::xmodem::Signal;
use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct ScpService {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    conns: Mutex<HashMap<String, Arc<SshClient>>>,
    jobs: Mutex<HashMap<String, Arc<Signal>>>,
}

impl ScpService {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>) -> Arc<ScpService> {
        Arc::new(ScpService { bus, store, conns: Mutex::new(HashMap::new()), jobs: Mutex::new(HashMap::new()) })
    }

    /// `jump`: { mode: 'default'|'none'|'session'|'adhoc', id?, target? }
    pub async fn open(self: &Arc<Self>, tab_id: &str, target_ref: &Value, jump: &Value) -> Result<Value> {
        self.close(tab_id);
        let mut session = self.store.lock().resolve_session(target_ref)?;
        if str_at(&session, &["protocol"]) != "ssh2" {
            bail!("SCP needs an SSH2 session");
        }
        session["forwards"] = json!([]);
        if !session["ssh"].is_object() {
            session["ssh"] = json!({});
        }
        session["ssh"].as_object_mut().unwrap().remove("jumpSession");
        let jump_id = str_at(&session, &["ssh", "jumpSessionId"]);
        let mut via = if jump_id.is_empty() { String::new() } else { self.store.lock().session(&jump_id).map(|s| str_at(s, &["name"])).unwrap_or_default() };
        match str_at(jump, &["mode"]).as_str() {
            "none" => {
                session["ssh"]["jumpSessionId"] = json!("");
                via.clear();
            }
            "session" => {
                let j = self.store.lock().session(&str_at(jump, &["id"])).cloned().ok_or_else(|| anyhow!("Jump host session not found"))?;
                session["ssh"]["jumpSessionId"] = j["id"].clone();
                via = str_at(&j, &["name"]);
            }
            "adhoc" => {
                let target = str_at(jump, &["target"]);
                let parsed = parse_connect_string(&target)
                    .filter(|p| p["protocol"] == "ssh2")
                    .ok_or_else(|| anyhow!("Invalid jump host \"{target}\" — use user@host[:port]"))?;
                session["ssh"]["jumpSessionId"] = json!("");
                let mut j = parsed;
                j["name"] = json!(target);
                session["ssh"]["jumpSession"] = j;
                via = target;
            }
            _ => {}
        }
        let bus = self.bus.clone();
        let tid = tab_id.to_string();
        let ctx = Ctx {
            store: self.store.clone(),
            prompt: Arc::new(move |mut req: Value| {
                req["tabId"] = json!(tid);
                bus.request("prompt", req)
            }),
        };
        let (ev, mut rx) = tokio::sync::mpsc::unbounded_channel();
        {
            let me = self.clone();
            let tid = tab_id.to_string();
            let r = target_ref.clone();
            tokio::spawn(async move {
                while let Some(e) = rx.recv().await {
                    match e {
                        Event::Info(m) => me.bus.send("scp:log", vec![json!(tid), json!(m)]),
                        Event::Credentials(c) => {
                            let target = if truthy(&c["target"]) { c["target"].clone() } else { r.clone() };
                            let saved = me.store.lock().save_credentials(&target, &c);
                            match saved {
                                Ok(saved) => me.bus.send("session:saved", vec![json!(tid), json!({ "session": saved, "forTab": !truthy(&c["target"]) })]),
                                Err(e) => me.bus.send("scp:log", vec![json!(tid), json!(format!("Could not save login: {e}"))]),
                            }
                        }
                        _ => {}
                    }
                }
            });
        }
        let conn = connect_client(session.clone(), ctx, ev, Mode::Tunnel).await?;
        self.conns.lock().insert(tab_id.to_string(), conn.clone());
        {
            let me = Arc::downgrade(self);
            let tid = tab_id.to_string();
            let c = conn.clone();
            tokio::spawn(async move {
                c.wait_closed().await;
                if let Some(me) = me.upgrade() {
                    let mut conns = me.conns.lock();
                    if conns.get(&tid).is_some_and(|x| Arc::ptr_eq(x, &c)) {
                        conns.remove(&tid);
                        drop(conns);
                        me.bus.send("scp:closed", vec![json!(tid)]);
                    }
                }
            });
        }
        // Not a POSIX shell (e.g. a router): no home folder.
        let home =
            exec_text(&conn, "pwd", Duration::from_secs(5)).await.ok().and_then(|o| o.trim().split('\n').next_back().map(String::from)).unwrap_or_default();
        Ok(json!({ "host": session["host"], "port": session["port"], "username": conn.username, "via": via, "home": home }))
    }

    fn conn(&self, tab_id: &str) -> Result<Arc<SshClient>> {
        self.conns.lock().get(tab_id).cloned().ok_or_else(|| anyhow!("Not connected — click Connect first"))
    }

    fn exec_for(conn: Arc<SshClient>) -> Exec {
        Arc::new(move |cmd: String| {
            let c = conn.clone();
            Box::pin(async move { c.exec(&cmd).await })
        })
    }

    fn progress(&self, job_id: &str) -> impl Fn(Value) + Send + Sync + use<> {
        let bus = self.bus.clone();
        let job = job_id.to_string();
        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
        move |p: Value| {
            let mut l = last.lock();
            // Throttle; always send the final update.
            if !string(&p["file"]).is_empty() && l.elapsed() < Duration::from_millis(100) {
                return;
            }
            *l = Instant::now();
            let mut v = json!({ "jobId": job });
            for (k, x) in p.as_object().into_iter().flatten() {
                v[k] = x.clone();
            }
            bus.send("scp:progress", vec![v]);
        }
    }

    async fn run<F: std::future::Future<Output = Result<Value>>>(&self, job_id: &str, f: impl FnOnce(Arc<Signal>) -> F) -> Result<Value> {
        let signal = Arc::new(Signal::default());
        self.jobs.lock().insert(job_id.to_string(), signal.clone());
        let r = f(signal.clone()).await;
        self.jobs.lock().remove(job_id);
        r.map_err(|e| if signal.is_cancelled() { anyhow!("Cancelled") } else { e })
    }

    pub async fn upload(&self, tab_id: &str, job_id: &str, local_paths: Vec<PathBuf>, remote_dir: &str, opts: &Value) -> Result<Value> {
        let exec = Self::exec_for(self.conn(tab_id)?);
        let preserve = opts["preserve"] != false;
        let progress = self.progress(job_id);
        let dir = if remote_dir.is_empty() { ".".to_string() } else { remote_dir.to_string() };
        self.run(job_id, |signal| async move { scp::upload(&exec, &local_paths, &dir, preserve, signal, &progress).await }).await
    }

    pub async fn download(&self, tab_id: &str, job_id: &str, remote_path: &str, local_dir: PathBuf, opts: &Value) -> Result<Value> {
        let exec = Self::exec_for(self.conn(tab_id)?);
        let preserve = opts["preserve"] != false;
        let progress = self.progress(job_id);
        self.run(job_id, |signal| async move { scp::download(&exec, remote_path, &local_dir, preserve, signal, &progress).await }).await
    }

    pub fn cancel(&self, job_id: &str) {
        if let Some(s) = self.jobs.lock().get(job_id) {
            s.cancel();
        }
    }

    pub fn close(&self, tab_id: &str) {
        if let Some(c) = self.conns.lock().remove(tab_id) {
            c.close();
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.conns.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }
}

/// Run a command and collect its output.
pub async fn exec_text(conn: &SshClient, cmd: &str, timeout: Duration) -> Result<String> {
    let mut st = conn.exec(cmd).await?;
    let mut out = Vec::new();
    tokio::time::timeout(timeout, async {
        while let Some(d) = st.rx.recv().await {
            out.extend(d);
        }
    })
    .await
    .map_err(|_| anyhow!("timeout"))?;
    let err = st.stderr.lock().clone();
    Ok(format!("{}{}", String::from_utf8_lossy(&out), err))
}
