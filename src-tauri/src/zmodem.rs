// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! ZMODEM file transfer over a terminal connection: what "rz" (receive) and "sz" (send) speak on
//! Linux hosts and many embedded devices. Supports batches of files, CRC-16 and CRC-32 frames,
//! restarting from the last good position after a line error, and cancelling (both sides stop).

use crate::xmodem::{Io, Progress, Reader, Signal, crc16, target_path};
use anyhow::{Result, bail};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::time::Instant;

const ZPAD: u8 = 0x2a;
const ZDLE: u8 = 0x18;
const XON: u8 = 0x11;
const ZBIN: u8 = 0x41;
const ZHEX: u8 = 0x42;
const ZBIN32: u8 = 0x43;
const ZRQINIT: u8 = 0;
const ZRINIT: u8 = 1;
const ZSINIT: u8 = 2;
const ZACK: u8 = 3;
const ZFILE: u8 = 4;
const ZSKIP: u8 = 5;
const ZABORT: u8 = 7;
const ZFIN: u8 = 8;
const ZRPOS: u8 = 9;
const ZDATA: u8 = 10;
const ZEOF: u8 = 11;
const ZFERR: u8 = 12;
const ZCHALLENGE: u8 = 14;
const ZCAN: u8 = 16;
const ZCRCE: u8 = 0x68;
const ZCRCG: u8 = 0x69;
const ZCRCQ: u8 = 0x6a;
const ZCRCW: u8 = 0x6b;
const ZRUB0: u8 = 0x6c;
const ZRUB1: u8 = 0x6d;
const CANFDX: u8 = 0x01;
const CANOVIO: u8 = 0x02;
const CANFC32: u8 = 0x20;
const ESCCTL: u8 = 0x40;
const SUBPACKET: usize = 1024;
/// Subpackets sent before waiting for an ACK.
const WINDOW: usize = 8;
pub const ABORT: [u8; 18] = [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8];
/// Bytes a ZMODEM receiver starts with ("rz" sends ZRINIT) and a sender starts with ("sz" sends ZRQINIT).
const ZRINIT_START: &[u8] = b"**\x18B01";
const ZRQINIT_START: &[u8] = b"**\x18B00";

fn crc32_table() -> &'static [u32; 256] {
    static T: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    })
}

pub fn crc32(buf: &[u8]) -> u32 {
    let t = crc32_table();
    let mut c = 0xffffffffu32;
    for &b in buf {
        c = t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffffffff
}

fn le32(n: u32) -> [u8; 4] {
    n.to_le_bytes()
}

fn read_le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// ZDLE-escape bytes for the wire.
fn escape(buf: &[u8], escctl: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len() + buf.len() / 8);
    for &b in buf {
        // ZDLE, DLE, XON, XOFF (and their 8th-bit versions) and CR are always escaped; with ESCCTL
        // all control characters.
        if matches!(b, ZDLE | 0x10 | 0x90 | 0x11 | 0x91 | 0x13 | 0x93 | 0x0d | 0x8d) || (escctl && (b & 0x60) == 0) {
            out.extend_from_slice(&[ZDLE, b ^ 0x40]);
        } else if b == 0x7f {
            out.extend_from_slice(&[ZDLE, ZRUB0]);
        } else if b == 0xff {
            out.extend_from_slice(&[ZDLE, ZRUB1]);
        } else {
            out.push(b);
        }
    }
    out
}

pub fn hex_header(typ: u8, data: [u8; 4]) -> Vec<u8> {
    let body = [typ, data[0], data[1], data[2], data[3]];
    let crc = crc16(&body);
    let mut out = vec![ZPAD, ZPAD, ZDLE, ZHEX];
    out.extend_from_slice(hex::encode(body).as_bytes());
    out.extend_from_slice(hex::encode(crc.to_be_bytes()).as_bytes());
    out.extend_from_slice(&[0x0d, 0x8a]);
    if typ != ZACK && typ != ZFIN {
        out.push(XON);
    }
    out
}

