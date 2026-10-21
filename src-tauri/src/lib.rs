// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! TermCraft: terminal and session manager. The window shows the web UI in src/renderer; this
//! crate is everything behind it (connections, transfers, storage, scripting).

pub mod app;
pub mod auto_login;
pub mod batch;
pub mod bus;
pub mod conn_manager;
#[cfg(debug_assertions)]
mod control;
pub mod host_import;
pub mod json;
pub mod launcher;
pub mod menu;
pub mod proto;
pub mod remote_desktop;
pub mod safe_storage;
pub mod scp;
pub mod scp_service;
pub mod scripting;
pub mod security;
pub mod sftp_service;
pub mod ssh_keys;
#[cfg(test)]
mod ssh_tests;
pub mod store;
#[cfg(test)]
mod test_ssh_server;
pub mod tftp;
pub mod util;
pub mod xmodem;
pub mod zmodem;

use app::App;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent, WindowEvent};

/// The one entry point the page uses (`window.api` in js/tauri-api.js maps onto it). Only
/// TermCraft's own window, showing TermCraft's own page, may call it.
#[tauri::command]
async fn ipc(webview: tauri::Webview, state: tauri::State<'_, Arc<App>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let trusted = webview.label() == "main" && webview.url().is_ok_and(|u| app::is_app_url(&u));
    if !trusted {
        return Err("Untrusted sender".into());
    }
    let app = state.inner().clone();
    match channel.as_str() {
        "main:response" => {
            app.on_response(args.first().and_then(|v| v.as_u64()).unwrap_or(0), args.get(1).cloned().unwrap_or(Value::Null));
            Ok(Value::Null)
        }
        #[cfg(debug_assertions)]
        "smoke:result" => {
            let id = args.first().and_then(|v| v.as_u64()).unwrap_or(0);
            if let Some(tx) = app.smoke.lock().remove(&id) {
                let _ = tx.send(serde_json::json!({ "ok": args.get(1).cloned().unwrap_or(Value::Null), "value": args.get(2).cloned().unwrap_or(Value::Null) }));
            }
            Ok(Value::Null)
        }
        _ => app.dispatch(&channel, &args).await.map_err(|e| e.to_string()),
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc])
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            // The backend's services start inside the async runtime.
            let app = tauri::async_runtime::block_on(async move { App::new(handle) })?;
            tauri_app.manage(app.clone());
            app.create_window()?;
            #[cfg(debug_assertions)]
            control::start(app.clone());
            Ok(())
        })
        .on_menu_event(|handle, event| handle.state::<Arc<App>>().on_menu(event.id().as_ref()))
        .on_window_event(|window, event| {
            let app = window.state::<Arc<App>>().inner().clone();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    #[cfg(debug_assertions)]
                    eprintln!("[main] close requested (allowed: {})", app.allow_close.load(Ordering::SeqCst));
                    app.save_bounds(window);
                    if app.allow_close.load(Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    let w = window.clone();
                    tauri::async_runtime::spawn(async move {
                        let ok = app.bus.request("confirmClose", serde_json::json!({})).await;
                        if ok == true {
                            app.allow_close.store(true, Ordering::SeqCst);
                            let _ = w.close();
                        } else {
                            app.quitting.store(false, Ordering::SeqCst);
                        }
                    });
                }
                WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => app.approve_dropped(paths),
                WindowEvent::Destroyed => {
                    #[cfg(debug_assertions)]
                    eprintln!("[main] window destroyed (quitting: {})", app.quitting.load(Ordering::SeqCst));
                    tauri::async_runtime::spawn(async move {
                        app.on_window_closed();
                        if app.quitting.load(Ordering::SeqCst) || !cfg!(target_os = "macos") {
                            app.handle.exit(0);
                        }
                    });
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting TermCraft");
    app.run(|handle, event| match event {
        // macOS: closing the window keeps the app running (like other Mac apps).
        RunEvent::ExitRequested { code: None, api, .. } if cfg!(target_os = "macos") => {
            let app = handle.state::<Arc<App>>();
            if !app.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            let app = handle.state::<Arc<App>>().inner().clone();
            if app.window().is_none() {
                let _ = app.create_window();
            }
        }
        _ => {}
    });
}
