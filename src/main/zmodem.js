// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * ZMODEM file transfer over a terminal connection: what "rz" (receive) and "sz" (send) speak on
 * Linux hosts and many embedded devices. Supports batches of files, CRC-16 and CRC-32 frames,
 * restarting from the last good position after a line error, and cancelling (both sides stop).
 *
 * `io` is { write(Buffer), onData(cb) -> unsubscribe }, the same as for XMODEM/YMODEM.
 */
const fs = require('fs');
const path = require('path');
const { Reader, crc16, targetPath } = require('./xmodem');

const ZPAD = 0x2a; const ZDLE = 0x18; const XON = 0x11;
const ZBIN = 0x41; const ZHEX = 0x42; const ZBIN32 = 0x43; // 'A' 'B' 'C'
const T = { ZRQINIT: 0, ZRINIT: 1, ZSINIT: 2, ZACK: 3, ZFILE: 4, ZSKIP: 5, ZNAK: 6, ZABORT: 7, ZFIN: 8, ZRPOS: 9, ZDATA: 10, ZEOF: 11, ZFERR: 12, ZCRC: 13, ZCHALLENGE: 14, ZCOMPL: 15, ZCAN: 16, ZFREECNT: 17, ZCOMMAND: 18 };
const ZCRCE = 0x68; const ZCRCG = 0x69; const ZCRCQ = 0x6a; const ZCRCW = 0x6b; const ZRUB0 = 0x6c; const ZRUB1 = 0x6d;
const CANFDX = 0x01; const CANOVIO = 0x02; const CANFC32 = 0x20; const ESCCTL = 0x40;
const SUBPACKET = 1024;
const WINDOW = 8; // subpackets sent before waiting for an ACK
const ABORT = Buffer.from([...Array(8).fill(0x18), ...Array(10).fill(0x08)]);
/** Bytes a ZMODEM receiver starts with ("rz" sends ZRINIT) and a sender starts with ("sz" sends ZRQINIT). */
const ZRINIT_START = Buffer.from('**\x18B01');
const ZRQINIT_START = Buffer.from('**\x18B00');

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const le32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const readLe32 = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
const hex = (buf) => Buffer.from(buf.toString('hex'), 'ascii');

/** ZDLE-escape bytes for the wire. */
function escape(buf, escctl = false) {
  const out = [];
  for (const b of buf) {
    // ZDLE, DLE, XON, XOFF (and their 8th-bit versions) and CR are always escaped; with ESCCTL all control characters.
    if (b === ZDLE || b === 0x10 || b === 0x90 || b === 0x11 || b === 0x91 || b === 0x13 || b === 0x93 || b === 0x0d || b === 0x8d
      || (escctl && ((b & 0x60) === 0))) out.push(ZDLE, b ^ 0x40);
    else if (b === 0x7f) out.push(ZDLE, ZRUB0);
    else if (b === 0xff) out.push(ZDLE, ZRUB1);
    else out.push(b);
  }
  return Buffer.from(out);
}

function hexHeader(type, data = Buffer.alloc(4)) {
  const body = Buffer.concat([Buffer.from([type]), data]);
  const crc = crc16(body);
  const tail = type === T.ZACK || type === T.ZFIN ? [0x0d, 0x8a] : [0x0d, 0x8a, XON];
  return Buffer.concat([Buffer.from([ZPAD, ZPAD, ZDLE, ZHEX]), hex(body), hex(Buffer.from([crc >> 8, crc & 0xff])), Buffer.from(tail)]);
}

function binHeader(type, data, escctl) {
  const body = Buffer.concat([Buffer.from([type]), data]);
  const crc = crc16(body);
  return Buffer.concat([Buffer.from([ZPAD, ZDLE, ZBIN]), escape(Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff])]), escctl)]);
}

function subpacket(data, end, escctl) {
  const crc = crc16(Buffer.concat([data, Buffer.from([end])]));
  return Buffer.concat([escape(data, escctl), Buffer.from([ZDLE, end]), escape(Buffer.from([crc >> 8, crc & 0xff]), escctl)]);
}

/** Frame-level reader on top of the byte Reader. */
class ZReader {
  constructor(rd) { this.rd = rd; this.cans = 0; }

