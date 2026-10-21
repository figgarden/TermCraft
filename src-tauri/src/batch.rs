// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Run a list of commands on many saved sessions (routers, switches, servers) without opening
//! tabs, and save each device's output to its own file: audits, config backups, "show version"
//! across a site. Works over SSH2, Telnet, Rlogin and Serial; pagers (--More--) are answered
//! automatically, so it works without vendor-specific "terminal length 0" commands.

use crate::auto_login::AutoLogin;
use crate::bus::Bus;
use crate::json::{arr, num_or, str_at, string};
use crate::proto::{self, Conn, Ctx, Event, EventTx};
use crate::store::{Store, mkdir_private, write_mode};
use crate::util::{strip_ansi, timestamp};
use anyhow::{Result, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const SUPPORTED: [&str; 5] = ["ssh2", "telnet", "rlogin", "serial", "rnsh"];
/// Shell and CLI prompts: "user@host:~$", "root@h:/#", "switch#", "router>", "[admin@fw] >", "PS C:\>".
pub static PROMPT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[#>$%\]]\s?$").unwrap());
/// A login prompt that is still showing after auto-login answered (or with nothing to answer it).
static LOGIN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:user ?name|login|password)\s*:\s*$").unwrap());
/// Pagers from IOS/NX-OS/EOS/JunOS/ProCurve/Huawei/FortiOS/less/more.
pub static PAGER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:-+\s*\(?more\b[^\n]*?\)?\s*-*|<---\s*more\s*--->|press any key to continue[^\n]*|\(END\)|---- more ----|--more--)\s*$").unwrap()
});
static CTRL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f]").unwrap());

pub fn safe_name(s: &str) -> String {
    let s = if s.is_empty() { "session" } else { s };
    let x = Regex::new(r"[^\w.@-]+").unwrap().replace_all(s, "_");
    let x: String = x.trim_matches('_').chars().take(80).collect();
    if x.is_empty() { "session".into() } else { x }
}

fn last_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let cut = s.char_indices().nth(count - n).map(|(i, _)| i).unwrap_or(0);
    &s[cut..]
}

struct PsState {
    buf: String,
    last_data: Instant,
    closed: bool,
    auto_login: Option<AutoLogin>,
}

/// Line-oriented expect over a terminal connection.
pub struct PromptSession {
    conn: Conn,
    quiet: Duration,
    stranger: Duration,
    st: Arc<Mutex<PsState>>,
}

