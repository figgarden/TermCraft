// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { EventEmitter } = require('events');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { TelnetParser } = require('./telnet-parser');

class TcpBase extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.cols = 80;
    this.rows = 24;
    this.closed = false;
  }

  _open(defaultPort) {
    const s = this.session;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: s.host, port: Number(s.port) || defaultPort });
      this.sock = sock;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30000);
      sock.once('connect', () => { sock.removeListener('error', reject); resolve(); });
      sock.once('error', reject);
      sock.on('close', () => this._closed());
    });
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  close() { this.sock?.destroy(); this._closed(); }
}

class TelnetConnection extends TcpBase {
  async connect(cols, rows) {
    this.cols = cols; this.rows = rows;
    await this._open(23);
    this.parser = new TelnetParser({
      send: (b) => this.sock.write(b),
      data: (b) => this.emit('data', b),
      termType: this.session.terminal?.termType || 'xterm',
      size: () => [this.cols, this.rows],
    });
    this.sock.on('data', (d) => this.parser.feed(d));
    this.sock.on('error', (e) => this.emit('error', e));
    this.parser.start();
  }

  write(data) { this.sock?.write(TelnetParser.escape(Buffer.from(data))); }

  resize(cols, rows) { this.cols = cols; this.rows = rows; this.parser?.sendWindowSize(); }

  /** Telnet BREAK command. */
  sendBreak() { this.sock?.write(Buffer.from([255, 243])); }
}

class RawConnection extends TcpBase {
  async connect(cols, rows) {
    await this._open(23);
    this.sock.on('data', (d) => this.emit('data', d));
    this.sock.on('error', (e) => this.emit('error', e));
  }

  write(data) { this.sock?.write(data); }
  resize() {}
}

/**
 * RFC 1282 rlogin. Many servers require a privileged source port, which an
 * unprivileged desktop app cannot bind; such servers will reject the login.
 * Window-size updates need TCP urgent data, which Node cannot receive, so they are not sent.
 */
class RloginConnection extends TcpBase {
  async connect(cols, rows) {
    this.cols = cols; this.rows = rows;
    const s = this.session;
    const local = os.userInfo().username;
    await this._open(513);
    const term = `${s.terminal?.termType || 'xterm'}/38400`;
    this.sock.write(Buffer.from(`\0${local}\0${s.username || local}\0${term}\0`, 'utf8'));
    let first = true;
    this.sock.on('data', (d) => {
      if (first) { first = false; if (d[0] === 0) d = d.subarray(1); }
      if (d.length) this.emit('data', d);
    });
    this.sock.on('error', (e) => this.emit('error', e));
  }

  write(data) { this.sock?.write(data); }
  resize() {}
}

let SerialPort;
function serialModule() {
  if (SerialPort === undefined) {
    try { ({ SerialPort } = require('serialport')); } catch { SerialPort = null; }
  }
  return SerialPort;
}

class SerialConnection extends EventEmitter {
  constructor(session) { super(); this.session = session; this.closed = false; }

  static async list() {
    const SP = serialModule();
    if (!SP) return [];
    return SP.list();
  }

  connect() {
    const SP = serialModule();
    if (!SP) throw new Error('Serial support is unavailable (serialport module failed to load).');
    const c = this.session.serial || {};
    if (!c.path) throw new Error('No serial port selected');
    return new Promise((resolve, reject) => {
      this.port = new SP({
        path: c.path,
        baudRate: Number(c.baudRate) || 9600,
        dataBits: Number(c.dataBits) || 8,
        stopBits: Number(c.stopBits) || 1,
        parity: c.parity || 'none',
        rtscts: c.flowControl === 'rtscts',
        xon: c.flowControl === 'xonxoff',
        xoff: c.flowControl === 'xonxoff',
        autoOpen: false,
      });
      this.port.open((err) => {
        if (err) return reject(err);
        this.port.on('data', (d) => this.emit('data', d));
        this.port.on('error', (e) => this.emit('error', e));
        this.port.on('close', () => this._closed());
        resolve();
      });
    });
  }

  write(data) { this.port?.write(data); }
  resize() {}

  sendBreak() {
    this.port?.set({ brk: true }, () => setTimeout(() => this.port?.set({ brk: false }), 250));
  }

  _closed() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  close() { if (this.port?.isOpen) this.port.close(); this._closed(); }
}

let pty;
function ptyModule() {
  if (pty === undefined) {
    try { pty = require('node-pty'); } catch { pty = null; }
  }
  return pty;
}

function defaultShell() {
  if (process.platform === 'win32') {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    return fs.existsSync(pwsh) ? pwsh : 'powershell.exe';
  }
  return process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
}

class LocalShellConnection extends EventEmitter {
  constructor(session) { super(); this.session = session; this.closed = false; }

  connect(cols, rows) {
    const P = ptyModule();
    if (!P) throw new Error('Local shell support is unavailable (node-pty failed to load). Run "npm run rebuild".');
    const c = this.session.local || {};
    const shell = c.shell || defaultShell();
    const args = c.args ? c.args.match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, '')) : (process.platform === 'win32' ? [] : ['-l']);
    const cwd = (c.cwd || os.homedir()).replace(/^~/, os.homedir());
    this.proc = P.spawn(shell, args, {
      name: this.session.terminal?.termType || 'xterm-256color',
      cols, rows, cwd,
      env: { ...process.env, TERM: this.session.terminal?.termType || 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TermCraft' },
    });
    this.proc.onData((d) => this.emit('data', Buffer.from(d, 'utf8')));
    this.proc.onExit(() => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    this.emit('status', { shell });
  }

  write(data) { this.proc?.write(typeof data === 'string' ? data : data.toString('utf8')); }
  resize(cols, rows) { try { this.proc?.resize(cols, rows); } catch { /* process exited */ } }

  close() {
    try { this.proc?.kill(); } catch { /* already gone */ }
    if (!this.closed) { this.closed = true; this.emit('close'); }
  }
}

module.exports = { TelnetConnection, RawConnection, RloginConnection, SerialConnection, LocalShellConnection, defaultShell };