  async byte(ms) {
    const b = await this.rd.byte(ms);
    if (b === -1) throw new Error('Timed out waiting for the other side');
    if (b === ZDLE) { if (++this.cans >= 5) throw new Error('Cancelled by the other side'); } else this.cans = 0;
    return b;
  }

  /** One data byte with ZDLE decoding; returns { end } for a subpacket end marker. */
  async escaped(ms) {
    for (;;) {
      let b = await this.byte(ms);
      if (b === 0x11 || b === 0x13 || b === 0x91 || b === 0x93) continue; // flow-control noise
      if (b !== ZDLE) return b;
      for (;;) {
        b = await this.byte(ms);
        if (b === 0x11 || b === 0x13 || b === 0x91 || b === 0x93) continue;
        if (b === ZCRCE || b === ZCRCG || b === ZCRCQ || b === ZCRCW) return { end: b };
        if (b === ZRUB0) return 0x7f;
        if (b === ZRUB1) return 0xff;
        if ((b & 0x60) === 0x40) return b ^ 0x40;
        throw new Error('Bad escape sequence');
      }
    }
  }

  /** Next header, or null on timeout. Returns { type, data, format } or { bad: true }. */
  async header(ms) {
    const until = Date.now() + ms;
    try {
      for (;;) {
        const left = until - Date.now();
        if (left <= 0) return null;
        let b = await this.byte(left);
        if (b !== ZPAD) continue;
        do b = await this.byte(5000); while (b === ZPAD);
        if (b !== ZDLE) continue;
        const fmt = await this.byte(5000);
        if (fmt === ZHEX) {
          const chars = [];
          for (let i = 0; i < 14; i++) chars.push(await this.byte(5000));
          const raw = Buffer.from(Buffer.from(chars).toString('ascii'), 'hex');
          if (raw.length !== 7 || crc16(raw.subarray(0, 5)) !== ((raw[5] << 8) | raw[6])) return { bad: true };
          return { type: raw[0], data: raw.subarray(1, 5), format: ZHEX };
        }
        if (fmt === ZBIN || fmt === ZBIN32) {
          const n = fmt === ZBIN ? 7 : 9;
          const raw = [];
          for (let i = 0; i < n; i++) { const x = await this.escaped(5000); if (typeof x !== 'number') return { bad: true }; raw.push(x); }
          const body = Buffer.from(raw.slice(0, 5));
          const ok = fmt === ZBIN ? crc16(body) === ((raw[5] << 8) | raw[6]) : crc32(body) === readLe32(Buffer.from(raw.slice(5, 9)));
          return ok ? { type: raw[0], data: Buffer.from(raw.slice(1, 5)), format: fmt } : { bad: true };
        }
      }
    } catch (e) {
      if (/Timed out/.test(e.message)) return null;
      if (/Bad escape/.test(e.message)) return { bad: true };
      throw e;
    }
  }

  /** A data subpacket: { data, end, ok }. */
  async subpacket(crc32mode, max = 8192 + 16) {
    const data = [];
    for (;;) {
      const x = await this.escaped(10000);
      if (typeof x === 'number') { data.push(x); if (data.length > max) return { ok: false }; continue; }
      const buf = Buffer.from(data);
      const crcLen = crc32mode ? 4 : 2;
      const c = [];
      for (let i = 0; i < crcLen; i++) { const y = await this.escaped(10000); if (typeof y !== 'number') return { ok: false }; c.push(y); }
      const withEnd = Buffer.concat([buf, Buffer.from([x.end])]);
      const ok = crc32mode ? crc32(withEnd) === readLe32(Buffer.from(c)) : crc16(withEnd) === ((c[0] << 8) | c[1]);
      return { data: buf, end: x.end, ok };
    }
  }
}

/**
 * Send files. Works whether the receiver started first ("rz" already running: its ZRINIT may be
 * waiting in the stream) or not (we send ZRQINIT until it answers).
 */