impl PromptSession {
    pub fn new(conn: Conn, mut events: mpsc::UnboundedReceiver<Event>, auto_login: Option<AutoLogin>, encoding: &str, quiet_ms: u64) -> PromptSession {
        let st = Arc::new(Mutex::new(PsState { buf: String::new(), last_data: Instant::now(), closed: false, auto_login }));
        let s2 = st.clone();
        let c2 = conn.clone();
        let mut dec = encoding_rs::Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8).new_decoder();
        tokio::spawn(async move {
            while let Some(e) = events.recv().await {
                match e {
                    Event::Data(b) => {
                        let mut text = String::with_capacity(b.len() * 2);
                        let _ = dec.decode_to_string(&b, &mut text, false);
                        let plain = strip_ansi(&text).replace("\r\n", "\n").replace('\r', "\n");
                        let plain = CTRL_RE.replace_all(&plain, "").into_owned();
                        let mut st = s2.lock();
                        st.buf.push_str(&plain);
                        st.last_data = Instant::now();
                        if let Some(answer) = st.auto_login.as_mut().and_then(|a| a.feed(&plain)) {
                            c2.write(answer.into_bytes());
                            continue;
                        }
                        let tail = last_chars(&st.buf, 120).to_string();
                        if let Some(m) = PAGER_RE.find(&tail) {
                            let keep = st.buf.len() - tail.len() + m.start();
                            st.buf.truncate(keep);
                            let trimmed = st.buf.trim_end_matches([' ', '\t']).len();
                            st.buf.truncate(trimmed);
                            c2.write(b" ".to_vec());
                        }
                    }
                    Event::Close => {
                        s2.lock().closed = true;
                        break;
                    }
                    _ => {}
                }
            }
            s2.lock().closed = true;
        });
        PromptSession { conn, quiet: Duration::from_millis(quiet_ms), stranger: Duration::from_millis(5000), st }
    }

    pub fn last_line(&self) -> String {
        self.st.lock().buf.rsplit('\n').next().unwrap_or("").trim_end().to_string()
    }

    pub fn buf(&self) -> String {
        self.st.lock().buf.clone()
    }

    /// Wait until output is quiet and the last line looks like a prompt. Once the device's
    /// prompt is known (`expect`), a line starting with the same hostname ("sw1#",
    /// "sw1(config)#") counts after the quiet time; any other prompt-like line needs a longer
    /// pause, so slow output isn't cut short.
    pub async fn wait_prompt(&self, timeout: Duration, nudge_after: Option<Duration>, cancelled: &AtomicBool, expect: &str) -> Result<String> {
        let stem_src = Regex::new(r"[#>$%\]]\s?$").unwrap().replace(expect, "").into_owned();
        let stem = stem_src.split(['(', ':', ' ', '\t', '\n']).next().unwrap_or("").to_string();
        let start = Instant::now();
        let mut nudged = false;
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tick.tick().await;
            if cancelled.load(Ordering::SeqCst) {
                bail!("Cancelled");
            }
            let (idle, closed, login_done, empty) = {
                let st = self.st.lock();
                (st.last_data.elapsed(), st.closed, st.auto_login.as_ref().is_none_or(|a| a.done()), st.buf.trim().is_empty())
            };
            if closed {
                bail!("Connection closed");
            }
            let quiet = idle >= self.quiet;
            let line = self.last_line();
            let known = !stem.is_empty() && line.starts_with(&stem);
            let need = if known {
                self.quiet
            } else if !stem.is_empty() {
                self.stranger
            } else {
                self.quiet
            };
            if PROMPT_RE.is_match(&line) && login_done && idle >= need {
                return Ok(line);
            }
            if quiet && LOGIN_RE.is_match(&line) && login_done {
                let had = self.st.lock().auto_login.is_some();
                bail!(if had {
                    "Login failed (the device asked for the login again)"
                } else {
                    "The device asks for a login: add a username and password, or a credential, to the session"
                });
            }
            // Consoles often print nothing until Enter is pressed.
            if let Some(n) = nudge_after {
                if !nudged && start.elapsed() > n && quiet && empty {
                    nudged = true;
                    self.conn.write(b"\r".to_vec());
                }
            }
            if start.elapsed() > timeout {
                let l = self.last_line();
                bail!("Timed out waiting for a prompt (last output: \"{}\")", last_chars(&l, 60));
            }
        }
    }

    /// Send one command and return (output without the echoed command and final prompt, prompt).
    pub async fn run(&self, command: &str, timeout: Duration, cancelled: &AtomicBool, expect: &str) -> Result<(String, String)> {
        {
            let mut st = self.st.lock();
            st.buf.clear();
            // Make sure the device has started answering before treating quiet as "done".
            st.last_data = Instant::now();
        }
        self.conn.write(format!("{command}\r").into_bytes());
        let prompt = self.wait_prompt(timeout, None, cancelled, expect).await?;
        let buf = self.buf();
        let mut lines: Vec<&str> = buf.split('\n').collect();
        lines.pop(); // the prompt
        if lines.first().is_some_and(|l| l.trim().ends_with(command.trim())) {
            lines.remove(0); // echo
        }
        Ok((lines.join("\n").trim_end().to_string(), prompt))
    }
}

pub type Connect = Arc<dyn Fn(Value, Ctx, EventTx) -> BoxFuture<'static, Result<Conn>> + Send + Sync>;

struct Run {
    cancelled: AtomicBool,
    conns: Mutex<Vec<Conn>>,
    names: Mutex<HashSet<String>>,
}

pub struct BatchRunner {
    bus: Bus,
    store: Arc<Mutex<Store>>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
    connect: Connect,
    quiet_ms: u64,
}

