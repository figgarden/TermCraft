// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * A small TFTP server (RFC 1350 with the RFC 2347/2348/2349 option extensions: blksize, tsize,
 * timeout) for copying IOS images and configs to and from network devices:
 *   copy tftp://<this computer>/c2960-image.bin flash:      copy running-config tftp://<this computer>/sw1.cfg
 * Files are served from one folder only. Uploads (device -> here) are off unless enabled, never
 * overwrite unless allowed, and are written to a temporary file that is renamed when complete.
 */
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };
const ERR = { NOT_DEFINED: 0, NOT_FOUND: 1, ACCESS: 2, DISK_FULL: 3, ILLEGAL: 4, UNKNOWN_TID: 5, EXISTS: 6, BAD_OPTION: 8 };
const MAX_RETRIES = 5;

function errorPacket(code, msg) {
  const m = Buffer.from(String(msg).slice(0, 200), 'ascii');
  const b = Buffer.alloc(5 + m.length);
  b.writeUInt16BE(OP.ERROR, 0);
  b.writeUInt16BE(code, 2);
  m.copy(b, 4);
  return b;
}

/** Parse RRQ/WRQ: filename, mode and options. Returns null when malformed. */
function parseRequest(buf) {
  const parts = buf.subarray(2).toString('latin1').split('\0');
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const options = {};
  for (let i = 2; i + 1 < parts.length; i += 2) if (parts[i]) options[parts[i].toLowerCase()] = parts[i + 1];
  return { filename: parts[0], mode: parts[1].toLowerCase(), options };
}

/** Resolve a requested name inside root. Rejects absolute paths, drive letters and "..". */
function resolveInRoot(root, name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || /(^|\/)\.\.(\/|$)/.test(clean) || /^[a-z]:/i.test(clean) || clean.includes('\0')) return null;
  const full = path.resolve(root, clean);
  const rootFull = path.resolve(root);
  return full.startsWith(rootFull + path.sep) ? full : null;
}

class TftpServer extends EventEmitter {
  /** @param {{ root: string, port?: number, host?: string, allowWrite?: boolean, allowOverwrite?: boolean }} opts */
  constructor(opts) {
    super();
    this.opts = { port: 69, host: '0.0.0.0', allowWrite: false, allowOverwrite: false, ...opts };
    this.sock = null;
    this.transfers = new Set();
    this.seq = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      const family = this.opts.host.includes(':') ? 'udp6' : 'udp4';
      this.sock = dgram.createSocket({ type: family, reuseAddr: false });
      this.sock.once('error', (e) => {
        this.sock = null;
        reject(e.code === 'EACCES'
          ? new Error(`Port ${this.opts.port} needs administrator rights on this system. Use a port above 1023, or allow it (Linux: sudo setcap cap_net_bind_service=+ep on the app).`)
          : e.code === 'EADDRINUSE' ? new Error(`Port ${this.opts.port} is already in use (another TFTP server?)`) : e);
      });
      this.sock.on('message', (msg, rinfo) => this._onRequest(msg, rinfo));
      this.sock.bind(this.opts.port, this.opts.host, () => {
        this.sock.removeAllListeners('error');
        this.sock.on('error', (e) => this.emit('log', `Server error: ${e.message}`));
        resolve(this.sock.address());
      });
    });
  }

  stop() {
    for (const t of this.transfers) t.abort('Server stopped');
    this.transfers.clear();
    try { this.sock?.close(); } catch { /* closed */ }
    this.sock = null;
  }

  get running() { return !!this.sock; }

  _onRequest(msg, rinfo) {
    if (msg.length < 4) return;
    const op = msg.readUInt16BE(0);
    if (op !== OP.RRQ && op !== OP.WRQ) return; // stray packets to the listening port are ignored
    const req = parseRequest(msg);
    const peer = `${rinfo.address}:${rinfo.port}`;
    const reply = (buf) => this.sock?.send(buf, rinfo.port, rinfo.address);
    if (!req) return reply(errorPacket(ERR.ILLEGAL, 'Malformed request'));
    if (!['octet', 'netascii', 'binary'].includes(req.mode)) return reply(errorPacket(ERR.ILLEGAL, `Unsupported mode ${req.mode}`));
    const file = resolveInRoot(this.opts.root, req.filename);
    if (!file) {
      this.emit('log', `Refused ${peer}: "${req.filename}" is outside the TFTP folder`);
      return reply(errorPacket(ERR.ACCESS, 'Access violation'));
    }
    if (op === OP.WRQ && !this.opts.allowWrite) {
      this.emit('log', `Refused upload of "${req.filename}" from ${peer}: uploads are turned off`);
      return reply(errorPacket(ERR.ACCESS, 'Uploads are disabled'));
    }
    const t = new Transfer(this, ++this.seq, op === OP.RRQ ? 'send' : 'receive', file, req, rinfo);
    this.transfers.add(t);
    t.on('end', () => this.transfers.delete(t));
    t.start();
  }
}

