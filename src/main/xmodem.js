// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * XMODEM (checksum / CRC / 1K) and YMODEM batch file transfer over a terminal connection, usually
 * a serial console: recovering a router from ROMMON ("xmodem -c flash:image.bin"), loading a
 * switch bootloader, or "rb"/"sb" on a Linux console.
 *
 * `io` is { write(Buffer), onData(cb) -> unsubscribe }. Everything is timeout- and cancel-safe:
 * cancelling sends CAN CAN so the other side stops too.
 */
const fs = require('fs');
const path = require('path');
const { isSafeFileName } = require('./security');

const SOH = 0x01; const STX = 0x02; const EOT = 0x04; const ACK = 0x06; const NAK = 0x15; const CAN = 0x18; const SUB = 0x1a; const CRC_C = 0x43;
const MAX_ERRORS = 10;

function crc16(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
const checksum = (buf) => buf.reduce((a, b) => (a + b) & 0xff, 0);

/** Byte queue with "wait for N bytes / one of these bytes" helpers. */
class Reader {
  constructor(io, signal) {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.signal = signal;
    this.off = io.onData((d) => { this.buf = Buffer.concat([this.buf, d]); this._wake(); });
    signal.onCancel = () => this._wake();
  }
  _wake() { const w = this.waiter; this.waiter = null; w?.(); }
  async _wait(ms) {
    if (this.signal.cancelled) throw new Error('Cancelled');
    await new Promise((resolve) => { const t = setTimeout(() => { this.waiter = null; resolve(); }, ms); this.waiter = () => { clearTimeout(t); resolve(); }; });
    if (this.signal.cancelled) throw new Error('Cancelled');
  }
  /** Next byte, or -1 on timeout. */
  async byte(ms) {
    if (this.signal.cancelled) throw new Error('Cancelled');
    const until = Date.now() + ms;
    while (!this.buf.length) { const left = until - Date.now(); if (left <= 0) return -1; await this._wait(left); }
    const b = this.buf[0];
    this.buf = this.buf.subarray(1);
    return b;
  }
  /** Exactly n bytes, or null on timeout. */
  async bytes(n, ms) {
    const until = Date.now() + ms;
    while (this.buf.length < n) { const left = until - Date.now(); if (left <= 0) return null; await this._wait(left); }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  flush() { this.buf = Buffer.alloc(0); }
  close() { this.off(); }
}

function block(num, data, size, crc, pad = SUB) {
  const payload = Buffer.alloc(size, pad);
  data.copy(payload);
  const head = Buffer.from([size === 1024 ? STX : SOH, num & 0xff, 0xff - (num & 0xff)]);
  const tail = crc ? Buffer.from([crc16(payload) >> 8, crc16(payload) & 0xff]) : Buffer.from([checksum(payload)]);
  return Buffer.concat([head, payload, tail]);
}

const cancel = (io) => io.write(Buffer.from([CAN, CAN, CAN, CAN, CAN, 8, 8, 8, 8, 8]));

/** Wait for the receiver to start: 'C' = CRC mode, NAK = checksum mode. */
async function waitStart(rd, ms = 60000) {
  const until = Date.now() + ms;
  let cans = 0;
  while (Date.now() < until) {
    const b = await rd.byte(until - Date.now());
    if (b === CRC_C) return true;
    if (b === NAK) return false;
    if (b === CAN && ++cans >= 2) throw new Error('Cancelled by the receiver');
  }
  throw new Error('The receiver did not start (no "C" or NAK within 60 s). Start the receive command on the device first.');
}

async function sendBlock(io, rd, pkt) {
  for (let errors = 0; errors < MAX_ERRORS; errors++) {
    io.write(pkt);
    const r = await rd.byte(10000);
    if (r === ACK) return;
    if (r === CAN && (await rd.byte(1000)) === CAN) throw new Error('Cancelled by the receiver');
  }
  throw new Error('Too many errors; the receiver kept rejecting blocks');
}

async function sendEot(io, rd) {
  for (let errors = 0; errors < MAX_ERRORS; errors++) {
    io.write(Buffer.from([EOT]));
    if ((await rd.byte(10000)) === ACK) return;
  }
  throw new Error('The receiver did not acknowledge the end of the file');
}

async function sendData(io, rd, data, { crc, size, onProgress, firstBlock = 1, name }) {
  let num = firstBlock;
  for (let off = 0; off < data.length; off += size) {
    await sendBlock(io, rd, block(num++, data.subarray(off, off + size), size, crc));
    onProgress?.({ name, bytes: Math.min(off + size, data.length), size: data.length });
  }
  await sendEot(io, rd);
}

/**
 * Send files. protocol: 'xmodem' (128-byte blocks), 'xmodem-1k' or 'ymodem' (batch, sends names and sizes).
 */
async function send(io, files, { protocol = 'xmodem', onProgress, signal = {} } = {}) {
  const rd = new Reader(io, signal);
  try {
    if (protocol !== 'ymodem') {
      const data = await fs.promises.readFile(files[0]);
      const crc = await waitStart(rd);
      rd.flush();
      // 1K blocks need CRC; fall back to 128-byte blocks for checksum-only receivers.
      await sendData(io, rd, data, { crc, size: protocol === 'xmodem-1k' && crc ? 1024 : 128, onProgress, name: path.basename(files[0]) });
      return;
    }
    for (const file of files) {
      const data = await fs.promises.readFile(file);
      const st = await fs.promises.stat(file);
      await waitStart(rd);
      rd.flush();
      const header = Buffer.from(`${path.basename(file)}\0${data.length} ${Math.floor(st.mtimeMs / 1000).toString(8)}\0`, 'latin1');
      await sendBlock(io, rd, block(0, header, header.length > 128 ? 1024 : 128, true, 0));
      await waitStart(rd);
      rd.flush();
      await sendData(io, rd, data, { crc: true, size: 1024, onProgress, name: path.basename(file) });
    }
    await waitStart(rd);
    await sendBlock(io, rd, block(0, Buffer.alloc(0), 128, true, 0)); // an empty name ends the batch
  } catch (e) {
    if (signal.cancelled || !/receiver/.test(e.message)) cancel(io);
    throw e;
  } finally {
    rd.close();
  }
}

/** Read one block. Returns { type: 'data', num, data } | { type: 'eot' } | { type: 'bad' } | null on timeout. */
async function readBlock(rd, crc, ms) {
  const h = await rd.byte(ms);
  if (h === -1) return null;
  if (h === EOT) return { type: 'eot' };
  if (h === CAN) { if ((await rd.byte(1000)) === CAN) throw new Error('Cancelled by the sender'); return { type: 'bad' }; }
  if (h !== SOH && h !== STX) return { type: 'bad' };
  const size = h === STX ? 1024 : 128;
  const rest = await rd.bytes(2 + size + (crc ? 2 : 1), 5000);
  if (!rest) return { type: 'bad' };
  const num = rest[0];
  const data = rest.subarray(2, 2 + size);
  const ok = rest[1] === 0xff - num && (crc ? ((rest[2 + size] << 8) | rest[3 + size]) === crc16(data) : rest[2 + size] === checksum(data));
  return ok ? { type: 'data', num, data } : { type: 'bad' };
}

/** A local file name for a received file: safe, inside dir, never overwriting. */
function targetPath(dir, name) {
  let base = path.basename(String(name || 'received.bin').replace(/\\/g, '/'));
  if (!isSafeFileName(base)) base = 'received.bin';
  let file = path.join(dir, base);
  const ext = path.extname(base);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${path.basename(base, ext)} (${i})${ext}`);
  return file;
}

/** Receive the data blocks of one file into `out` until EOT. */
async function receiveData(io, rd, { crc, out, expected, onProgress, name, ymodem }) {
  let next = 1;
  let bytes = 0;
  let errors = 0;
  let eots = 0;
  for (;;) {
    const b = await readBlock(rd, crc, 10000);
    if (!b || b.type === 'bad') {
      if (++errors > MAX_ERRORS) throw new Error('Too many errors receiving the file');
      rd.flush();
      io.write(Buffer.from([NAK]));
      continue;
    }
    if (b.type === 'eot') {
      // YMODEM convention: NAK the first EOT, ACK the second.
      if (ymodem && eots++ === 0) { io.write(Buffer.from([NAK])); continue; }
      io.write(Buffer.from([ACK]));
      return bytes;
    }
    if (b.num === ((next - 1) & 0xff)) { io.write(Buffer.from([ACK])); continue; } // duplicate
    if (b.num !== (next & 0xff)) throw new Error('Block sequence error');
    let data = b.data;
    if (expected != null) data = data.subarray(0, Math.max(0, Math.min(data.length, expected - bytes)));
    await out.write(data);
    bytes += data.length;
    next++;
    errors = 0;
    io.write(Buffer.from([ACK]));
    onProgress?.({ name, bytes, size: expected || 0 });
  }
}

/** Start a receive: send 'C' until the sender answers (falls back to checksum NAKs for XMODEM). */
async function startReceive(io, rd, allowChecksum) {
  for (let i = 0; i < 20; i++) {
    const crc = !(allowChecksum && i >= 10);
    io.write(Buffer.from([crc ? CRC_C : NAK]));
    const h = await rd.byte(3000);
    if (h !== -1) { rd.buf = Buffer.concat([Buffer.from([h]), rd.buf]); return crc; }
  }
  throw new Error('The sender did not start within 60 s. Start the send command on the device first.');
}

/**
 * Receive into `dir`. XMODEM has no file names, so `name` is used; YMODEM gets names and sizes
 * from the sender (sanitized: no paths, never overwriting). Returns the saved file paths.
 */
async function receive(io, dir, { protocol = 'xmodem', name = 'received.bin', onProgress, signal = {} } = {}) {
  const rd = new Reader(io, signal);
  const saved = [];
  let fh = null;
  let tmp = null;
  try {
    if (protocol !== 'ymodem') {
      const file = targetPath(dir, name);
      tmp = `${file}.part`;
      fh = await fs.promises.open(tmp, 'w', 0o644);
      const crc = await startReceive(io, rd, true);
      const chunks = [];
      await receiveData(io, rd, { crc, out: { write: async (d) => chunks.push(d) }, onProgress, name: path.basename(file) });
      // XMODEM pads the last block with SUB (0x1A); remove the padding.
      let data = Buffer.concat(chunks);
      let end = data.length;
      while (end > 0 && data[end - 1] === SUB && end > data.length - 128) end--;
      data = data.subarray(0, end);
      await fh.write(data);
      await fh.close();
      fh = null;
      await fs.promises.rename(tmp, file);
      tmp = null;
      saved.push(file);
      return saved;
    }
    for (;;) {
      await startReceive(io, rd, false);
      const b0 = await readBlock(rd, true, 10000);
      if (!b0 || b0.type !== 'data' || b0.num !== 0) throw new Error('Expected a YMODEM header block');
      io.write(Buffer.from([ACK]));
      const [rawName, meta = ''] = b0.data.toString('latin1').split('\0');
      if (!rawName) return saved; // empty header: end of batch
      const size = Number(meta.split(' ')[0]);
      const file = targetPath(dir, rawName);
      tmp = `${file}.part`;
      fh = await fs.promises.open(tmp, 'w', 0o644);
      io.write(Buffer.from([CRC_C]));
      await receiveData(io, rd, { crc: true, out: { write: (d) => fh.write(d) }, expected: Number.isFinite(size) && size >= 0 ? size : null, onProgress, name: path.basename(file), ymodem: true });
      await fh.close();
      fh = null;
      await fs.promises.rename(tmp, file);
      tmp = null;
      saved.push(file);
    }
  } catch (e) {
    if (!/sender/.test(e.message)) cancel(io);
    throw e;
  } finally {
    rd.close();
    await fh?.close().catch(() => {});
    if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

module.exports = { send, receive, crc16, block, Reader, targetPath };