fn bin_header(typ: u8, data: [u8; 4], escctl: bool) -> Vec<u8> {
    let mut body = vec![typ, data[0], data[1], data[2], data[3]];
    let crc = crc16(&body);
    body.extend_from_slice(&crc.to_be_bytes());
    let mut out = vec![ZPAD, ZDLE, ZBIN];
    out.extend(escape(&body, escctl));
    out
}

fn subpacket(data: &[u8], end: u8, escctl: bool) -> Vec<u8> {
    let mut with_end = data.to_vec();
    with_end.push(end);
    let crc = crc16(&with_end);
    let mut out = escape(data, escctl);
    out.extend_from_slice(&[ZDLE, end]);
    out.extend(escape(&crc.to_be_bytes(), escctl));
    out
}

enum Esc {
    Byte(u8),
    End(u8),
}

enum Hdr {
    Ok { typ: u8, data: [u8; 4], format: u8 },
    Bad,
}

impl Hdr {
    fn typ(&self) -> Option<u8> {
        match self {
            Hdr::Ok { typ, .. } => Some(*typ),
            Hdr::Bad => None,
        }
    }
}

struct Sub {
    data: Vec<u8>,
    end: u8,
    ok: bool,
}

const TIMED_OUT: &str = "Timed out waiting for the other side";
const BAD_ESCAPE: &str = "Bad escape sequence";

/// Frame-level reader on top of the byte Reader.
struct ZReader {
    rd: Reader,
    cans: u32,
}

impl ZReader {
    async fn byte(&mut self, ms: u64) -> Result<u8> {
        let Some(b) = self.rd.byte(ms).await? else { bail!(TIMED_OUT) };
        if b == ZDLE {
            self.cans += 1;
            if self.cans >= 5 {
                bail!("Cancelled by the other side");
            }
        } else {
            self.cans = 0;
        }
        Ok(b)
    }

    /// One data byte with ZDLE decoding, or a subpacket end marker.
    async fn escaped(&mut self, ms: u64) -> Result<Esc> {
        loop {
            let b = self.byte(ms).await?;
            if matches!(b, 0x11 | 0x13 | 0x91 | 0x93) {
                continue; // flow-control noise
            }
            if b != ZDLE {
                return Ok(Esc::Byte(b));
            }
            loop {
                let b = self.byte(ms).await?;
                if matches!(b, 0x11 | 0x13 | 0x91 | 0x93) {
                    continue;
                }
                return Ok(match b {
                    ZCRCE | ZCRCG | ZCRCQ | ZCRCW => Esc::End(b),
                    ZRUB0 => Esc::Byte(0x7f),
                    ZRUB1 => Esc::Byte(0xff),
                    _ if (b & 0x60) == 0x40 => Esc::Byte(b ^ 0x40),
                    _ => bail!(BAD_ESCAPE),
                });
            }
        }
    }

    /// Next header, or None on timeout.
    async fn header(&mut self, ms: u64) -> Result<Option<Hdr>> {
        match self.header_inner(ms).await {
            Ok(h) => Ok(h),
            Err(e) if e.to_string() == TIMED_OUT => Ok(None),
            Err(e) if e.to_string() == BAD_ESCAPE => Ok(Some(Hdr::Bad)),
            Err(e) => Err(e),
        }
    }

    async fn header_inner(&mut self, ms: u64) -> Result<Option<Hdr>> {
        let until = Instant::now() + std::time::Duration::from_millis(ms);
        loop {
            let left = until.saturating_duration_since(Instant::now()).as_millis() as u64;
            if left == 0 {
                return Ok(None);
            }
            let mut b = self.byte(left).await?;
            if b != ZPAD {
                continue;
            }
            while b == ZPAD {
                b = self.byte(5000).await?;
            }
            if b != ZDLE {
                continue;
            }
            let fmt = self.byte(5000).await?;
            if fmt == ZHEX {
                let mut chars = Vec::with_capacity(14);
                for _ in 0..14 {
                    chars.push(self.byte(5000).await?);
                }
                let Ok(raw) = hex::decode(&chars) else { return Ok(Some(Hdr::Bad)) };
                if raw.len() != 7 || crc16(&raw[..5]) != u16::from_be_bytes([raw[5], raw[6]]) {
                    return Ok(Some(Hdr::Bad));
                }
                return Ok(Some(Hdr::Ok { typ: raw[0], data: [raw[1], raw[2], raw[3], raw[4]], format: ZHEX }));
            }
            if fmt == ZBIN || fmt == ZBIN32 {
                let n = if fmt == ZBIN { 7 } else { 9 };
                let mut raw = Vec::with_capacity(n);
                for _ in 0..n {
                    match self.escaped(5000).await? {
                        Esc::Byte(x) => raw.push(x),
                        Esc::End(_) => return Ok(Some(Hdr::Bad)),
                    }
                }
                let body = &raw[..5];
                let ok = if fmt == ZBIN { crc16(body) == u16::from_be_bytes([raw[5], raw[6]]) } else { crc32(body) == read_le32(&raw[5..9]) };
                return Ok(Some(if ok { Hdr::Ok { typ: raw[0], data: [raw[1], raw[2], raw[3], raw[4]], format: fmt } } else { Hdr::Bad }));
            }
        }
    }