impl BatchRunner {
    pub fn new(bus: Bus, store: Arc<Mutex<Store>>, connect: Option<Connect>) -> Arc<BatchRunner> {
        let connect = connect.unwrap_or_else(|| Arc::new(|s, ctx, ev| Box::pin(proto::connect(s, ctx, 250, 50, ev))));
        Arc::new(BatchRunner { bus, store, runs: Mutex::new(HashMap::new()), connect, quiet_ms: 600 })
    }

    pub async fn start(self: &Arc<Self>, run_id: &str, opts: &Value, output_dir: PathBuf) -> Result<Value> {
        let commands: Vec<String> = arr(&opts["commands"]).iter().map(string).filter(|c| !c.trim().is_empty()).collect();
        if commands.is_empty() {
            bail!("Enter at least one command");
        }
        let mut seen = HashSet::new();
        let ids: Vec<String> = arr(&opts["sessionIds"]).iter().map(string).filter(|i| seen.insert(i.clone())).collect();
        if ids.is_empty() {
            bail!("Choose at least one session");
        }
        let run = Arc::new(Run { cancelled: AtomicBool::new(false), conns: Mutex::new(vec![]), names: Mutex::new(HashSet::new()) });
        self.runs.lock().insert(run_id.to_string(), run.clone());
        mkdir_private(&output_dir)?;
        let timeout = Duration::from_secs_f64(num_or(&opts["timeoutSec"], 60.0).max(5.0));
        let queue = Arc::new(Mutex::new(ids.iter().cloned().collect::<VecDeque<String>>()));
        let results = Arc::new(Mutex::new(Vec::<bool>::new()));
        let n = (num_or(&opts["concurrency"], 5.0).max(1.0) as usize).min(20).min(ids.len());
        let commands = Arc::new(commands);
        let mut workers = Vec::new();
        for _ in 0..n {
            let (me, run, queue, results, commands, dir, rid) =
                (self.clone(), run.clone(), queue.clone(), results.clone(), commands.clone(), output_dir.clone(), run_id.to_string());
            workers.push(tokio::spawn(async move {
                loop {
                    if run.cancelled.load(Ordering::SeqCst) {
                        break;
                    }
                    let Some(id) = queue.lock().pop_front() else { break };
                    let ok = me.run_one(&rid, &run, &id, &commands, timeout, &dir).await;
                    results.lock().push(ok);
                }
            }));
        }
        for w in workers {
            let _ = w.await;
        }
        for id in queue.lock().drain(..) {
            self.bus.send("batch:update", vec![json!(run_id), json!({ "sessionId": id, "state": "cancelled" })]);
        }
        self.runs.lock().remove(run_id);
        let r = results.lock();
        let summary = json!({
            "ok": r.iter().filter(|x| **x).count(),
            "failed": r.iter().filter(|x| !**x).count(),
            "cancelled": run.cancelled.load(Ordering::SeqCst),
            "outputDir": output_dir.to_string_lossy(),
        });
        self.bus.send("batch:done", vec![json!(run_id), summary.clone()]);
        Ok(summary)
    }

