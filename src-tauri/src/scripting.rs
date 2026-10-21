// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Runs JavaScript automation scripts (QuickJS) against the `tc` object model (also available as
//! `crt`, for compatibility with scripts written for other terminal emulators). Each script runs
//! on its own thread; calls that wait on the remote side or the window block that thread, so
//! scripts can `await` them (scripts run inside an async function: top-level await works) or
//! call them directly.

use crate::bus::Bus;
use crate::conn_manager::Manager;
use crate::json::{arr, string};
use crate::store::Store;
use crate::util::{expand_escapes, expand_tilde, home, platform};
use anyhow::{Result, anyhow};
use base64::Engine;
use parking_lot::Mutex;
use rquickjs::{Context, Ctx, Exception, Function, Runtime};
use serde_json::{Value, json};
use sha2::Digest;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

const PRELUDE: &str = include_str!("script_prelude.js");

/// What a script can reach in the backend.
pub trait Host: Send + Sync {
    fn write(&self, tab: &str, data: &str) -> bool;
    fn send_break(&self, tab: &str);
    fn wait_for(&self, tab: &str, patterns: Vec<String>, timeout_ms: u64) -> (i64, String);
    fn state(&self, tab: &str) -> Option<String>;
    fn session(&self, tab: &str) -> Option<Value>;
    fn disconnect(&self, tab: &str);
    fn log(&self, tab: &str, start: bool, file: Option<String>) -> Option<String>;
    fn info(&self, tab: &str, msg: &str);
    fn request(&self, kind: &str, payload: Value) -> Value;
    fn store_tree(&self) -> Value;
}

/// The real host: the connection manager and the window, driven from the script's thread.
pub struct AppHost {
    pub manager: Arc<Manager>,
    pub bus: Bus,
    pub store: Arc<Mutex<Store>>,
    pub rt: tokio::runtime::Handle,
}

impl Host for AppHost {
    fn write(&self, tab: &str, data: &str) -> bool {
        self.manager.write(tab, data, true)
    }
    fn send_break(&self, tab: &str) {
        self.manager.send_break(tab)
    }
    fn wait_for(&self, tab: &str, patterns: Vec<String>, timeout_ms: u64) -> (i64, String) {
        self.rt.block_on(self.manager.wait_for(tab, patterns, timeout_ms))
    }
    fn state(&self, tab: &str) -> Option<String> {
        self.manager.state(tab)
    }
    fn session(&self, tab: &str) -> Option<Value> {
        self.manager.session_of(tab).map(|s| json!({ "host": s["host"], "name": s["name"] }))
    }
    fn disconnect(&self, tab: &str) {
        self.manager.close(tab, false)
    }
    fn log(&self, tab: &str, start: bool, file: Option<String>) -> Option<String> {
        if start {
            self.manager.start_log(tab, file)
        } else {
            self.manager.stop_log(tab);
            None
        }
    }
    fn info(&self, tab: &str, msg: &str) {
        if !tab.is_empty() {
            self.manager.info(tab, &format!("[script] {msg}"), 36);
        }
    }
    fn request(&self, kind: &str, payload: Value) -> Value {
        self.rt.block_on(self.bus.request(kind, payload))
    }
    fn store_tree(&self) -> Value {
        self.store.lock().tree()
    }
}

struct Run {
    /// Cancel: interrupts the script wherever it is.
    cancelled: Arc<AtomicBool>,
}

pub struct ScriptEngine {
    host: Arc<dyn Host>,
    running: Mutex<HashMap<u64, Run>>,
    seq: AtomicU64,
}

fn js_err(ctx: &Ctx<'_>, e: impl std::fmt::Display) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

fn sh(cmd: &str) -> std::process::Command {
    if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", cmd]);
        c
    }
}

fn run_output(mut cmd: std::process::Command, cwd: &Value) -> Result<std::process::Output> {
    if let Some(d) = cwd.as_str() {
        cmd.current_dir(expand_tilde(d));
    }
    Ok(cmd.stdin(std::process::Stdio::null()).output()?)
}

impl ScriptEngine {
    pub fn new(host: Arc<dyn Host>) -> Arc<ScriptEngine> {
        Arc::new(ScriptEngine { host, running: Mutex::new(HashMap::new()), seq: AtomicU64::new(0) })
    }

    pub fn cancel_all(&self) {
        for r in self.running.lock().values() {
            r.cancelled.store(true, Ordering::SeqCst);
        }
    }