    /// A data subpacket.
    async fn subpacket(&mut self, crc32mode: bool) -> Result<Sub> {
        let max = 8192 + 16;
        let mut data = Vec::new();
        loop {
            match self.escaped(10000).await? {
                Esc::Byte(x) => {
                    data.push(x);
                    if data.len() > max {
                        return Ok(Sub { data: vec![], end: 0, ok: false });
                    }
                }
                Esc::End(end) => {
                    let n = if crc32mode { 4 } else { 2 };
                    let mut c = Vec::with_capacity(n);
                    for _ in 0..n {
                        match self.escaped(10000).await? {
                            Esc::Byte(y) => c.push(y),
                            Esc::End(_) => return Ok(Sub { data: vec![], end: 0, ok: false }),
                        }
                    }
                    let mut with_end = data.clone();
                    with_end.push(end);
                    let ok = if crc32mode { crc32(&with_end) == read_le32(&c) } else { crc16(&with_end) == u16::from_be_bytes([c[0], c[1]]) };
                    return Ok(Sub { data, end, ok });
                }
            }
        }
    }
}

fn is_other_side(e: &anyhow::Error) -> bool {
    e.to_string().contains("other side")
}

/// Send files. Works whether the receiver started first ("rz" already running: its ZRINIT may be
/// waiting in the stream) or not (we send ZRQINIT until it answers).
pub async fn send(io: Io, files: &[PathBuf], signal: Arc<Signal>, progress: Option<Progress<'_>>) -> Result<()> {
    let mut z = ZReader { rd: Reader::new(io, signal.clone()), cans: 0 };
    let res = send_inner(&mut z, files, &signal, progress).await;
    if let Err(e) = &res {
        if !is_other_side(e) {
            z.rd.write(&ABORT);
        }
    }
    res
}

async fn send_inner(z: &mut ZReader, files: &[PathBuf], signal: &Signal, progress: Option<Progress<'_>>) -> Result<()> {
    let mut zrinit = None;
    for tries in 0..6 {
        if tries > 0 {
            z.rd.write(&hex_header(ZRQINIT, [0; 4]));
        }
        match z.header(if tries > 0 { 10000 } else { 2000 }).await? {
            Some(Hdr::Ok { typ: ZRINIT, data, .. }) => {
                zrinit = Some(data);
                break;
            }
            Some(Hdr::Ok { typ: ZCHALLENGE, data, .. }) => z.rd.write(&hex_header(ZACK, data)),
            _ => {}
        }
    }
    let Some(zrinit) = zrinit else { bail!("The receiver did not start. Run \"rz\" (or the device's ZMODEM receive command) first.") };
    z.rd.flush(); // drop repeated ZRINITs so they aren't mistaken for answers later
    let escctl = zrinit[3] & ESCCTL != 0;
    let mut bytes_left: u64 = 0;
    for f in files {
        bytes_left += tokio::fs::metadata(f).await?.len();
    }
    for (i, file) in files.iter().enumerate() {
        let data = tokio::fs::read(file).await?;
        let meta = tokio::fs::metadata(file).await?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut info: Vec<u8> = name.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect();
        info.push(0);
        info.extend_from_slice(format!("{} {:o} 100644 0 {} {}", data.len(), mtime, files.len() - i, bytes_left).as_bytes());
        info.push(0);
        let mut pos: Option<i64> = None;
        for _ in 0..10 {
            z.rd.write(&bin_header(ZFILE, [0, 0, 0, 1], escctl)); // ZF0 = ZCBIN (binary)
            z.rd.write(&subpacket(&info, ZCRCW, escctl));
            match z.header(15000).await? {
                Some(Hdr::Ok { typ: ZRPOS, data, .. }) => pos = Some(read_le32(&data) as i64),
                Some(Hdr::Ok { typ: ZSKIP, .. }) => pos = Some(-1),
                Some(Hdr::Ok { typ: ZFERR | ZABORT, .. }) => bail!("The receiver refused the file"),
                _ => {}
            }
            if pos.is_some() {
                break;
            }
        }
        let Some(pos) = pos else { bail!("The receiver did not accept the file") };
        if pos >= 0 {
            send_file_data(z, &data, pos as usize, escctl, &name, progress, signal).await?;
        }
        bytes_left -= data.len() as u64;
    }
    for _ in 0..5 {
        z.rd.write(&hex_header(ZFIN, [0; 4]));
        if let Some(Hdr::Ok { typ: ZFIN, .. }) = z.header(5000).await? {
            break;
        }
    }
    z.rd.write(b"OO");
    Ok(())
}