/** One transfer on its own UDP socket (the server's transfer ID). */
class Transfer extends EventEmitter {
  constructor(server, id, dir, file, req, rinfo) {
    super();
    Object.assign(this, { server, id, dir, file, req, rinfo });
    this.name = path.relative(path.resolve(server.opts.root), file).split(path.sep).join('/');
    this.peer = `${rinfo.address}:${rinfo.port}`;
    this.blksize = 512;
    this.timeoutMs = 3000;
    this.bytes = 0;
    this.size = 0;
    this.done = false;
    this.timer = null;
    this.retries = 0;
    this.lastPacket = null;
  }

  info(state, extra = {}) {
    this.server.emit('transfer', { id: this.id, dir: this.dir, name: this.name, peer: this.peer, state, bytes: this.bytes, size: this.size, ...extra });
  }

  start() {
    this.sock = dgram.createSocket(this.rinfo.family === 'IPv6' ? 'udp6' : 'udp4');
    this.sock.on('message', (msg, r) => {
      if (r.address !== this.rinfo.address || r.port !== this.rinfo.port) {
        this.sock.send(errorPacket(ERR.UNKNOWN_TID, 'Unknown transfer ID'), r.port, r.address);
        return;
      }
      this._onPacket(msg);
    });
    this.sock.on('error', (e) => this.abort(e.message));
    this.sock.bind(0, () => this._begin().catch((e) => this.fail(ERR.NOT_DEFINED, e.message)));
  }

  _negotiate() {
    const o = this.req.options;
    const ack = {};
    if (o.blksize) { const n = Math.min(65464, Math.max(8, Number(o.blksize) || 512)); this.blksize = n; ack.blksize = String(n); }
    if (o.timeout) { const n = Math.min(255, Math.max(1, Number(o.timeout) || 3)); this.timeoutMs = n * 1000; ack.timeout = String(n); }
    if (o.tsize !== undefined) ack.tsize = String(this.dir === 'send' ? this.size : Number(o.tsize) || 0);
    if (this.dir === 'receive' && o.tsize) this.size = Number(o.tsize) || 0;
    return Object.keys(ack).length ? ack : null;
  }

  _oack(ack) {
    const parts = Object.entries(ack).flatMap(([k, v]) => [k, v]).join('\0') + '\0';
    const b = Buffer.alloc(2 + Buffer.byteLength(parts));
    b.writeUInt16BE(OP.OACK, 0);
    b.write(parts, 2, 'latin1');
    return b;
  }

  async _begin() {
    if (this.dir === 'send') {
      let st;
      try { st = await fs.promises.stat(this.file); } catch { return this.fail(ERR.NOT_FOUND, 'File not found'); }
      if (!st.isFile()) return this.fail(ERR.NOT_FOUND, 'File not found');
      this.size = st.size;
      this.fd = await fs.promises.open(this.file, 'r');
      this.info('started');
      const ack = this._negotiate();
      this.block = 0;
      if (ack) this._send(this._oack(ack)); // the client ACKs block 0, then data starts
      else await this._sendBlock(1);
    } else {
      if (fs.existsSync(this.file) && !this.server.opts.allowOverwrite) return this.fail(ERR.EXISTS, 'File already exists');
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      this.tmp = `${this.file}.part-${process.pid}-${this.id}`;
      this.fd = await fs.promises.open(this.tmp, 'w', 0o644);
      this.info('started');
      const ack = this._negotiate();
      this.block = 0;
      this._send(ack ? this._oack(ack) : this._ack(0));
    }
  }

  _ack(n) { const b = Buffer.alloc(4); b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(n & 0xffff, 2); return b; }

