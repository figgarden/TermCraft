// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Telnet, raw TCP and rlogin connections.

use super::telnet_parser::{BRK, IAC, TelnetParser};
use super::{Conn, Ctl, Event, EventTx};
use crate::json::{num_at, str_at};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Connect with a timeout: unreachable hosts otherwise hang on "Connecting" until the OS gives up
/// (a minute or more).
pub async fn tcp_connect(session: &Value, default_port: u16) -> Result<TcpStream> {
    let host = str_at(session, &["host"]);
    let port = num_at(session, &["port"], default_port as f64) as u16;
    let secs = num_at(session, &["ssh", "readyTimeout"], 20.0);
    let sock = tokio::time::timeout(Duration::from_secs_f64(secs), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| anyhow!("Timed out after {secs} s (host unreachable or port filtered)"))??;
    sock.set_nodelay(true)?;
    let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(30));
    let _ = socket2::SockRef::from(&sock).set_tcp_keepalive(&keepalive);
    Ok(sock)
}

/// Pump a TCP socket: incoming bytes through `on_read`, commands through `on_ctl`.
async fn pump<R, C>(mut sock: TcpStream, mut ctl: mpsc::UnboundedReceiver<Ctl>, ev: EventTx, mut on_read: R, mut on_ctl: C)
where
    R: FnMut(&[u8]) -> (Vec<u8>, Vec<u8>) + Send,
    C: FnMut(Ctl) -> Option<Vec<u8>> + Send,
{
    let mut buf = vec![0u8; 65536];
    loop {
        tokio::select! {
            r = sock.read(&mut buf) => match r {
                Ok(0) => break,
                Ok(n) => {
                    let (data, reply) = on_read(&buf[..n]);
                    if !reply.is_empty() && sock.write_all(&reply).await.is_err() { break }
                    if !data.is_empty() { let _ = ev.send(Event::Data(data)); }
                }
                Err(e) => { let _ = ev.send(Event::Error(e.to_string())); break }
            },
            c = ctl.recv() => match c {
                None | Some(Ctl::Close) => break,
                Some(c) => if let Some(out) = on_ctl(c) {
                    if !out.is_empty() && sock.write_all(&out).await.is_err() { break }
                },
            },
        }
    }
    let _ = sock.shutdown().await;
    let _ = ev.send(Event::Close);
}

pub async fn connect_telnet(session: &Value, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    let sock = tcp_connect(session, 23).await?;
    let term = str_at(session, &["terminal", "termType"]);
    let parser = std::sync::Arc::new(parking_lot::Mutex::new(TelnetParser::new(if term.is_empty() { "xterm" } else { &term }, cols, rows)));
    parser.lock().start();
    let first = std::mem::take(&mut parser.lock().out);
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send(Ctl::Write(Vec::new())).ok();
    let (p1, p2) = (parser.clone(), parser);
    let mut first = Some(first);
    tokio::spawn(pump(
        sock,
        rx,
        ev,
        move |d| {
            let mut p = p1.lock();
            let data = p.feed(d);
            (data, std::mem::take(&mut p.out))
        },
        move |c| match c {
            // The initial offers go out with the first (empty) write.
            Ctl::Write(d) if d.is_empty() => first.take(),
            Ctl::Write(d) => Some(TelnetParser::escape(&d)),
            Ctl::Resize(c, r) => {
                let mut p = p2.lock();
                p.resize(c, r);
                Some(std::mem::take(&mut p.out))
            }
            // Telnet BREAK command.
            Ctl::Break => Some(vec![IAC, BRK]),
            Ctl::Close => None,
        },
    ));
    Ok(Conn::new(tx, str_at(session, &["username"])))
}

pub async fn connect_raw(session: &Value, ev: EventTx) -> Result<Conn> {
    let sock = tcp_connect(session, 23).await?;
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(pump(
        sock,
        rx,
        ev,
        |d| (d.to_vec(), vec![]),
        |c| match c {
            Ctl::Write(d) => Some(d),
            _ => None,
        },
    ));
    Ok(Conn::new(tx, str_at(session, &["username"])))
}

/// RFC 1282 rlogin. Many servers require a privileged source port, which an unprivileged desktop
/// app cannot bind; such servers will reject the login. Window-size updates need TCP urgent data,
/// so they are not sent.
pub async fn connect_rlogin(session: &Value, ev: EventTx) -> Result<Conn> {
    let local = whoami::username();
    let mut sock = tcp_connect(session, 513).await?;
    let term = str_at(session, &["terminal", "termType"]);
    let user = str_at(session, &["username"]);
    let hello = format!("\0{local}\0{}\0{}/38400\0", if user.is_empty() { &local } else { &user }, if term.is_empty() { "xterm" } else { &term });
    sock.write_all(hello.as_bytes()).await?;
    let (tx, rx) = mpsc::unbounded_channel();
    let mut first = true;
    tokio::spawn(pump(
        sock,
        rx,
        ev,
        move |d| {
            let mut d = d;
            if first {
                first = false;
                if d.first() == Some(&0) {
                    d = &d[1..];
                }
            }
            (d.to_vec(), vec![])
        },
        |c| match c {
            Ctl::Write(d) => Some(d),
            _ => None,
        },
    ));
    Ok(Conn::new(tx, user))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn unreachable_host_fails_within_the_timeout() {
        let (ev, _rx) = mpsc::unbounded_channel();
        let t0 = std::time::Instant::now();
        let r =
            connect_telnet(&json!({ "protocol": "telnet", "host": "192.0.2.1", "port": 23, "terminal": {}, "ssh": { "readyTimeout": 1 } }), 80, 24, ev).await;
        assert!(r.is_err());
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn telnet_negotiates_and_escapes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Ask for NAWS, then send text containing an escaped IAC.
            s.write_all(&[IAC, 253, 31, b'h', b'i', IAC, IAC]).await.unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 256];
            while !got.windows(3).any(|w| w == [b'x', IAC, IAC]) {
                let n = s.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            got
        });
        let (ev, mut rx) = mpsc::unbounded_channel();
        let conn = connect_telnet(&json!({ "host": "127.0.0.1", "port": port, "terminal": { "termType": "vt100" } }), 100, 30, ev).await.unwrap();
        let mut text = Vec::new();
        while text.len() < 3 {
            if let Some(Event::Data(d)) = rx.recv().await {
                text.extend(d);
            }
        }
        assert_eq!(text, vec![b'h', b'i', 255]);
        conn.write(vec![b'x', 255]);
        let got = server.await.unwrap();
        assert!(got.windows(9).any(|w| w == [IAC, 250, 31, 0, 100, 0, 30, IAC, 240]), "NAWS sent: {got:?}");
        conn.close();
    }
}