async fn send_file_data(z: &mut ZReader, data: &[u8], start: usize, escctl: bool, name: &str, progress: Option<Progress<'_>>, signal: &Signal) -> Result<()> {
    let mut pos = start;
    let mut errors = 0;
    loop {
        if signal.is_cancelled() {
            bail!("Cancelled");
        }
        z.rd.write(&bin_header(ZDATA, le32(pos as u32), escctl));
        let mut restart = false;
        while !restart {
            if pos >= data.len() {
                z.rd.write(&subpacket(&[], ZCRCE, escctl));
                break;
            }
            // Send a window of subpackets; the last one asks for an ACK (or ends the file).
            let mut sent = 0;
            while sent < WINDOW && pos < data.len() {
                let chunk = &data[pos..(pos + SUBPACKET).min(data.len())];
                let last = pos + chunk.len() >= data.len();
                let end = if last {
                    ZCRCE
                } else if sent == WINDOW - 1 {
                    ZCRCQ
                } else {
                    ZCRCG
                };
                z.rd.write(&subpacket(chunk, end, escctl));
                pos += chunk.len();
                sent += 1;
                if last {
                    break;
                }
            }
            if let Some(p) = progress {
                p(json!({ "name": name, "bytes": pos, "size": data.len() }));
            }
            if pos >= data.len() {
                break;
            }
            let h = z.header(15000).await?;
            match h {
                Some(Hdr::Ok { typ: ZACK, .. }) => continue,
                Some(Hdr::Ok { typ: ZRPOS, data: d, .. }) => {
                    pos = read_le32(&d) as usize;
                    restart = true;
                    errors += 1;
                    if errors > 20 {
                        bail!("Too many errors");
                    }
                }
                Some(Hdr::Ok { typ: ZSKIP, .. }) => return Ok(()),
                None | Some(Hdr::Bad) => {
                    restart = true;
                    errors += 1;
                    if errors > 20 {
                        bail!("Too many errors");
                    }
                }
                Some(Hdr::Ok { typ: ZABORT | ZFERR | ZCAN, .. }) => bail!("The receiver stopped the transfer"),
                _ => {}
            }
        }
        if restart {
            continue;
        }
        // End of file: wait for the receiver to confirm (ZRINIT) or ask for a resend (ZRPOS).
        z.rd.write(&bin_header(ZEOF, le32(data.len() as u32), escctl));
        let mut tries = 0;
        loop {
            let h = z.header(15000).await?;
            match &h {
                Some(Hdr::Ok { typ: ZRINIT, .. }) => return Ok(()),
                Some(Hdr::Ok { typ: ZRPOS, data: d, .. }) => {
                    pos = read_le32(d) as usize;
                    errors += 1;
                    if errors > 20 {
                        bail!("Too many errors");
                    }
                    break;
                }
                Some(Hdr::Ok { typ: ZSKIP, .. }) => return Ok(()),
                _ => {}
            }
            if tries >= 4 {
                bail!("The receiver did not confirm the end of the file");
            }
            if h.as_ref().and_then(Hdr::typ).is_none() {
                z.rd.write(&bin_header(ZEOF, le32(data.len() as u32), escctl));
            }
            tries += 1;
        }
    }
}

