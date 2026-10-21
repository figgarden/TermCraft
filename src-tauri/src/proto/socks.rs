// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Minimal SOCKS4/4a/5 (CONNECT only, no auth) server side, used for dynamic port forwarding.
//! The parsers return None while more bytes are needed.

use anyhow::{Result, bail};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, PartialEq)]
pub struct Greeting {
    pub consumed: usize,
    pub no_auth: bool,
}

#[derive(Debug, PartialEq)]
pub struct Request {
    pub cmd: u8,
    pub host: String,
    pub port: u16,
    pub consumed: usize,
}

/// Parse a SOCKS5 greeting.
pub fn parse_socks5_greeting(buf: &[u8]) -> Option<Greeting> {
    if buf.len() < 2 {
        return None;
    }
    let n = buf[1] as usize;
    if buf.len() < 2 + n {
        return None;
    }
    Some(Greeting { consumed: 2 + n, no_auth: buf[2..2 + n].contains(&0) })
}

/// Parse a SOCKS5 request.
pub fn parse_socks5_request(buf: &[u8]) -> Result<Option<Request>> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let cmd = buf[1];
    let (host, off) = match buf[3] {
        1 => {
            if buf.len() < 10 {
                return Ok(None);
            }
            (format!("{}.{}.{}.{}", buf[4], buf[5], buf[6], buf[7]), 8)
        }
        3 => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let len = buf[4] as usize;
            if buf.len() < 5 + len + 2 {
                return Ok(None);
            }
            (String::from_utf8_lossy(&buf[5..5 + len]).into_owned(), 5 + len)
        }
        4 => {
            if buf.len() < 22 {
                return Ok(None);
            }
            let parts: Vec<String> = (0..16).step_by(2).map(|i| format!("{:x}", u16::from_be_bytes([buf[4 + i], buf[5 + i]]))).collect();
            (parts.join(":"), 20)
        }
        t => bail!("Unsupported SOCKS5 address type {t}"),
    };
    Ok(Some(Request { cmd, host, port: u16::from_be_bytes([buf[off], buf[off + 1]]), consumed: off + 2 }))
}

/// Parse a SOCKS4/4a CONNECT request.
pub fn parse_socks4_request(buf: &[u8]) -> Option<Request> {
    if buf.len() < 9 {
        return None;
    }
    let cmd = buf[1];
    let port = u16::from_be_bytes([buf[2], buf[3]]);
    let ip = &buf[4..8];
    let user_end = buf[8..].iter().position(|&b| b == 0)? + 8;
    let mut host = format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]);
    let mut consumed = user_end + 1;
    if ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] != 0 {
        let host_end = buf[consumed..].iter().position(|&b| b == 0)? + consumed;
        host = String::from_utf8_lossy(&buf[consumed..host_end]).into_owned();
        consumed = host_end + 1;
    }
    Some(Request { cmd, host, port, consumed })
}

const SOCKS5_OK: [u8; 10] = [5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
const SOCKS5_FAIL: [u8; 10] = [5, 1, 0, 1, 0, 0, 0, 0, 0, 0];
const SOCKS4_OK: [u8; 8] = [0, 0x5a, 0, 0, 0, 0, 0, 0];
const SOCKS4_FAIL: [u8; 8] = [0, 0x5b, 0, 0, 0, 0, 0, 0];

/// Drive a SOCKS handshake on `sock`, then call `connect(host, port)` and pipe the two together.
pub async fn handle_socks_connection<S, C, F, T>(mut sock: S, connect: C) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnOnce(String, u16) -> F,
    F: Future<Output = Result<T>>,
    T: AsyncRead + AsyncWrite + Unpin,
{
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let mut stage = 0u8; // 0 init, 4 = v4 request, 5 = v5 greeting, 6 = v5 request
    let req = loop {
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            bail!("closed during SOCKS handshake");
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 4096 {
            bail!("SOCKS request too long");
        }
        if stage == 0 {
            stage = match buf[0] {
                4 => 4,
                5 => 5,
                _ => bail!("Not a SOCKS request"),
            };
        }
        if stage == 5 {
            let Some(g) = parse_socks5_greeting(&buf) else { continue };
            buf.drain(..g.consumed);
            if !g.no_auth {
                let _ = sock.write_all(&[5, 0xff]).await;
                return Ok(());
            }
            sock.write_all(&[5, 0]).await?;
            stage = 6;
        }
        let req = if stage == 6 { parse_socks5_request(&buf)? } else { parse_socks4_request(&buf) };
        if let Some(r) = req {
            buf.drain(..r.consumed);
            break r;
        }
    };
    let v5 = stage == 6;
    if req.cmd != 1 {
        let _ = sock.write_all(if v5 { &[5, 7, 0, 1, 0, 0, 0, 0, 0, 0][..] } else { &SOCKS4_FAIL[..] }).await;
        return Ok(());
    }
    match connect(req.host, req.port).await {
        Err(e) => {
            let _ = sock.write_all(if v5 { &SOCKS5_FAIL[..] } else { &SOCKS4_FAIL[..] }).await;
            Err(e)
        }
        Ok(mut stream) => {
            sock.write_all(if v5 { &SOCKS5_OK[..] } else { &SOCKS4_OK[..] }).await?;
            if !buf.is_empty() {
                stream.write_all(&buf).await?;
            }
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsers() {
        assert_eq!(parse_socks5_greeting(&[5, 1, 0]), Some(Greeting { consumed: 3, no_auth: true }));
        assert_eq!(parse_socks5_greeting(&[5, 2, 0]), None);
        let mut dom = vec![5, 1, 0, 3, 11];
        dom.extend_from_slice(b"example.com");
        dom.extend_from_slice(&[0, 80]);
        assert_eq!(parse_socks5_request(&dom).unwrap(), Some(Request { cmd: 1, host: "example.com".into(), port: 80, consumed: dom.len() }));
        assert_eq!(
            parse_socks5_request(&[5, 1, 0, 1, 10, 0, 0, 1, 1, 187]).unwrap(),
            Some(Request { cmd: 1, host: "10.0.0.1".into(), port: 443, consumed: 10 })
        );
        let mut s4a = vec![4, 1, 0, 22, 0, 0, 0, 1];
        s4a.extend_from_slice(b"u\0host\0");
        assert_eq!(parse_socks4_request(&s4a), Some(Request { cmd: 1, host: "host".into(), port: 22, consumed: s4a.len() }));
    }

    #[tokio::test]
    async fn socks5_connect_is_piped() {
        let (client, server) = tokio::io::duplex(4096);
        let (target_a, mut target_b) = tokio::io::duplex(4096);
        let h = tokio::spawn(async move {
            handle_socks_connection(server, |host, port| async move {
                assert_eq!((host.as_str(), port), ("example.com", 80));
                Ok(target_a)
            })
            .await
        });
        let mut client = client;
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut r = [0u8; 2];
        client.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&[0, 80]);
        client.write_all(&req).await.unwrap();
        let mut ok = [0u8; 10];
        client.read_exact(&mut ok).await.unwrap();
        assert_eq!(ok, SOCKS5_OK);
        client.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        target_b.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"ping");
        drop(client);
        drop(target_b);
        let _ = h.await;
    }
}