async function send(io, files, { onProgress, signal = {} } = {}) {
  const rd = new Reader(io, signal);
  const z = new ZReader(rd);
  try {
    let zrinit = null;
    for (let tries = 0; !zrinit && tries < 6; tries++) {
      if (tries) io.write(hexHeader(T.ZRQINIT));
      const h = await z.header(tries ? 10000 : 2000);
      if (h?.type === T.ZRINIT) zrinit = h;
      else if (h?.type === T.ZCHALLENGE) io.write(hexHeader(T.ZACK, h.data));
    }
    if (!zrinit) throw new Error('The receiver did not start. Run "rz" (or the device\'s ZMODEM receive command) first.');
    rd.flush(); // drop repeated ZRINITs so they aren't mistaken for answers later
    const escctl = !!(zrinit.data[3] & ESCCTL);
    const stats = await Promise.all(files.map((f) => fs.promises.stat(f)));
    let bytesLeft = stats.reduce((a, s) => a + s.size, 0);

    for (let i = 0; i < files.length; i++) {
      const data = await fs.promises.readFile(files[i]);
      const name = path.basename(files[i]);
      const info = Buffer.from(`${name}\0${data.length} ${Math.floor(stats[i].mtimeMs / 1000).toString(8)} 100644 0 ${files.length - i} ${bytesLeft}\0`, 'latin1');
      let pos = null;
      for (let tries = 0; pos === null && tries < 10; tries++) {
        io.write(binHeader(T.ZFILE, Buffer.from([0, 0, 0, 1]), escctl)); // ZF0 = ZCBIN (binary)
        io.write(subpacket(info, ZCRCW, escctl));
        const h = await z.header(15000);
        if (h?.type === T.ZRPOS) pos = readLe32(h.data);
        else if (h?.type === T.ZSKIP) pos = -1;
        else if (h?.type === T.ZFERR || h?.type === T.ZABORT) throw new Error('The receiver refused the file');
      }
      if (pos === null) throw new Error('The receiver did not accept the file');
      if (pos >= 0) await sendFileData(io, z, data, pos, { escctl, name, onProgress, signal });
      bytesLeft -= data.length;
    }

    for (let tries = 0; tries < 5; tries++) {
      io.write(hexHeader(T.ZFIN));
      const h = await z.header(5000);
      if (h?.type === T.ZFIN) break;
    }
    io.write(Buffer.from('OO'));
  } catch (e) {
    if (!/other side/.test(e.message)) io.write(ABORT);
    throw e;
  } finally {
    rd.close();
  }
}

async function sendFileData(io, z, data, startPos, { escctl, name, onProgress, signal }) {
  let pos = startPos;
  let errors = 0;
  for (;;) {
    if (signal.cancelled) throw new Error('Cancelled');
    io.write(binHeader(T.ZDATA, le32(pos), escctl));
    let restart = false;
    while (!restart) {
      if (pos >= data.length) {
        io.write(subpacket(Buffer.alloc(0), ZCRCE, escctl));
        break;
      }
      // Send a window of subpackets; the last one asks for an ACK (or ends the file).
      let sent = 0;
      while (sent < WINDOW && pos < data.length) {
        const chunk = data.subarray(pos, pos + SUBPACKET);
        const last = pos + chunk.length >= data.length;
        const end = last ? ZCRCE : sent === WINDOW - 1 ? ZCRCQ : ZCRCG;
        io.write(subpacket(chunk, end, escctl));
        pos += chunk.length;
        sent++;
        if (last) break;
      }
      onProgress?.({ name, bytes: pos, size: data.length });
      if (pos >= data.length) break;
      const h = await z.header(15000);
      if (h?.type === T.ZACK) continue;
      if (h?.type === T.ZRPOS) { pos = readLe32(h.data); restart = true; if (++errors > 20) throw new Error('Too many errors'); continue; }
      if (h?.type === T.ZSKIP) return;
      if (!h || h.bad) { restart = true; if (++errors > 20) throw new Error('Too many errors'); continue; }
      if (h.type === T.ZABORT || h.type === T.ZFERR || h.type === T.ZCAN) throw new Error('The receiver stopped the transfer');
    }
    if (restart) continue;
    // End of file: wait for the receiver to confirm (ZRINIT) or ask for a resend (ZRPOS).
    io.write(binHeader(T.ZEOF, le32(data.length), escctl));
    for (let tries = 0; ; tries++) {
      const h = await z.header(15000);
      if (h?.type === T.ZRINIT) return;
      if (h?.type === T.ZRPOS) { pos = readLe32(h.data); if (++errors > 20) throw new Error('Too many errors'); break; }
      if (h?.type === T.ZSKIP) return;
      if (tries >= 4) throw new Error('The receiver did not confirm the end of the file');
      if (!h || h.bad) io.write(binHeader(T.ZEOF, le32(data.length), escctl));
    }
  }
}