  _send(buf) {
    this.lastPacket = buf;
    this.retries = 0;
    this.sock.send(buf, this.rinfo.port, this.rinfo.address);
    this._arm();
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.done) return;
      if (++this.retries > MAX_RETRIES) return this.fail(ERR.NOT_DEFINED, 'Timed out', false);
      this.sock.send(this.lastPacket, this.rinfo.port, this.rinfo.address);
      this._arm();
    }, this.timeoutMs);
  }

  async _sendBlock(n) {
    const buf = Buffer.alloc(4 + this.blksize);
    const { bytesRead } = await this.fd.read(buf, 4, this.blksize, (n - 1) * this.blksize);
    buf.writeUInt16BE(OP.DATA, 0);
    buf.writeUInt16BE(n & 0xffff, 2); // block numbers roll over after 65535 for large images
    this.block = n;
    this.lastLen = bytesRead;
    this.bytes = Math.min(this.size, (n - 1) * this.blksize + bytesRead);
    this._send(buf.subarray(0, 4 + bytesRead));
    this._progress();
  }

  _progress() {
    const now = Date.now();
    if (now - (this.lastInfo || 0) > 250) { this.lastInfo = now; this.info('progress'); }
  }

  async _onPacket(msg) {
    if (msg.length < 4) return;
    const op = msg.readUInt16BE(0);
    if (this.done) {
      // The client lost our final ACK and is re-sending its last block: acknowledge it again.
      if (this.dir === 'receive' && op === OP.DATA && msg.readUInt16BE(2) === (this.block & 0xffff)) this.sock.send(this._ack(this.block), this.rinfo.port, this.rinfo.address);
      return;
    }
    if (op === OP.ERROR) return this.abort(`Peer error: ${msg.subarray(4).toString('ascii').replace(/\0.*$/, '')}`);
    if (this.dir === 'send' && op === OP.ACK) {
      if (msg.readUInt16BE(2) !== (this.block & 0xffff)) return; // duplicate ACK: ignore (no sorcerer's apprentice)
      if (this.block > 0 && this.lastLen < this.blksize) return this.finish();
      await this._sendBlock(this.block + 1).catch((e) => this.fail(ERR.NOT_DEFINED, e.message));
    } else if (this.dir === 'receive' && op === OP.DATA) {
      const n = msg.readUInt16BE(2);
      const expected = (this.block + 1) & 0xffff;
      if (n !== expected) { if (n === (this.block & 0xffff)) this.sock.send(this._ack(n), this.rinfo.port, this.rinfo.address); return; }
      const data = msg.subarray(4);
      if (data.length > this.blksize) return this.fail(ERR.ILLEGAL, 'Block too large');
      try { await this.fd.write(data, 0, data.length, this.block * this.blksize); } catch (e) { return this.fail(ERR.DISK_FULL, e.message); }
      this.block++;
      this.bytes += data.length;
      // Last block: the file is complete and renamed before the device is told it succeeded.
      if (data.length < this.blksize && !(await this.finish())) return;
      this._send(this._ack(n));
      this._progress();
    } else {
      this.fail(ERR.ILLEGAL, 'Unexpected packet');
    }
  }

  async finish() {
    if (this.done) return false;
    this.done = true;
    clearTimeout(this.timer);
    await this.fd?.close().catch(() => {});
    this.fd = null;
    if (this.dir === 'receive') {
      try { await fs.promises.rename(this.tmp, this.file); } catch (e) { this._end('failed', e.message); return false; }
      this.tmp = null;
    }
    // Keep the socket briefly so a lost final ACK can be re-sent when the client retransmits.
    setTimeout(() => { try { this.sock.close(); } catch { /* closed */ } }, this.dir === 'receive' ? this.timeoutMs : 0);
    this.info('done');
    this.emit('end');
    return true;
  }

  fail(code, msg, notify = true) {
    if (notify && this.sock) {
      // Close only after the error packet has actually gone out.
      try { this.sock.send(errorPacket(code, msg), this.rinfo.port, this.rinfo.address, () => this.abort(msg)); return; } catch { /* closed */ }
    }
    this.abort(msg);
  }

  abort(msg) {
    if (this.done) return;
    this.done = true;
    this._end('failed', msg);
  }

  _end(state, error) {
    clearTimeout(this.timer);
    this.fd?.close().catch(() => {});
    if (this.tmp) fs.promises.rm(this.tmp, { force: true }).catch(() => {});
    try { this.sock?.close(); } catch { /* closed */ }
    this.info(state, { error });
    this.emit('end');
  }
}

module.exports = { TftpServer, resolveInRoot, parseRequest };