struct Current {
    file: PathBuf,
    tmp: PathBuf,
    fh: tokio::fs::File,
    pos: u64,
    size: u64,
    name: String,
}

/// Receive a batch into `dir` (file names sanitized, never overwriting). Returns saved paths.
pub async fn receive(io: Io, dir: &Path, signal: Arc<Signal>, progress: Option<Progress<'_>>) -> Result<Vec<PathBuf>> {
    let mut z = ZReader { rd: Reader::new(io, signal.clone()), cans: 0 };
    let mut saved = Vec::new();
    let mut cur: Option<Current> = None;
    let res = receive_inner(&mut z, dir, &signal, progress, &mut saved, &mut cur).await;
    if let Err(e) = &res {
        if !is_other_side(e) {
            z.rd.write(&ABORT);
        }
    }
    if let Some(c) = cur.take() {
        drop(c.fh);
        let _ = tokio::fs::remove_file(&c.tmp).await;
    }
    res.map(|_| saved)
}

async fn close_cur(cur: &mut Option<Current>, keep: bool, saved: &mut Vec<PathBuf>) -> Result<()> {
    if let Some(mut c) = cur.take() {
        let _ = c.fh.flush().await;
        drop(c.fh);
        if keep {
            tokio::fs::rename(&c.tmp, &c.file).await?;
            saved.push(c.file);
        } else {
            let _ = tokio::fs::remove_file(&c.tmp).await;
        }
    }
    Ok(())
}

async fn receive_inner(
    z: &mut ZReader,
    dir: &Path,
    signal: &Signal,
    progress: Option<Progress<'_>>,
    saved: &mut Vec<PathBuf>,
    cur: &mut Option<Current>,
) -> Result<()> {
    let zrinit = |z: &ZReader| z.rd.write(&hex_header(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | CANFC32]));
    zrinit(z);
    let mut idle = 0;
    loop {
        if signal.is_cancelled() {
            bail!("Cancelled");
        }
        let h = z.header(10000).await?;
        let Some(Hdr::Ok { typ, data, format }) = h else {
            idle += 1;
            if idle > 6 {
                bail!("The sender stopped responding");
            }
            match cur {
                Some(c) => z.rd.write(&hex_header(ZRPOS, le32(c.pos as u32))),
                None => zrinit(z),
            }
            continue;
        };
        idle = 0;
        let crc32mode = format == ZBIN32;
        match typ {
            ZRQINIT => zrinit(z),
            ZSINIT => {
                z.subpacket(crc32mode).await?;
                z.rd.write(&hex_header(ZACK, [0; 4]));
            }
            ZFILE => {
                let sp = z.subpacket(crc32mode).await?;
                if !sp.ok {
                    zrinit(z);
                    continue;
                }
                let text: String = sp.data.iter().map(|&b| b as char).collect();
                let mut parts = text.splitn(2, '\0');
                let raw_name = parts.next().unwrap_or("").to_string();
                let meta = parts.next().unwrap_or("");
                close_cur(cur, false, saved).await?;
                let file = target_path(dir, &raw_name);
                let tmp = PathBuf::from(format!("{}.part", file.display()));
                let fh = tokio::fs::File::create(&tmp).await?;
                let size = meta.split(['\0', ' ']).next().unwrap_or("").parse::<u64>().unwrap_or(0);
                let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                *cur = Some(Current { file, tmp, fh, pos: 0, size, name });
                z.rd.write(&hex_header(ZRPOS, le32(0)));
            }
            ZDATA => {
                let Some(c) = cur.as_mut() else {
                    zrinit(z);
                    continue;
                };
                if read_le32(&data) as u64 != c.pos {
                    z.rd.write(&hex_header(ZRPOS, le32(c.pos as u32)));
                    continue;
                }
                loop {
                    let sp = match z.subpacket(crc32mode).await {
                        Ok(sp) => sp,
                        Err(e) if e.to_string().contains("Cancelled") || is_other_side(&e) => return Err(e),
                        Err(_) => Sub { data: vec![], end: 0, ok: false },
                    };
                    if !sp.ok {
                        z.rd.flush();
                        z.rd.write(&hex_header(ZRPOS, le32(c.pos as u32)));
                        break;
                    }
                    c.fh.seek(std::io::SeekFrom::Start(c.pos)).await?;
                    c.fh.write_all(&sp.data).await?;
                    c.pos += sp.data.len() as u64;
                    if let Some(p) = progress {
                        p(json!({ "name": c.name, "bytes": c.pos, "size": c.size }));
                    }
                    if sp.end == ZCRCW || sp.end == ZCRCQ {
                        z.rd.write(&hex_header(ZACK, le32(c.pos as u32)));
                    }
                    if sp.end == ZCRCW || sp.end == ZCRCE {
                        break;
                    }
                }
            }
            ZEOF => {
                if cur.as_ref().is_some_and(|c| read_le32(&data) as u64 == c.pos) {
                    close_cur(cur, true, saved).await?;
                    zrinit(z);
                }
            }
            ZFIN => {
                close_cur(cur, false, saved).await?;
                z.rd.write(&hex_header(ZFIN, [0; 4]));
                let _ = z.rd.bytes(2, 1000).await; // "OO"
                return Ok(());
            }
            ZCAN | ZABORT => bail!("Cancelled by the other side"),
            _ => {}
        }
    }
}