/** Receive a batch into `dir` (file names sanitized, never overwriting). Returns saved paths. */
async function receive(io, dir, { onProgress, signal = {} } = {}) {
  const rd = new Reader(io, signal);
  const z = new ZReader(rd);
  const saved = [];
  let cur = null; // { file, tmp, fh, pos, size, name }
  const zrinit = () => io.write(hexHeader(T.ZRINIT, Buffer.from([0, 0, 0, CANFDX | CANOVIO | CANFC32])));
  const closeCur = async (keep) => {
    if (!cur) return;
    await cur.fh.close().catch(() => {});
    if (keep) { await fs.promises.rename(cur.tmp, cur.file); saved.push(cur.file); } else await fs.promises.rm(cur.tmp, { force: true });
    cur = null;
  };
  try {
    zrinit();
    let idle = 0;
    for (;;) {
      if (signal.cancelled) throw new Error('Cancelled');
      const h = await z.header(10000);
      if (!h || h.bad) {
        if (++idle > 6) throw new Error('The sender stopped responding');
        if (cur) io.write(hexHeader(T.ZRPOS, le32(cur.pos))); else zrinit();
        continue;
      }
      idle = 0;
      switch (h.type) {
        case T.ZRQINIT: zrinit(); break;
        case T.ZSINIT: { await z.subpacket(h.format === ZBIN32); io.write(hexHeader(T.ZACK)); break; }
        case T.ZFILE: {
          const sp = await z.subpacket(h.format === ZBIN32);
          if (!sp.ok) { zrinit(); break; }
          const [rawName, meta = ''] = sp.data.toString('latin1').split('\0');
          await closeCur(false);
          const file = targetPath(dir, rawName);
          const tmp = `${file}.part`;
          cur = { file, tmp, fh: await fs.promises.open(tmp, 'w', 0o644), pos: 0, size: Number(meta.split(' ')[0]) || 0, name: path.basename(file) };
          io.write(hexHeader(T.ZRPOS, le32(0)));
          break;
        }
        case T.ZDATA: {
          if (!cur) { zrinit(); break; }
          if (readLe32(h.data) !== cur.pos) { io.write(hexHeader(T.ZRPOS, le32(cur.pos))); break; }
          for (;;) {
            const sp = await z.subpacket(h.format === ZBIN32).catch((e) => { if (/Cancelled|other side/.test(e.message)) throw e; return { ok: false }; });
            if (!sp.ok) { rd.flush(); io.write(hexHeader(T.ZRPOS, le32(cur.pos))); break; }
            await cur.fh.write(sp.data, 0, sp.data.length, cur.pos);
            cur.pos += sp.data.length;
            onProgress?.({ name: cur.name, bytes: cur.pos, size: cur.size });
            if (sp.end === ZCRCW || sp.end === ZCRCQ) io.write(hexHeader(T.ZACK, le32(cur.pos)));
            if (sp.end === ZCRCW || sp.end === ZCRCE) break;
          }
          break;
        }
        case T.ZEOF:
          if (cur && readLe32(h.data) === cur.pos) { await closeCur(true); zrinit(); }
          break;
        case T.ZFIN:
          await closeCur(false);
          io.write(hexHeader(T.ZFIN));
          await rd.bytes(2, 1000); // "OO"
          return saved;
        case T.ZCAN: case T.ZABORT:
          throw new Error('Cancelled by the other side');
        default: break;
      }
    }
  } catch (e) {
    if (!/other side/.test(e.message)) io.write(ABORT);
    throw e;
  } finally {
    rd.close();
    await closeCur(false).catch(() => {});
  }
}

/**
 * Look for the start of a ZMODEM transfer in terminal output.
 * @returns {null | { direction: 'send'|'receive', at: number }}  'send' = the device runs rz and waits for files.
 */
function detect(buf) {
  const r = buf.indexOf(ZRINIT_START);
  if (r >= 0) return { direction: 'send', at: r };
  const q = buf.indexOf(ZRQINIT_START);
  if (q >= 0) return { direction: 'receive', at: q };
  return null;
}

module.exports = { send, receive, detect, crc32, hexHeader, ABORT };