    /// Run a script file. Resolves when it finishes; fails with the script's error.
    pub async fn run(self: &Arc<Self>, file: &str, tab_id: Option<String>, args: Vec<String>) -> Result<()> {
        let code = tokio::fs::read_to_string(file).await.map_err(|e| anyhow!("{file}: {e}"))?;
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.running.lock().insert(id, Run { cancelled: cancelled.clone() });
        let (tx, rx) = tokio::sync::oneshot::channel();
        let host = self.host.clone();
        let file = file.to_string();
        std::thread::Builder::new().name("termcraft-script".into()).stack_size(8 * 1024 * 1024).spawn(move || {
            let r = execute(host, &file, &code, tab_id, args, cancelled);
            let _ = tx.send(r);
        })?;
        let r = rx.await.unwrap_or_else(|_| Err(anyhow!("Script stopped")));
        self.running.lock().remove(&id);
        r
    }
}

fn execute(host: Arc<dyn Host>, file: &str, code: &str, tab_id: Option<String>, args: Vec<String>, cancelled: Arc<AtomicBool>) -> Result<()> {
    let rt = Runtime::new()?;
    let c2 = cancelled.clone();
    rt.set_interrupt_handler(Some(Box::new(move || c2.load(Ordering::SeqCst))));
    let context = Context::full(&rt)?;
    let quit = Arc::new(AtomicBool::new(false));
    let tab = tab_id.clone().unwrap_or_default();
    let dirname = Path::new(file).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let info = json!({
        "tabId": tab_id, "file": file, "args": args, "version": env!("CARGO_PKG_VERSION"), "dirname": dirname,
        "platform": platform(), "home": home().to_string_lossy(), "tmpdir": std::env::temp_dir().to_string_lossy(),
        "hostname": whoami::fallible::hostname().unwrap_or_default(), "username": whoami::username(),
        "cwd": std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    });

    let result: Result<()> = context.with(|ctx| {
        let h = host.clone();
        let q = quit.clone();
        let cx = cancelled.clone();
        let native = Function::new(ctx.clone(), move |ctx: Ctx<'_>, name: String, args: String| -> rquickjs::Result<String> {
            let a: Vec<Value> = serde_json::from_str(&args).unwrap_or_default();
            let s = |i: usize| a.get(i).map(string).unwrap_or_default();
            let tab_of = |i: usize| a.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let out: Value = match name.as_str() {
                "context" => info.clone(),
                "quit" => json!(q.load(Ordering::SeqCst) || cx.load(Ordering::SeqCst)),
                "setQuit" => {
                    q.store(true, Ordering::SeqCst);
                    Value::Null
                }
                "send" => json!(h.write(&tab_of(0), &s(1))),
                "sendBreak" => {
                    h.send_break(&tab_of(0));
                    Value::Null
                }
                "expandEscapes" => json!(expand_escapes(&s(0))),
                "waitFor" => {
                    let pats: Vec<String> = arr(&a[1]).iter().map(string).collect();
                    let ms = a.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0) as u64;
                    let (i, before) = h.wait_for(&tab_of(0), pats, ms);
                    json!([i, before])
                }
                "state" => json!(h.state(&tab_of(0))),
                "session" => h.session(&tab_of(0)).unwrap_or(Value::Null),
                "disconnect" => {
                    h.disconnect(&tab_of(0));
                    Value::Null
                }
                "log" => json!(h.log(&tab_of(0), a.get(1).and_then(|v| v.as_bool()).unwrap_or(true), a.get(2).and_then(|v| v.as_str()).map(String::from))),
                "output" => {
                    h.info(&tab, &s(0));
                    Value::Null
                }
                "request" => h.request(&s(0), a.get(1).cloned().unwrap_or(Value::Null)),
                "storeTree" => h.store_tree(),
                "sleep" => {
                    let mut left = a.first().and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0) as u64;
                    while left > 0 && !cx.load(Ordering::SeqCst) {
                        let step = left.min(50);
                        std::thread::sleep(Duration::from_millis(step));
                        left -= step;
                    }
                    Value::Null
                }
                "clipboardGet" => json!(arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()),
                "clipboardSet" => {
                    if let Ok(mut c) = arboard::Clipboard::new() {
                        let _ = c.set_text(s(0));
                    }
                    Value::Null
                }
                "fs.read" => json!(std::fs::read_to_string(expand_tilde(&s(0))).map_err(|e| js_err(&ctx, format!("{}: {e}", s(0))))?),
                "fs.write" => {
                    let p = PathBuf::from(expand_tilde(&s(0)));
                    let r = if a.get(2).and_then(|v| v.as_bool()).unwrap_or(false) {
                        use std::io::Write;
                        std::fs::OpenOptions::new().create(true).append(true).open(&p).and_then(|mut f| f.write_all(s(1).as_bytes()))
                    } else {
                        std::fs::write(&p, s(1))
                    };
                    r.map_err(|e| js_err(&ctx, format!("{}: {e}", s(0))))?;
                    Value::Null
                }
                "fs.exists" => json!(Path::new(&expand_tilde(&s(0))).exists()),
                "fs.mkdir" => {
                    let p = expand_tilde(&s(0));
                    let r = if a.get(1).and_then(|v| v.as_bool()).unwrap_or(false) { std::fs::create_dir_all(&p) } else { std::fs::create_dir(&p) };
                    r.map_err(|e| js_err(&ctx, format!("{p}: {e}")))?;
                    Value::Null
                }
                "fs.readdir" => {
                    let mut names: Vec<String> = std::fs::read_dir(expand_tilde(&s(0))).map_err(|e| js_err(&ctx, format!("{}: {e}", s(0))))?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                    names.sort();
                    json!(names)
                }
                "fs.rm" => {
                    let p = expand_tilde(&s(0));
                    let r = if Path::new(&p).is_dir() && a.get(1).and_then(|v| v.as_bool()).unwrap_or(false) { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                    r.map_err(|e| js_err(&ctx, format!("{p}: {e}")))?;
                    Value::Null
                }
                "fs.rename" => {
                    std::fs::rename(expand_tilde(&s(0)), expand_tilde(&s(1))).map_err(|e| js_err(&ctx, e))?;
                    Value::Null
                }
                "fs.stat" => {
                    let m = std::fs::metadata(expand_tilde(&s(0))).map_err(|e| js_err(&ctx, format!("{}: {e}", s(0))))?;
                    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                    json!({ "size": m.len(), "dir": m.is_dir(), "file": m.is_file(), "mtimeMs": mtime })
                }
                "cp.exec" => {
                    let o = run_output(sh(&s(0)), a.get(1).unwrap_or(&Value::Null)).map_err(|e| js_err(&ctx, e))?;
                    if !o.status.success() {
                        return Err(js_err(&ctx, format!("Command failed: {}\n{}", s(0), String::from_utf8_lossy(&o.stderr))));
                    }
                    json!(String::from_utf8_lossy(&o.stdout))
                }
                "cp.execFile" | "cp.spawn" => {
                    let mut cmd = std::process::Command::new(s(0));
                    cmd.args(arr(&a[1]).iter().map(string));
                    let o = run_output(cmd, a.get(2).unwrap_or(&Value::Null));
                    if name == "cp.spawn" {
                        match o {
                            Ok(o) => json!({ "status": o.status.code(), "stdout": String::from_utf8_lossy(&o.stdout), "stderr": String::from_utf8_lossy(&o.stderr) }),
                            Err(e) => json!({ "status": null, "error": e.to_string(), "stdout": "", "stderr": "" }),
                        }
                    } else {
                        let o = o.map_err(|e| js_err(&ctx, e))?;
                        if !o.status.success() {
                            return Err(js_err(&ctx, format!("Command failed: {}\n{}", s(0), String::from_utf8_lossy(&o.stderr))));
                        }
                        json!(String::from_utf8_lossy(&o.stdout))
                    }
                }
                "crypto.random" => {
                    let n = a.first().and_then(|v| v.as_u64()).unwrap_or(0).min(1 << 20) as usize;
                    json!(hex::encode((0..n).map(|_| rand::random::<u8>()).collect::<Vec<u8>>()))
                }
                "crypto.uuid" => {
                    let mut b: [u8; 16] = rand::random();
                    b[6] = (b[6] & 0x0f) | 0x40;
                    b[8] = (b[8] & 0x3f) | 0x80;
                    let h = hex::encode(b);
                    json!(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
                }
                "crypto.hash" => {
                    let data = s(1);
                    json!(match s(0).to_lowercase().as_str() {
                        "sha256" => hex::encode(sha2::Sha256::digest(data.as_bytes())),
                        "sha512" => hex::encode(sha2::Sha512::digest(data.as_bytes())),
                        "sha1" => hex::encode(sha1::Sha1::digest(data.as_bytes())),
                        "md5" => hex::encode(md5::Md5::digest(data.as_bytes())),
                        other => return Err(js_err(&ctx, format!("Digest method not supported: {other}"))),
                    })
                }
                "crypto.b64" => json!(base64::engine::general_purpose::STANDARD.encode(hex::decode(s(0)).unwrap_or_default())),
                other => return Err(js_err(&ctx, format!("Unknown call {other}"))),
            };
            Ok(out.to_string())
        })?;
        ctx.globals().set("__native", native)?;
        ctx.eval::<(), _>(PRELUDE).map_err(|e| anyhow!("prelude: {}", describe(&ctx, e)))?;
        let wrapped = format!(
            "globalThis.__done = 0; (async () => {{\n{code}\n}})().then(() => {{ globalThis.__done = 1; }}, (e) => {{ globalThis.__done = 2; globalThis.__err = e && e.stack ? `${{e.message}}\\n${{e.stack}}` : String(e); }});"
        );
        ctx.eval::<(), _>(wrapped).map_err(|e| anyhow!(describe(&ctx, e)))?;
        Ok(())
    });
    result.map_err(|e| if cancelled.load(Ordering::SeqCst) { anyhow!("Script cancelled") } else { e })?;

    // Event loop: promise jobs, then timers, until the script's promise settles and no timers
    // are left.
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(anyhow!("Script cancelled"));
        }
        loop {
            match rt.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(_) => {
                    if cancelled.load(Ordering::SeqCst) {
                        return Err(anyhow!("Script cancelled"));
                    }
                    break;
                }
            }
        }
        let (done, err, next): (i32, Option<String>, f64) = context.with(|ctx| {
            let g = ctx.globals();
            let done: i32 = g.get("__done").unwrap_or(0);
            let err: Option<String> = g.get("__err").ok();
            let next: f64 = ctx.eval("__nextTimer()").unwrap_or(-1.0);
            (done, err, next)
        });
        if done == 2 {
            return Err(anyhow!(err.unwrap_or_else(|| "Script failed".into())));
        }
        if next < 0.0 {
            if done == 1 {
                return Ok(());
            }
            if !rt.is_job_pending() {
                // Nothing left that could finish the script (e.g. an await on a promise that
                // never settles).
                return Ok(());
            }
            continue;
        }
        let mut left = next as u64;
        while left > 0 && !cancelled.load(Ordering::SeqCst) {
            let step = left.min(50);
            std::thread::sleep(Duration::from_millis(step));
            left -= step;
        }
        let r: Result<()> = context.with(|ctx| ctx.eval::<(), _>("__runTimers()").map_err(|e| anyhow!(describe(&ctx, e))));
        if let Err(e) = r {
            return Err(if cancelled.load(Ordering::SeqCst) { anyhow!("Script cancelled") } else { e });
        }
    }
}

