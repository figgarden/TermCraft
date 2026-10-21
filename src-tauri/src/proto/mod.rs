// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Terminal connections. Each protocol's `connect` opens the connection, then runs it in a task
//! that reports what happens as `Event`s and takes `Ctl` commands (write, resize, break, close).

pub mod local;
pub mod reticulum;
pub mod serial;
pub mod simple;
pub mod socks;
pub mod ssh;
pub mod telnet_parser;

use crate::json::str_at;
use crate::store::Store;
use anyhow::{Result, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;

pub enum Event {
    /// Bytes for the screen.
    Data(Vec<u8>),
    /// A message for the user ("Tunnel through bastion established").
    Info(String),
    /// Connection details for the status bar (cipher, shell...).
    Status(Value),
    /// A login the user chose to save, after it worked: { username, password, target? }.
    Credentials(Value),
    Error(String),
    /// The connection ended (sent once, only after a successful connect).
    Close,
}

pub type EventTx = mpsc::UnboundedSender<Event>;

pub enum Ctl {
    Write(Vec<u8>),
    Resize(u16, u16),
    Break,
    Close,
}

/// A running connection.
#[derive(Clone)]
pub struct Conn {
    ctl: mpsc::UnboundedSender<Ctl>,
    pub username: String,
}

impl Conn {
    pub fn new(ctl: mpsc::UnboundedSender<Ctl>, username: String) -> Conn {
        Conn { ctl, username }
    }
    pub fn write(&self, data: Vec<u8>) {
        let _ = self.ctl.send(Ctl::Write(data));
    }
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.ctl.send(Ctl::Resize(cols, rows));
    }
    pub fn send_break(&self) {
        let _ = self.ctl.send(Ctl::Break);
    }
    pub fn close(&self) {
        let _ = self.ctl.send(Ctl::Close);
    }
}

/// Asks the user something in the window (passwords, host keys...). Resolves to null on cancel.
pub type Prompt = Arc<dyn Fn(Value) -> BoxFuture<'static, Value> + Send + Sync>;

#[derive(Clone)]
pub struct Ctx {
    pub store: Arc<Mutex<Store>>,
    pub prompt: Prompt,
}

pub const PROTOCOLS: [&str; 8] = ["ssh2", "telnet", "raw", "rlogin", "serial", "local", "rnsh", "rntool"];

/// Open a terminal connection for a resolved session.
pub async fn connect(session: Value, ctx: Ctx, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    match str_at(&session, &["protocol"]).as_str() {
        "ssh2" => ssh::open_shell(session, ctx, cols, rows, ev).await,
        "telnet" => simple::connect_telnet(&session, cols, rows, ev).await,
        "raw" => simple::connect_raw(&session, ev).await,
        "rlogin" => simple::connect_rlogin(&session, ev).await,
        "serial" => serial::connect(&session, ev).await,
        "local" => local::connect(&session, cols, rows, ev),
        "rnsh" | "rntool" => {
            let settings = ctx.store.lock().settings().clone();
            if settings["reticulum"]["enabled"] != true {
                bail!("Reticulum is turned off. Turn it on in Settings → General → Reticulum.");
            }
            if session["protocol"] == "rnsh" {
                reticulum::connect_rnsh(&session, &settings, cols, rows, ev)
            } else {
                reticulum::connect_tool(&session, &settings, cols, rows, ev)
            }
        }
        p => bail!("Unknown protocol {p}"),
    }
}
