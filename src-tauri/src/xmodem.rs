// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! XMODEM (checksum / CRC / 1K) and YMODEM batch file transfer over a terminal connection,
//! usually a serial console: recovering a router from ROMMON ("xmodem -c flash:image.bin"),
//! loading a switch bootloader, or "rb"/"sb" on a Linux console.
//!
//! Everything is timeout- and cancel-safe: cancelling sends CAN CAN so the other side stops too.

use crate::security::is_safe_file_name;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const CRC_C: u8 = 0x43;
const MAX_ERRORS: usize = 10;

pub type WriteFn = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// The byte stream of a terminal connection, handed to a transfer protocol.
pub struct Io {
    pub write: WriteFn,
    pub rx: mpsc::UnboundedReceiver<Vec<u8>>,
}

impl Io {
    pub fn write(&self, b: &[u8]) {
        (self.write)(b)
    }
}

/// Cancels a running transfer.
#[derive(Default)]
pub struct Signal {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Signal {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub type Progress<'a> = &'a (dyn Fn(Value) + Send + Sync);

pub fn crc16(buf: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in buf {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn checksum(buf: &[u8]) -> u8 {
    buf.iter().fold(0u8, |a, &b| a.wrapping_add(b))
}

/// Byte queue with "wait for N bytes" helpers.
pub struct Reader {
    io: Io,
    pub buf: VecDeque<u8>,
    signal: Arc<Signal>,
    closed: bool,
}

impl Reader {
    pub fn new(io: Io, signal: Arc<Signal>) -> Self {
        Reader { io, buf: VecDeque::new(), signal, closed: false }
    }

    pub fn write(&self, b: &[u8]) {
        self.io.write(b)
    }

    fn check(&self) -> Result<()> {
        if self.signal.is_cancelled() {
            bail!("Cancelled");
        }
        Ok(())
    }

    /// Wait for more data until `until`. Returns false on timeout.
    async fn wait(&mut self, until: Instant) -> Result<bool> {
        self.check()?;
        if self.closed {
            tokio::time::sleep_until(until).await;
            self.check()?;
            return Ok(false);
        }
        let notified = self.signal.notify.notified();
        tokio::select! {
            d = self.io.rx.recv() => match d {
                Some(d) => self.buf.extend(d),
                None => self.closed = true,
            },
            _ = tokio::time::sleep_until(until) => { self.check()?; return Ok(false) }
            _ = notified => {}
        }
        self.check()?;
        Ok(true)
    }

    /// Next byte, or None on timeout.
    pub async fn byte(&mut self, ms: u64) -> Result<Option<u8>> {
        self.check()?;
        let until = Instant::now() + Duration::from_millis(ms);
        while self.buf.is_empty() {
            if Instant::now() >= until || !self.wait(until).await? && self.buf.is_empty() {
                return Ok(None);
            }
        }
        Ok(self.buf.pop_front())
    }

    /// Exactly n bytes, or None on timeout.
    pub async fn bytes(&mut self, n: usize, ms: u64) -> Result<Option<Vec<u8>>> {
        let until = Instant::now() + Duration::from_millis(ms);
        while self.buf.len() < n {
            if Instant::now() >= until || !self.wait(until).await? && self.buf.len() < n {
                return Ok(None);
            }
        }
        Ok(Some(self.buf.drain(..n).collect()))
    }

    pub fn flush(&mut self) {
        self.buf.clear();
        while let Ok(d) = self.io.rx.try_recv() {
            drop(d);
        }
    }

    pub fn unread(&mut self, b: u8) {
        self.buf.push_front(b);
    }
}

pub fn block(num: usize, data: &[u8], size: usize, crc: bool, pad: u8) -> Vec<u8> {
    let mut payload = vec![pad; size];
    payload[..data.len()].copy_from_slice(data);
    let n = (num & 0xff) as u8;
    let mut out = vec![if size == 1024 { STX } else { SOH }, n, 0xff - n];
    out.extend_from_slice(&payload);
    if crc {
        out.extend_from_slice(&crc16(&payload).to_be_bytes());
    } else {
        out.push(checksum(&payload));
    }
    out
}

fn cancel(rd: &Reader) {
    rd.write(&[CAN, CAN, CAN, CAN, CAN, 8, 8, 8, 8, 8]);
}

/// Wait for the receiver to start: 'C' = CRC mode, NAK = checksum mode.
async fn wait_start(rd: &mut Reader) -> Result<bool> {
    let until = Instant::now() + Duration::from_secs(60);
    let mut cans = 0;
    while Instant::now() < until {
        let left = until.saturating_duration_since(Instant::now()).as_millis() as u64;
        match rd.byte(left).await? {
            Some(CRC_C) => return Ok(true),
            Some(NAK) => return Ok(false),
            Some(CAN) => {
                cans += 1;
                if cans >= 2 {
                    bail!("Cancelled by the receiver");
                }
            }
            _ => {}
        }
    }
    bail!("The receiver did not start (no \"C\" or NAK within 60 s). Start the receive command on the device first.")
}

async fn send_block(rd: &mut Reader, pkt: &[u8]) -> Result<()> {
    for _ in 0..MAX_ERRORS {
        rd.write(pkt);
        let r = rd.byte(10000).await?;
        if r == Some(ACK) {
            return Ok(());
        }
        if r == Some(CAN) && rd.byte(1000).await? == Some(CAN) {
            bail!("Cancelled by the receiver");
        }
    }
    bail!("Too many errors; the receiver kept rejecting blocks")
}

async fn send_eot(rd: &mut Reader) -> Result<()> {
    for _ in 0..MAX_ERRORS {
        rd.write(&[EOT]);
        if rd.byte(10000).await? == Some(ACK) {
            return Ok(());
        }
    }
    bail!("The receiver did not acknowledge the end of the file")
}

async fn send_data(rd: &mut Reader, data: &[u8], crc: bool, size: usize, progress: Option<Progress<'_>>, name: &str) -> Result<()> {
    let mut num = 1;
    let mut off = 0;
    while off < data.len() {
        let end = (off + size).min(data.len());
        send_block(rd, &block(num, &data[off..end], size, crc, SUB)).await?;
        num += 1;
        if let Some(p) = progress {
            p(json!({ "name": name, "bytes": end, "size": data.len() }));
        }
        off += size;
    }
    send_eot(rd).await
}

fn base_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn mtime_secs(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// Send files. protocol: 'xmodem' (128-byte blocks), 'xmodem-1k' or 'ymodem' (batch, sends names
/// and sizes).
pub async fn send(io: Io, files: &[PathBuf], protocol: &str, signal: Arc<Signal>, progress: Option<Progress<'_>>) -> Result<()> {
    let mut rd = Reader::new(io, signal.clone());
    let res = send_inner(&mut rd, files, protocol, progress).await;
    if let Err(e) = &res {
        if signal.is_cancelled() || !e.to_string().contains("receiver") {
            cancel(&rd);
        }
    }
    res
}

async fn send_inner(rd: &mut Reader, files: &[PathBuf], protocol: &str, progress: Option<Progress<'_>>) -> Result<()> {
    if protocol != "ymodem" {
        let data = tokio::fs::read(&files[0]).await?;
        let crc = wait_start(rd).await?;
        rd.flush();
        // 1K blocks need CRC; fall back to 128-byte blocks for checksum-only receivers.
        let size = if protocol == "xmodem-1k" && crc { 1024 } else { 128 };
        return send_data(rd, &data, crc, size, progress, &base_name(&files[0])).await;
    }
    for file in files {
        let data = tokio::fs::read(file).await?;
        wait_start(rd).await?;
        rd.flush();
        let mut header = base_name(file).into_bytes();
        header.push(0);
        header.extend_from_slice(format!("{} {:o}", data.len(), mtime_secs(file)).as_bytes());
        header.push(0);
        let size = if header.len() > 128 { 1024 } else { 128 };
        if header.len() > 1024 {
            bail!("File name too long for YMODEM");
        }
        send_block(rd, &block(0, &header, size, true, 0)).await?;
        wait_start(rd).await?;
        rd.flush();
        send_data(rd, &data, true, 1024, progress, &base_name(file)).await?;
    }
    wait_start(rd).await?;
    send_block(rd, &block(0, &[], 128, true, 0)).await // an empty name ends the batch
}

enum Block {
    Data(u8, Vec<u8>),
    Eot,
    Bad,
}

/// Read one block; None on timeout.
async fn read_block(rd: &mut Reader, crc: bool, ms: u64) -> Result<Option<Block>> {
    let Some(h) = rd.byte(ms).await? else { return Ok(None) };
    if h == EOT {
        return Ok(Some(Block::Eot));
    }
    if h == CAN {
        if rd.byte(1000).await? == Some(CAN) {
            bail!("Cancelled by the sender");
        }
        return Ok(Some(Block::Bad));
    }
    if h != SOH && h != STX {
        return Ok(Some(Block::Bad));
    }
    let size = if h == STX { 1024 } else { 128 };
    let Some(rest) = rd.bytes(2 + size + if crc { 2 } else { 1 }, 5000).await? else { return Ok(Some(Block::Bad)) };
    let num = rest[0];
    let data = &rest[2..2 + size];
    let ok = rest[1] == 0xff - num && if crc { u16::from_be_bytes([rest[2 + size], rest[3 + size]]) == crc16(data) } else { rest[2 + size] == checksum(data) };
    Ok(Some(if ok { Block::Data(num, data.to_vec()) } else { Block::Bad }))
}

/// A local file name for a received file: safe, inside dir, never overwriting.
pub fn target_path(dir: &Path, name: &str) -> PathBuf {
    let name = if name.is_empty() { "received.bin".to_string() } else { name.replace('\\', "/") };
    let mut base = name.rsplit('/').next().unwrap_or("").to_string();
    if !is_safe_file_name(&base) {
        base = "received.bin".into();
    }
    let mut file = dir.join(&base);
    let p = PathBuf::from(&base);
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let stem = if ext.is_empty() { base.clone() } else { base[..base.len() - ext.len()].to_string() };
    let mut i = 1;
    while file.exists() {
        file = dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    file
}

enum Out<'a> {
    Mem(&'a mut Vec<u8>),
    File(&'a mut tokio::fs::File),
}

/// Receive the data blocks of one file until EOT.
async fn receive_data(
    rd: &mut Reader,
    crc: bool,
    mut out: Out<'_>,
    expected: Option<u64>,
    progress: Option<Progress<'_>>,
    name: &str,
    ymodem: bool,
) -> Result<u64> {
    let mut next: usize = 1;
    let mut bytes: u64 = 0;
    let mut errors = 0;
    let mut eots = 0;
    loop {
        match read_block(rd, crc, 10000).await? {
            None | Some(Block::Bad) => {
                errors += 1;
                if errors > MAX_ERRORS {
                    bail!("Too many errors receiving the file");
                }
                rd.flush();
                rd.write(&[NAK]);
            }
            Some(Block::Eot) => {
                // YMODEM convention: NAK the first EOT, ACK the second.
                if ymodem && eots == 0 {
                    eots += 1;
                    rd.write(&[NAK]);
                    continue;
                }
                rd.write(&[ACK]);
                return Ok(bytes);
            }
            Some(Block::Data(num, data)) => {
                if num == ((next.wrapping_sub(1)) & 0xff) as u8 {
                    rd.write(&[ACK]); // duplicate
                    continue;
                }
                if num != (next & 0xff) as u8 {
                    bail!("Block sequence error");
                }
                let mut data = &data[..];
                if let Some(exp) = expected {
                    let n = (exp.saturating_sub(bytes) as usize).min(data.len());
                    data = &data[..n];
                }
                match &mut out {
                    Out::Mem(v) => v.extend_from_slice(data),
                    Out::File(f) => f.write_all(data).await?,
                }
                bytes += data.len() as u64;
                next += 1;
                errors = 0;
                rd.write(&[ACK]);
                if let Some(p) = progress {
                    p(json!({ "name": name, "bytes": bytes, "size": expected.unwrap_or(0) }));
                }
            }
        }
    }
}

/// Start a receive: send 'C' until the sender answers (falls back to checksum NAKs for XMODEM).
async fn start_receive(rd: &mut Reader, allow_checksum: bool) -> Result<bool> {
    for i in 0..20 {
        let crc = !(allow_checksum && i >= 10);
        rd.write(&[if crc { CRC_C } else { NAK }]);
        if let Some(h) = rd.byte(3000).await? {
            rd.unread(h);
            return Ok(crc);
        }
    }
    bail!("The sender did not start within 60 s. Start the send command on the device first.")
}

/// Receive into `dir`. XMODEM has no file names, so `name` is used; YMODEM gets names and sizes
/// from the sender (sanitized: no paths, never overwriting). Returns the saved file paths.
pub async fn receive(io: Io, dir: &Path, protocol: &str, name: &str, signal: Arc<Signal>, progress: Option<Progress<'_>>) -> Result<Vec<PathBuf>> {
    let mut rd = Reader::new(io, signal);
    let mut tmp: Option<PathBuf> = None;
    let res = receive_inner(&mut rd, dir, protocol, name, progress, &mut tmp).await;
    if let Err(e) = &res {
        if !e.to_string().contains("sender") {
            cancel(&rd);
        }
    }
    if let Some(t) = tmp {
        let _ = tokio::fs::remove_file(t).await;
    }
    res
}

async fn receive_inner(
    rd: &mut Reader,
    dir: &Path,
    protocol: &str,
    name: &str,
    progress: Option<Progress<'_>>,
    tmp: &mut Option<PathBuf>,
) -> Result<Vec<PathBuf>> {
    let mut saved = Vec::new();
    if protocol != "ymodem" {
        let file = target_path(dir, name);
        let part = PathBuf::from(format!("{}.part", file.display()));
        *tmp = Some(part.clone());
        let mut fh = tokio::fs::File::create(&part).await?;
        let crc = start_receive(rd, true).await?;
        let mut data = Vec::new();
        receive_data(rd, crc, Out::Mem(&mut data), None, progress, &base_name(&file), false).await?;
        // XMODEM pads the last block with SUB (0x1A); remove the padding.
        let mut end = data.len();
        while end > 0 && data[end - 1] == SUB && end + 128 > data.len() {
            end -= 1;
        }
        fh.write_all(&data[..end]).await?;
        fh.flush().await?;
        drop(fh);
        tokio::fs::rename(&part, &file).await?;
        *tmp = None;
        saved.push(file);
        return Ok(saved);
    }
    loop {
        start_receive(rd, false).await?;
        let b0 = read_block(rd, true, 10000).await?;
        let Some(Block::Data(0, data)) = b0 else { bail!("Expected a YMODEM header block") };
        rd.write(&[ACK]);
        let text: String = data.iter().map(|&b| b as char).collect();
        let mut parts = text.splitn(2, '\0');
        let raw_name = parts.next().unwrap_or("").to_string();
        if raw_name.is_empty() {
            return Ok(saved); // empty header: end of batch
        }
        let meta = parts.next().unwrap_or("");
        let size = meta.split('\0').next().unwrap_or("").split(' ').next().unwrap_or("").parse::<u64>().ok();
        let file = target_path(dir, &raw_name);
        let part = PathBuf::from(format!("{}.part", file.display()));
        *tmp = Some(part.clone());
        let mut fh = tokio::fs::File::create(&part).await?;
        rd.write(&[CRC_C]);
        receive_data(rd, true, Out::File(&mut fh), size, progress, &base_name(&file), true).await?;
        fh.flush().await?;
        fh.seek(std::io::SeekFrom::Start(0)).await?;
        drop(fh);
        tokio::fs::rename(&part, &file).await?;
        *tmp = None;
        saved.push(file);
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Two connected ends of a serial line; side A can corrupt one byte of its Nth large packet.
    /// `count_all`: number every write (ZMODEM tests) or only the large ones (XMODEM tests).
    pub fn line(corrupt: Vec<usize>, threshold: usize, at: usize, mask: u8, count_all: bool) -> (Io, Io) {
        let (to_b, b_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (to_a, a_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let n = std::sync::Mutex::new(0usize);
        let a = Io {
            write: Arc::new(move |buf: &[u8]| {
                let mut buf = buf.to_vec();
                let mut k = n.lock().unwrap();
                let large = buf.len() > threshold;
                if large && corrupt.contains(&*k) {
                    buf[at] ^= mask;
                }
                if large || count_all {
                    *k += 1;
                }
                let _ = to_b.send(buf);
            }),
            rx: a_rx,
        };
        let b = Io {
            write: Arc::new(move |buf: &[u8]| {
                let _ = to_a.send(buf.to_vec());
            }),
            rx: b_rx,
        };
        (a, b)
    }

    pub fn random_bytes(n: usize) -> Vec<u8> {
        (0..n).map(|_| rand::random::<u8>()).collect()
    }

    #[test]
    fn crc16_check_value() {
        assert_eq!(crc16(b"123456789"), 0x31c3);
    }

    #[tokio::test]
    async fn xmodem_variants_survive_a_corrupted_block() {
        for protocol in ["xmodem", "xmodem-1k"] {
            let dir = crate::store::tests::tmp("xm");
            let src = dir.join("c2960-lanbase.bin");
            let data = random_bytes(5000);
            std::fs::write(&src, &data).unwrap();
            let out = dir.join("out");
            std::fs::create_dir(&out).unwrap();
            // XMODEM counts every large packet; corrupt the third one.
            let (a, b) = line(vec![2], 100, 50, 0xff, false);
            let s = Arc::new(Signal::default());
            let srcs = [src];
            let (r1, r2) = tokio::join!(send(a, &srcs, protocol, s.clone(), None), receive(b, &out, protocol, "image.bin", s, None));
            r1.unwrap();
            let files = r2.unwrap();
            assert_eq!(std::fs::read(&files[0]).unwrap(), data, "{protocol}");
        }
    }

    #[tokio::test]
    async fn ymodem_batch_keeps_names_and_sizes() {
        let dir = crate::store::tests::tmp("ym");
        let f1 = dir.join("boot.cfg");
        let f2 = dir.join("image.bin");
        std::fs::write(&f1, "boot system flash:image.bin\n").unwrap();
        std::fs::write(&f2, random_bytes(3000)).unwrap();
        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        std::fs::write(out.join("boot.cfg"), "existing").unwrap();
        let (a, b) = line(vec![], usize::MAX, 0, 0, false);
        let s = Arc::new(Signal::default());
        let srcs = [f1, f2.clone()];
        let (r1, r2) = tokio::join!(send(a, &srcs, "ymodem", s.clone(), None), receive(b, &out, "ymodem", "", s, None));
        r1.unwrap();
        let files = r2.unwrap();
        let names: Vec<String> = files.iter().map(|f| base_name(f)).collect();
        assert_eq!(names, vec!["boot (1).cfg", "image.bin"]);
        assert_eq!(std::fs::read_to_string(out.join("boot.cfg")).unwrap(), "existing");
        assert_eq!(std::fs::read(&files[1]).unwrap(), std::fs::read(&f2).unwrap());
    }

    #[tokio::test]
    async fn ymodem_sender_cannot_choose_a_path() {
        let dir = crate::store::tests::tmp("ymevil");
        let out = dir.join("out");
        std::fs::create_dir(&out).unwrap();
        let (mut a, b) = line(vec![], usize::MAX, 0, 0, false);
        let s = Arc::new(Signal::default());
        let recv = tokio::spawn({
            let out = out.clone();
            async move { receive(b, &out, "ymodem", "", s, None).await }
        });
        async fn wait(a: &mut Io, byte: u8) {
            loop {
                let d = tokio::time::timeout(Duration::from_secs(5), a.rx.recv()).await.unwrap().unwrap();
                if d.contains(&byte) {
                    while a.rx.try_recv().is_ok() {}
                    return;
                }
            }
        }
        wait(&mut a, CRC_C).await;
        a.write(&block(0, b"../../evil.sh\x005 0\x00", 128, true, 0));
        wait(&mut a, CRC_C).await;
        a.write(&block(1, b"pwned", 128, true, SUB));
        wait(&mut a, ACK).await;
        a.write(&[EOT]);
        wait(&mut a, NAK).await;
        a.write(&[EOT]);
        wait(&mut a, CRC_C).await;
        a.write(&block(0, &[], 128, true, 0));
        let files = recv.await.unwrap().unwrap();
        assert_eq!(files[0].parent().unwrap(), out);
        assert_eq!(base_name(&files[0]), "evil.sh");
        assert_eq!(std::fs::read_to_string(&files[0]).unwrap(), "pwned");
        assert!(!dir.join("..").join("evil.sh").exists());
    }

    #[tokio::test]
    async fn cancel_stops_both_sides() {
        let dir = crate::store::tests::tmp("xmcancel");
        let src = dir.join("big.bin");
        std::fs::write(&src, random_bytes(200000)).unwrap();
        let (a, b) = line(vec![], usize::MAX, 0, 0, false);
        let signal = Arc::new(Signal::default());
        let sig2 = signal.clone();
        let progress = move |p: Value| {
            if p["bytes"].as_u64().unwrap() > 20000 && !sig2.is_cancelled() {
                sig2.cancel();
            }
        };
        let srcs = [src];
        let (r1, r2) =
            tokio::join!(send(a, &srcs, "xmodem-1k", signal, Some(&progress)), receive(b, &dir, "xmodem", "got.bin", Arc::new(Signal::default()), None));
        assert!(r1.unwrap_err().to_string().contains("Cancelled"));
        assert!(r2.unwrap_err().to_string().contains("Cancelled by the sender"));
        assert!(!dir.join("got.bin").exists() && !dir.join("got.bin.part").exists());
    }
}