    async fn run_one(&self, run_id: &str, run: &Arc<Run>, id: &str, commands: &[String], timeout: Duration, dir: &Path) -> bool {
        let update = |st: Value| {
            let mut v = json!({ "sessionId": id });
            for (k, x) in st.as_object().into_iter().flatten() {
                v[k] = x.clone();
            }
            self.bus.send("batch:update", vec![json!(run_id), v]);
        };
        let started = Instant::now();
        let mut transcript = String::new();
        let mut session: Option<Value> = None;
        let mut conn: Option<Conn> = None;
        let res: Result<()> = async {
            let mut s = self.store.lock().resolve_session(&json!(id))?;
            session = Some(s.clone());
            let protocol = str_at(&s, &["protocol"]);
            if !SUPPORTED.contains(&protocol.as_str()) {
                bail!("{protocol} sessions can't run commands");
            }
            update(json!({ "state": "connecting" }));
            // A quiet, tab-less connection: no forwards, X11, agent forwarding or logging.
            s["forwards"] = json!([]);
            if !s["ssh"].is_object() {
                s["ssh"] = json!({});
            }
            s["ssh"]["x11"] = json!(false);
            s["ssh"]["agentForward"] = json!(false);
            let name = str_at(&s, &["name"]);
            let bus = self.bus.clone();
            let ctx = Ctx {
                store: self.store.clone(),
                prompt: Arc::new(move |mut req: Value| {
                    let title = if str_at(&req, &["title"]).is_empty() { "Login".to_string() } else { str_at(&req, &["title"]) };
                    req["title"] = json!(format!("{title} — {name}"));
                    bus.request("prompt", req)
                }),
            };
            let (ev, rx) = mpsc::unbounded_channel();
            let c = (self.connect)(s.clone(), ctx, ev).await?;
            conn = Some(c.clone());
            run.conns.lock().push(c.clone());
            let io = PromptSession::new(c, rx, AutoLogin::new(&s), &str_at(&s, &["terminal", "encoding"]), self.quiet_ms);
            if run.cancelled.load(Ordering::SeqCst) {
                bail!("Cancelled");
            }
            update(json!({ "state": "running", "step": "waiting for prompt" }));
            io.wait_prompt(timeout.max(Duration::from_secs(30)), Some(Duration::from_secs(3)), &run.cancelled, "").await?;
            let mut prompt = io.last_line();
            let buf = io.buf();
            let mut lines: Vec<&str> = buf.split('\n').collect();
            lines.pop();
            let banner = lines.join("\n").trim().to_string();
            transcript = if banner.is_empty() { String::new() } else { format!("{banner}\n") };
            for (i, cmd) in commands.iter().enumerate() {
                update(json!({ "state": "running", "step": format!("{}/{}: {cmd}", i + 1, commands.len()) }));
                let (output, next) = io.run(cmd, timeout, &run.cancelled, &prompt).await?;
                transcript.push_str(&format!("{prompt} {cmd}\n{output}\n"));
                prompt = next;
            }
            Ok(())
        }
        .await;
        if let Some(c) = conn {
            c.close();
        }
        let ms = started.elapsed().as_millis() as u64;
        let preview = last_chars(&transcript, 4000).to_string();
        match res {
            Ok(()) => {
                let file = self.save(run, dir, session.as_ref().unwrap(), &transcript, None);
                update(json!({ "state": "done", "ms": ms, "file": file, "preview": preview }));
                true
            }
            Err(e) => {
                let cancelled = run.cancelled.load(Ordering::SeqCst);
                let msg = if cancelled { "Cancelled".to_string() } else { e.to_string() };
                let file = match (&session, transcript.is_empty()) {
                    (Some(s), false) => self.save(run, dir, s, &transcript, Some(&msg)),
                    _ => String::new(),
                };
                update(json!({ "state": if cancelled { "cancelled" } else { "failed" }, "error": msg, "ms": ms, "file": file, "preview": preview }));
                false
            }
        }
    }

    fn save(&self, run: &Run, dir: &Path, session: &Value, transcript: &str, error: Option<&str>) -> String {
        let mut base = safe_name(&str_at(session, &["name"]));
        {
            let mut names = run.names.lock();
            if names.contains(&base) {
                base = format!("{base}_{}", safe_name(&str_at(session, &["id"])));
            }
            names.insert(base.clone());
        }
        let file = dir.join(format!("{base}.txt"));
        let target = match str_at(session, &["protocol"]).as_str() {
            "serial" => str_at(session, &["serial", "path"]),
            "rnsh" => format!("rnsh {}", str_at(session, &["host"])),
            _ => format!("{}:{}", str_at(session, &["host"]), string(&session["port"])),
        };
        let head =
            format!("# {} ({target}) — {}{}\n\n", str_at(session, &["name"]), timestamp(), error.map(|e| format!("\n# FAILED: {e}")).unwrap_or_default());
        let body = if cfg!(windows) { transcript.replace('\n', "\r\n") } else { transcript.to_string() };
        let _ = write_mode(&file, format!("{head}{body}").as_bytes(), 0o600);
        file.to_string_lossy().into_owned()
    }

    pub fn cancel(&self, run_id: &str) {
        let Some(run) = self.runs.lock().get(run_id).cloned() else { return };
        run.cancelled.store(true, Ordering::SeqCst);
        for c in run.conns.lock().iter() {
            c.close();
        }
    }

