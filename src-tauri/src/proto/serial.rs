// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Serial console connections.

use super::{Conn, Ctl, Event, EventTx};
use crate::json::{num_at, str_at};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;

/// Serial ports on this computer, in the shape the page expects ({ path, manufacturer, ... }).
pub fn list() -> Vec<Value> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(u) => json!({
                "path": p.port_name,
                "manufacturer": u.manufacturer,
                "serialNumber": u.serial_number,
                "vendorId": format!("{:04x}", u.vid),
                "productId": format!("{:04x}", u.pid),
            }),
            _ => json!({ "path": p.port_name }),
        })
        .collect()
}

pub async fn connect(session: &Value, ev: EventTx) -> Result<Conn> {
    let path = str_at(session, &["serial", "path"]);
    if path.is_empty() {
        bail!("No serial port selected");
    }
    let baud = num_at(session, &["serial", "baudRate"], 9600.0) as u32;
    let data_bits = match num_at(session, &["serial", "dataBits"], 8.0) as u8 {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let stop_bits = if num_at(session, &["serial", "stopBits"], 1.0) as u8 == 2 { StopBits::Two } else { StopBits::One };
    let parity = match str_at(session, &["serial", "parity"]).as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let flow = match str_at(session, &["serial", "flowControl"]).as_str() {
        "rtscts" => FlowControl::Hardware,
        "xonxoff" => FlowControl::Software,
        _ => FlowControl::None,
    };
    let port = tokio::task::spawn_blocking(move || {
        serialport::new(path, baud).data_bits(data_bits).stop_bits(stop_bits).parity(parity).flow_control(flow).timeout(Duration::from_millis(100)).open()
    })
    .await?
    .map_err(|e| anyhow!("{e}"))?;
    let mut reader = port.try_clone().map_err(|e| anyhow!("{e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_r = stop.clone();
    let ev_r = ev.clone();
    // Reads block (with a short timeout so closing is noticed), so they run on their own thread.
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        while !stop_r.load(Ordering::SeqCst) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let _ = ev_r.send(Event::Data(buf[..n].to_vec()));
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    let _ = ev_r.send(Event::Error(e.to_string()));
                    break;
                }
            }
        }
        if !stop_r.swap(true, Ordering::SeqCst) {
            let _ = ev_r.send(Event::Close);
        }
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<Ctl>();
    std::thread::spawn(move || {
        let mut port = port;
        while let Some(c) = rx.blocking_recv() {
            match c {
                Ctl::Write(d) => {
                    if port.write_all(&d).is_err() {
                        break;
                    }
                }
                Ctl::Break => {
                    let _ = port.set_break();
                    std::thread::sleep(Duration::from_millis(250));
                    let _ = port.clear_break();
                }
                Ctl::Resize(..) => {}
                Ctl::Close => break,
            }
        }
        if !stop.swap(true, Ordering::SeqCst) {
            let _ = ev.send(Event::Close);
        }
    });
    Ok(Conn::new(tx, str_at(session, &["username"])))
}