/// A readable message for a JS exception.
fn describe(ctx: &Ctx<'_>, e: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = e {
        let v = ctx.catch();
        if let Some(ex) = v.as_exception() {
            let msg = ex.message().unwrap_or_default();
            let stack = ex.stack().unwrap_or_default();
            return if stack.is_empty() { msg } else { format!("{msg}\n{stack}") };
        }
        if let Some(s) = v.as_string() {
            return s.to_string().unwrap_or_default();
        }
        return format!("{v:?}");
    }
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        sent: Mutex<Vec<String>>,
        requests: Mutex<Vec<String>>,
        info: Mutex<Vec<String>>,
    }

    impl Host for Fake {
        fn write(&self, _tab: &str, data: &str) -> bool {
            self.sent.lock().push(data.to_string());
            true
        }
        fn send_break(&self, _tab: &str) {}
        fn wait_for(&self, _tab: &str, patterns: Vec<String>, _ms: u64) -> (i64, String) {
            (patterns.len() as i64 - 1, "output-before".into())
        }
        fn state(&self, _tab: &str) -> Option<String> {
            Some("connected".into())
        }
        fn session(&self, _tab: &str) -> Option<Value> {
            Some(json!({ "host": "h", "name": "n" }))
        }
        fn disconnect(&self, _tab: &str) {}
        fn log(&self, _tab: &str, _start: bool, _file: Option<String>) -> Option<String> {
            None
        }
        fn info(&self, _tab: &str, msg: &str) {
            self.info.lock().push(msg.to_string());
        }
        fn request(&self, kind: &str, _payload: Value) -> Value {
            self.requests.lock().push(kind.to_string());
            if kind == "screenText" { json!(["line1", "line2"]) } else { json!("answer") }
        }
        fn store_tree(&self) -> Value {
            json!({})
        }
    }

    fn script(body: &str) -> String {
        let dir = crate::store::tests::tmp("script");
        let f = dir.join("s.js");
        std::fs::write(&f, body).unwrap();
        f.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn crt_api_drives_a_tab() {
        let fake = Arc::new(Fake::default());
        let engine = ScriptEngine::new(fake.clone());
        let f = script(
            r#"
            crt.Screen.Send("cmd\r");
            const idx = await crt.Screen.WaitForStrings(["a", "b"], 1);
            const text = await crt.Screen.ReadString("$", 1);
            const name = await crt.Dialog.Prompt("Name?");
            const screen = await crt.Screen.Get(2, 1, 2, 4);
            crt.Screen.SendKeys(idx + text + name + screen + (crt.Session.Connected ? "Y" : "N") + "\\r");
        "#,
        );
        engine.run(&f, Some("tab1".into()), vec![]).await.unwrap();
        assert_eq!(*fake.sent.lock(), vec!["cmd\r", "2output-beforeanswerlineY\r"]);
        assert_eq!(fake.requests.lock()[0], "prompt");
    }

    #[tokio::test]
    async fn tc_is_the_object_and_crt_an_alias() {
        let fake = Arc::new(Fake::default());
        let engine = ScriptEngine::new(fake.clone());
        engine.run(&script(r#"tc.Screen.Send("a"); crt.Screen.Send(tc === crt ? "same" : "different");"#), Some("t".into()), vec![]).await.unwrap();
        assert_eq!(*fake.sent.lock(), vec!["a", "same"]);
    }

    #[tokio::test]
    async fn node_modules_timers_errors_and_cancel() {
        let fake = Arc::new(Fake::default());
        let engine = ScriptEngine::new(fake.clone());
        let out = crate::store::tests::tmp("scriptout").join("out.txt");
        let body = format!(
            r#"
            const fs = require("fs"); const path = require("path"); const os = require("os");
            const file = {out:?};
            fs.writeFileSync(file, "a"); fs.appendFileSync(file, "b");
            console.log(fs.readFileSync(file, "utf8"), path.basename(file), path.join("x", "..", "y"), typeof os.homedir());
            const hash = require("crypto").createHash("sha256").update("abc").digest("hex");
            console.log(hash.slice(0, 8));
            console.log(require("child_process").execSync("echo hi").trim());
            await new Promise((r) => setTimeout(r, 30));
            let n = 0; await new Promise((r) => {{ const i = setInterval(() => {{ if (++n === 3) {{ clearInterval(i); r(); }} }}, 5); }});
            console.log("ticks", n);
        "#
        );
        engine.run(&script(&body), Some("t".into()), vec![]).await.unwrap();
        let info = fake.info.lock().clone();
        assert_eq!(info[0], "ab out.txt y string");
        assert_eq!(info[1], "ba7816bf");
        assert_eq!(info[2], "hi");
        assert_eq!(info[3], "ticks 3");
        let e = engine.run(&script("throw new Error('boom')"), None, vec![]).await.unwrap_err().to_string();
        assert!(e.contains("boom"), "{e}");
        let e = engine.run(&script("require('net')"), None, vec![]).await.unwrap_err().to_string();
        assert!(e.contains("not available"), "{e}");
        // Cancel stops even a busy loop.
        let e2 = engine.clone();
        let busy = tokio::spawn(async move { e2.run(&script("for (;;) {}"), None, vec![]).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        engine.cancel_all();
        let r = tokio::time::timeout(Duration::from_secs(5), busy).await.unwrap().unwrap();
        assert!(r.unwrap_err().to_string().contains("cancelled"));
    }

    #[tokio::test]
    async fn example_scripts_parse() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/scripts");
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let code = std::fs::read_to_string(e.path()).unwrap();
            let rt = Runtime::new().unwrap();
            let ctx = Context::full(&rt).unwrap();
            ctx.with(|ctx| {
                // Compile only (wrapped as the engine does).
                let r = ctx.eval::<(), _>(format!("(function() {{ return (async () => {{\n{code}\n}}); }})"));
                assert!(r.is_ok(), "{}: {}", e.path().display(), describe(&ctx, r.unwrap_err()));
            });
        }
    }
}
