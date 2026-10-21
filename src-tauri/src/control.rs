// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! End-to-end test control (debug builds only, and only with TERMCRAFT_CONTROL=1): a localhost
//! line-based JSON channel the test runner (scripts/e2e.js) uses to drive the window. Never
//! compiled into release builds: it runs arbitrary code in the page.

#![cfg(debug_assertions)]

use crate::app::App;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn start(app: Arc<App>) {
    if std::env::var("TERMCRAFT_CONTROL").ok().as_deref() != Some("1") {
        return;
    }
    let token = hex::encode(rand::random::<[u8; 16]>());
    tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("control port");
        println!("[control] {} {token}", listener.local_addr().unwrap().port());
        let seq = Arc::new(AtomicU64::new(0));
        while let Ok((sock, _)) = listener.accept().await {
            let (app, token, seq) = (app.clone(), token.clone(), seq.clone());
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(req) = serde_json::from_str::<Value>(&line) else { break };
                    if req["token"] != token.as_str() {
                        break;
                    }
                    let res = handle(&app, &req, &seq).await;
                    let out = json!({ "id": req["id"], "result": res.as_ref().ok(), "error": res.err().map(|e| e.to_string()) });
                    if w.write_all(format!("{out}\n").as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
}

async fn handle(app: &Arc<App>, req: &Value, seq: &AtomicU64) -> anyhow::Result<Value> {
    let w = app.window().ok_or_else(|| anyhow::anyhow!("no window"))?;
    match req["op"].as_str().unwrap_or("") {
        // Evaluate an expression in the page (awaited); non-JSON results come back as null.
        "eval" => {
            let id = seq.fetch_add(1, Ordering::SeqCst) + 1;
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.smoke.lock().insert(id, tx);
            let code = req["code"].as_str().unwrap_or("null");
            let js = format!(
                "(async () => {{ let ok = true, r; try {{ r = await ({code}); if (r && typeof r === 'object') {{ try {{ r = JSON.parse(JSON.stringify(r)); }} catch {{ r = null; }} }} }} catch (e) {{ ok = false; r = String(e && e.message || e); }} window.__TAURI__.core.invoke('ipc', {{ channel: 'smoke:result', args: [{id}, ok, r === undefined ? null : r] }}); }})()"
            );
            w.eval(&js)?;
            let v = tokio::time::timeout(Duration::from_secs(120), rx).await.map_err(|_| anyhow::anyhow!("eval timed out"))??;
            if v["ok"] == true { Ok(v["value"].clone()) } else { Err(anyhow::anyhow!("{}", v["value"].as_str().unwrap_or("error"))) }
        }
        // Call a backend channel directly, as the Electron tests used the main-process objects.
        "ipc" => {
            let args: Vec<Value> = req["args"].as_array().cloned().unwrap_or_default();
            app.dispatch(req["channel"].as_str().unwrap_or(""), &args).await
        }
        "setSize" => {
            w.set_size(tauri::LogicalSize::new(req["width"].as_f64().unwrap_or(1280.0), req["height"].as_f64().unwrap_or(800.0)))?;
            Ok(Value::Null)
        }
        "url" => Ok(json!(w.url()?.to_string())),
        "dataDir" => Ok(json!(app.data_dir.to_string_lossy())),
        "quit" => {
            app.allow_close.store(true, Ordering::SeqCst);
            app.quitting.store(true, Ordering::SeqCst);
            let h = app.handle.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                h.exit(0);
            });
            Ok(Value::Null)
        }
        "close" => {
            w.close()?;
            Ok(Value::Null)
        }
        // Stand-ins for native dialogs, message boxes and the OS shell.
        "mockDialogs" => {
            app.test.dialogs.lock().extend(req["answers"].as_array().cloned().unwrap_or_default());
            Ok(Value::Null)
        }
        "mockBoxes" => {
            app.test.boxes.lock().extend(req["answers"].as_array().cloned().unwrap_or_default().iter().map(|v| v.as_str().unwrap_or("").to_string()));
            Ok(Value::Null)
        }
        "boxCalls" => Ok(json!(*app.test.box_calls.lock())),
        "mockShell" => {
            app.test.shell.store(true, Ordering::SeqCst);
            Ok(Value::Null)
        }
        "externalOpened" => Ok(json!(*app.test.external.lock())),
        "windowCount" => Ok(json!(app.handle.webview_windows().len())),
        // A PNG of the window (macOS; elsewhere the caller gets false and uses a blank image).
        "capture" => {
            let out = req["path"].as_str().unwrap_or("").to_string();
            #[cfg(target_os = "macos")]
            {
                let ns = w.ns_window()? as *mut objc2::runtime::AnyObject;
                // SAFETY: ns_window is the live NSWindow of this webview window.
                let number: isize = unsafe { objc2::msg_send![&*ns, windowNumber] };
                let ok =
                    tokio::process::Command::new("screencapture").args(["-x", "-o", &format!("-l{number}"), &out]).status().await.is_ok_and(|s| s.success());
                Ok(json!(ok && std::path::Path::new(&out).exists()))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = out;
                Ok(json!(false))
            }
        }
        "hasWindow" => Ok(json!(app.handle.get_webview_window("main").is_some())),
        op => Err(anyhow::anyhow!("unknown op {op}")),
    }
}