    pub fn cancel_all(&self) {
        let ids: Vec<String> = self.runs.lock().keys().cloned().collect();
        for id in ids {
            self.cancel(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::Ctl;

    /// A fake Cisco-like CLI: login, pager, config mode, slow commands.
    fn fake_device(hostname: &str, login: bool) -> (Conn, mpsc::UnboundedReceiver<Event>, Arc<Mutex<Vec<String>>>) {
        let (ev, rx) = mpsc::unbounded_channel::<Event>();
        let (tx, mut ctl) = mpsc::unbounded_channel::<Ctl>();
        let got: Arc<Mutex<Vec<String>>> = Default::default();
        let g = got.clone();
        let host = hostname.to_string();
        tokio::spawn(async move {
            let out = |s: String, delay: u64| {
                let ev = ev.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let _ = ev.send(Event::Data(s.into_bytes()));
                });
            };
            let mut config = false;
            let prompt = |config: bool| format!("{host}{}", if config { "(config)#" } else { "#" });
            let mut stage = if login { "user" } else { "cli" };
            let mut user = String::new();
            let mut line = String::new();
            let mut pages: Option<VecDeque<String>> = None;
            out(if login { "\r\nUser Access Verification\r\n\r\nUsername: ".to_string() } else { format!("\r\n{}", prompt(config)) }, 5);
            let page = |pages: &mut Option<VecDeque<String>>, config: bool| {
                let p = pages.as_mut().unwrap().pop_front().unwrap();
                if pages.as_ref().unwrap().is_empty() {
                    *pages = None;
                    out(format!("{p}{}", prompt(config)), 5);
                } else {
                    out(format!("{p} --More-- "), 5);
                }
            };
            while let Some(c) = ctl.recv().await {
                let Ctl::Write(d) = c else {
                    if let Ctl::Close = c {
                        let _ = ev.send(Event::Close);
                        break;
                    }
                    continue;
                };
                for ch in String::from_utf8_lossy(&d).chars() {
                    if pages.is_some() {
                        if ch == ' ' {
                            page(&mut pages, config);
                        }
                        continue;
                    }
                    if ch != '\r' {
                        line.push(ch);
                        if stage != "pass" {
                            out(ch.to_string(), 0);
                        }
                        continue;
                    }
                    let cmd = std::mem::take(&mut line);
                    g.lock().push(cmd.clone());
                    if stage == "user" {
                        user = cmd;
                        stage = "pass";
                        out("\r\nPassword: ".into(), 5);
                        continue;
                    }
                    if stage == "pass" {
                        stage = if cmd == "secret" && user == "netops" { "cli" } else { "user" };
                        out(if stage == "cli" { format!("\r\n{}", prompt(config)) } else { "\r\n% Login invalid\r\nUsername: ".into() }, 5);
                        continue;
                    }
                    match cmd.as_str() {
                        "show run" => {
                            pages = Some(VecDeque::from(vec!["line 1\r\nline 2\r\n".to_string(), "line 3\r\nline 4\r\n".into(), "end\r\n".into()]));
                            out("\r\n".into(), 5);
                            page(&mut pages, config);
                        }
                        "conf t" => {
                            config = true;
                            out(format!("\r\nEnter configuration commands, one per line.\r\n{}", prompt(config)), 5);
                        }
                        "end" => {
                            config = false;
                            out(format!("\r\n{}", prompt(config)), 5);
                        }
                        "ping 10.0.0.9" => {
                            out("\r\nType escape sequence to abort.\r\nSending 5, 100-byte ICMP Echos, timeout is 2 seconds: >".into(), 5);
                            out(format!("\r\n!!!!!\r\nSuccess rate is 100 percent (5/5)\r\n{}", prompt(config)), 1500);
                        }
                        _ => out(format!("\r\n% output of {cmd}\r\n{}", prompt(config)), 5),
                    }
                }
            }
        });
        (Conn::new(tx, String::new()), rx, got)
    }

    #[tokio::test]
    async fn logs_in_answers_pager_follows_config_prompts_waits_for_slow_output() {
        let (conn, rx, got) = fake_device("core-sw-01", true);
        let session = json!({ "protocol": "telnet", "username": "netops", "auth": { "password": "secret" } });
        let io = PromptSession::new(conn, rx, AutoLogin::new(&session), "utf-8", 200);
        let no = AtomicBool::new(false);
        let prompt = io.wait_prompt(Duration::from_secs(5), None, &no, "").await.unwrap();
        assert_eq!(prompt, "core-sw-01#");
        assert_eq!(got.lock()[..2], ["netops".to_string(), "secret".to_string()]);
        let (out, _) = io.run("show run", Duration::from_secs(5), &no, &prompt).await.unwrap();
        assert_eq!(out, "line 1\nline 2\nline 3\nline 4\nend");
        let (_, conf) = io.run("conf t", Duration::from_secs(5), &no, &prompt).await.unwrap();
        assert_eq!(conf, "core-sw-01(config)#");
        io.run("end", Duration::from_secs(5), &no, &conf).await.unwrap();
        let (ping, _) = io.run("ping 10.0.0.9", Duration::from_secs(8), &no, &prompt).await.unwrap();
        assert!(ping.contains("Success rate is 100 percent"), "did not stop at the \">\" in the middle of ping output");
    }

    #[test]
    fn pager_patterns() {
        for p in [" --More-- ", "-- More --", "<--- More --->", "--More--(42%)", "---- More ----", "Press any key to continue (Q to quit)", "(END)"] {
            assert!(PAGER_RE.is_match(&format!("some output\n{p}")), "{p}");
        }
        assert!(!PAGER_RE.is_match("show more details\nrouter#"));
    }

    #[tokio::test]
    async fn runner_saves_one_file_per_device_and_reports_failures() {
        let dir = crate::store::tests::tmp("batch");
        let store = Arc::new(Mutex::new(Store::new(&dir.join("data"), None).unwrap()));
        for s in [
            json!({ "id": "a", "name": "core-sw-01", "protocol": "telnet", "host": "10.0.0.1", "port": 23, "username": "netops", "auth": { "password": "secret" } }),
            json!({ "id": "b", "name": "edge/rtr", "protocol": "telnet", "host": "10.0.0.2", "port": 23, "username": "netops", "auth": { "password": "wrong" } }),
            json!({ "id": "c", "name": "desk-mac", "protocol": "vnc", "host": "10.0.0.3", "port": 5900, "auth": {} }),
        ] {
            store.lock().save_session(&s).unwrap();
        }
        let (bus, events) = Bus::fake(|_, _| Value::Null);
        let connect: Connect = Arc::new(|s, _ctx, ev| {
            Box::pin(async move {
                let host: String = str_at(&s, &["name"]).chars().filter(|c| c.is_alphanumeric()).collect();
                let (conn, mut rx, _) = fake_device(&host, true);
                tokio::spawn(async move {
                    while let Some(e) = rx.recv().await {
                        let _ = ev.send(e);
                    }
                });
                Ok(conn)
            })
        });
        let runner = BatchRunner::new(bus, store, Some(connect));
        let out = dir.join("out");
        let summary = runner.start("r1", &json!({ "sessionIds": ["a", "b", "c"], "commands": ["show ver"], "timeoutSec": 5 }), out.clone()).await.unwrap();
        assert_eq!(summary["ok"], 1);
        assert_eq!(summary["failed"], 2);
        let text = std::fs::read_to_string(out.join("core-sw-01.txt")).unwrap().replace("\r\n", "\n");
        assert!(Regex::new(r"# core-sw-01 \(10\.0\.0\.1:23\)").unwrap().is_match(&text));
        assert!(text.contains("coresw01# show ver\n% output of show ver"), "{text}");
        assert!(!text.contains("secret"), "password never appears in the transcript");
        let mut failed: Vec<String> =
            events.lock().iter().filter(|(ch, a)| ch == "batch:update" && a[1]["state"] == "failed").map(|(_, a)| string(&a[1]["sessionId"])).collect();
        failed.sort();
        assert_eq!(failed, vec!["b", "c"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(out.join("core-sw-01.txt")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