/// Look for the start of a ZMODEM transfer in terminal output. Returns ("send" | "receive", at):
/// "send" = the device runs rz and waits for files.
pub fn detect(buf: &[u8]) -> Option<(&'static str, usize)> {
    let find = |n: &[u8]| buf.windows(n.len()).position(|w| w == n);
    if let Some(r) = find(ZRINIT_START) {
        return Some(("send", r));
    }
    find(ZRQINIT_START).map(|q| ("receive", q))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xmodem::tests::{line, random_bytes};
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    fn series(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut tricky: Vec<u8> = (0..=255u8).collect();
        tricky.extend_from_slice(&[0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x2a, 0x2a, 0x0d, 0x11, 0x13, 0xff, 0x7f]);
        let files = vec![
            ("01-boot.cfg".to_string(), b"boot system image.bin\n".to_vec()),
            ("02-image.bin".to_string(), random_bytes(120000)),
            ("03-empty.txt".to_string(), vec![]),
            ("04-tricky.dat".to_string(), tricky),
        ];
        for (n, d) in &files {
            std::fs::write(dir.join(n), d).unwrap();
        }
        files
    }

    fn same(dir: &Path, files: &[(String, Vec<u8>)]) -> bool {
        files.iter().all(|(n, d)| std::fs::read(dir.join(n)).ok().as_ref() == Some(d))
    }

    #[test]
    fn detects_rz_and_sz() {
        assert_eq!(detect(b"rz waiting to receive.**\x18B0100000023be50\r\n"), Some(("send", 22)));
        assert_eq!(detect(b"**\x18B00000000000000\r\n"), Some(("receive", 0)));
        assert_eq!(detect(b"** bold ** text B01"), None);
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }

    #[tokio::test]
    async fn series_survives_corrupted_packets() {
        let dir = crate::store::tests::tmp("zm");
        let files = series(&dir);
        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        let (a, b) = line(vec![6, 15, 30], 300, 200, 0x55, true);
        let paths: Vec<PathBuf> = files.iter().map(|(n, _)| dir.join(n)).collect();
        let s = Arc::new(Signal::default());
        let (r1, r2) = tokio::join!(send(a, &paths, s.clone(), None), receive(b, &out, s, None));
        r1.unwrap();
        let saved = r2.unwrap();
        let names: Vec<String> = saved.iter().map(|f| f.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, files.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>());
        assert!(same(&out, &files));
    }

    #[tokio::test]
    async fn received_names_cannot_escape_or_overwrite() {
        let dir = crate::store::tests::tmp("zmevil");
        let src = dir.join("authorized_keys");
        std::fs::write(&src, "evil").unwrap();
        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        std::fs::write(out.join("authorized_keys"), "mine").unwrap();
        let (a, b) = line(vec![], usize::MAX, 0, 0, true);
        // Rewrite the file name on the wire.
        let inner = a.write.clone();
        let a = Io {
            write: Arc::new(move |buf: &[u8]| {
                let s: String = buf.iter().map(|&c| c as char).collect();
                let s = s.replace("authorized_keys\0", "../../.ssh/authorized_keys\0");
                inner(&s.chars().map(|c| c as u8).collect::<Vec<u8>>())
            }),
            rx: a.rx,
        };
        let s = Arc::new(Signal::default());
        let srcs = [src];
        let (_, r2) = tokio::join!(send(a, &srcs, s.clone(), None), receive(b, &out, s, None));
        for f in r2.unwrap_or_default() {
            assert_eq!(f.parent().unwrap(), out);
        }
        assert_eq!(std::fs::read_to_string(out.join("authorized_keys")).unwrap(), "mine");
    }

    fn have_lrzsz() -> bool {
        std::process::Command::new("sz").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }

    /// Run an lrzsz program and connect its stdin/stdout to an Io.
    fn lrzsz(cmd: &str, args: &[&str], cwd: &Path) -> (Io, tokio::process::Child) {
        let mut child =
            tokio::process::Command::new(cmd).args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (wtx, mut wrx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(d) = wrx.recv().await {
                if stdin.write_all(&d).await.is_err() {
                    break;
                }
            }
        });
        let (rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 || rtx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        (
            Io {
                write: Arc::new(move |b: &[u8]| {
                    let _ = wtx.send(b.to_vec());
                }),
                rx: rrx,
            },
            child,
        )
    }

    #[tokio::test]
    async fn works_with_real_lrzsz() {
        if !have_lrzsz() {
            eprintln!("lrzsz not installed; skipping");
            return;
        }
        let dir = crate::store::tests::tmp("zmreal");
        let files = series(&dir);
        let paths: Vec<PathBuf> = files.iter().map(|(n, _)| dir.join(n)).collect();
        let rz_dir = dir.join("rz");
        std::fs::create_dir(&rz_dir).unwrap();
        let (io, mut child) = lrzsz("rz", &["-q"], &rz_dir);
        send(io, &paths, Arc::new(Signal::default()), None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
        assert!(same(&rz_dir, &files), "rz received every file intact");

        let got = dir.join("got");
        std::fs::create_dir(&got).unwrap();
        let mut args = vec!["-q", "-e"];
        let ps: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        args.extend(ps.iter().map(String::as_str));
        let (io, mut child) = lrzsz("sz", &args, &dir);
        let saved = receive(io, &got, Arc::new(Signal::default()), None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
        assert_eq!(saved.len(), files.len());
        assert!(same(&got, &files), "every file from sz intact");
    }

    #[tokio::test]
    async fn ymodem_and_xmodem_with_real_lrzsz() {
        if !have_lrzsz() {
            eprintln!("lrzsz not installed; skipping");
            return;
        }
        let dir = crate::store::tests::tmp("ymreal");
        let files: Vec<_> = series(&dir).into_iter().filter(|(_, d)| !d.is_empty()).collect();
        let paths: Vec<PathBuf> = files.iter().map(|(n, _)| dir.join(n)).collect();
        let rb = dir.join("rb");
        std::fs::create_dir(&rb).unwrap();
        let (io, mut child) = lrzsz("rz", &["--ymodem", "-q"], &rb);
        crate::xmodem::send(io, &paths, "ymodem", Arc::new(Signal::default()), None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
        assert!(same(&rb, &files));
        let got = dir.join("got");
        std::fs::create_dir(&got).unwrap();
        let mut args = vec!["--ymodem", "-q"];
        let ps: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        args.extend(ps.iter().map(String::as_str));
        let (io, mut child) = lrzsz("sz", &args, &dir);
        crate::xmodem::receive(io, &got, "ymodem", "", Arc::new(Signal::default()), None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
        assert!(same(&got, &files));
    }
}
