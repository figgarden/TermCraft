// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Local shell in a pseudo-terminal.

use super::{Conn, Ctl, Event, EventTx};
use crate::json::str_at;
use crate::util::{expand_tilde, home};
use anyhow::{Result, anyhow};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use regex::Regex;
use serde_json::{Value, json};
use std::io::{Read, Write};
use tokio::sync::mpsc;

pub fn default_shell() -> String {
    if cfg!(windows) {
        let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
        return if std::path::Path::new(pwsh).exists() { pwsh.into() } else { "powershell.exe".into() };
    }
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if std::path::Path::new("/bin/zsh").exists() { "/bin/zsh".into() } else { "/bin/bash".into() })
}

/// Split "a b \"c d\"" into ["a", "b", "c d"].
fn split_args(s: &str) -> Vec<String> {
    Regex::new(r#"(?:[^\s"]+|"[^"]*")+"#).unwrap().find_iter(s).map(|m| m.as_str().trim_start_matches('"').trim_end_matches('"').to_string()).collect()
}

pub fn connect(session: &Value, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    let shell = Some(str_at(session, &["local", "shell"])).filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
    let args_s = str_at(session, &["local", "args"]);
    let args = if !args_s.is_empty() {
        split_args(&args_s)
    } else if cfg!(windows) {
        vec![]
    } else {
        vec!["-l".to_string()]
    };
    let cwd =
        Some(str_at(session, &["local", "cwd"])).filter(|s| !s.is_empty()).map(|c| expand_tilde(&c)).unwrap_or_else(|| home().to_string_lossy().into_owned());
    let term = Some(str_at(session, &["terminal", "termType"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "xterm-256color".into());
    spawn_pty(&shell, &args, &cwd, &term, cols, rows, ev, json!({ "shell": shell }), String::new())
}

/// Run a program in a pseudo-terminal (no shell): its output is the tab's screen, keystrokes go
/// to it, and the tab closes when it exits.
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(program: &str, args: &[String], cwd: &str, term: &str, cols: u16, rows: u16, ev: EventTx, status: Value, username: String) -> Result<Conn> {
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("{e}"))?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd);
    cmd.env("TERM", term);
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TermCraft");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow!("Could not start {program}: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
    let mut writer = pair.master.take_writer().map_err(|e| anyhow!("{e}"))?;
    let mut killer = child.clone_killer();
    let _ = ev.send(Event::Status(status));

    // Raw bytes both ways: binary transfers (ZMODEM) and non-UTF-8 encodings stay intact.
    let ev_r = ev.clone();
    let (read_done_tx, read_done) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = ev_r.send(Event::Data(buf[..n].to_vec()));
                }
            }
        }
        let _ = read_done_tx.send(());
    });
    let ev_w = ev.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        // Let the last output (e.g. a one-shot tool's report) reach the screen before closing.
        let _ = read_done.recv_timeout(std::time::Duration::from_secs(2));
        let _ = ev_w.send(Event::Close);
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<Ctl>();
    let master = pair.master;
    std::thread::spawn(move || {
        while let Some(c) = rx.blocking_recv() {
            match c {
                Ctl::Write(d) => {
                    if writer.write_all(&d).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                Ctl::Resize(cols, rows) => {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                Ctl::Break => {}
                Ctl::Close => break,
            }
        }
        let _ = killer.kill();
    });
    Ok(Conn::new(tx, username))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_split_like_a_shell() {
        assert_eq!(split_args(r#"-c "echo hi" -x"#), vec!["-c", "echo hi", "-x"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_shell_in_a_pty() {
        let (ev, mut rx) = mpsc::unbounded_channel();
        let conn = connect(&json!({ "local": { "shell": "/bin/sh", "args": "-i" } }), 80, 24, ev).unwrap();
        conn.write(b"echo hello-$((40+2))\nexit\n".to_vec());
        let mut out = Vec::new();
        let mut closed = false;
        while let Ok(Some(e)) = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
            match e {
                Event::Data(d) => out.extend(d),
                Event::Close => {
                    closed = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("hello-42"));
        assert!(closed);
    }
}
