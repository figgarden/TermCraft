// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const fs = require('fs');
const path = require('path');
const { SshConnection } = require('./protocols/ssh');
const { TelnetConnection, RawConnection, RloginConnection, SerialConnection, LocalShellConnection } = require('./protocols/simple');
const { expandEscapes, stripAnsi, expandLogPath, timestamp } = require('./util');
const { createAutoLogin } = require('./auto-login');
const zmodem = require('./zmodem');

const PROTOCOLS = {
  ssh2: SshConnection,
  telnet: TelnetConnection,
  raw: RawConnection,
  rlogin: RloginConnection,
  serial: SerialConnection,
  local: LocalShellConnection,
};

const MATCH_WINDOW = 8192; // chars of recent output kept for expect/WaitForString matching

class TabConnection {
  constructor(tabId, session) {
    this.tabId = tabId;
    this.session = session;
    this.conn = null;
    this.state = 'idle';
    this.decoder = null;
    this.log = null;
    this.logLineStart = true;
    this.recent = '';          // ANSI-stripped recent output for matching
    this.waiters = new Set();  // script WaitForString waiters
    this.logon = null;         // { index } progress through logon actions
    this.antiIdleTimer = null;
    this.lastInput = Date.now();
    this.pending = '';
    this.flushScheduled = false;
    this.connectedAt = null;
  }
}

class ConnectionManager {
  /**
   * @param {object} deps { store, send(channel, ...args), request(type, payload) => Promise, runScript(file, tabId) }
   */
  constructor(deps) {
    this.deps = deps;
    this.tabs = new Map();
  }

  get(tabId) { return this.tabs.get(tabId); }

  _send(...args) { this.deps.send(...args); }

  info(tabId, msg, color = 90) {
    this._send('conn:data', tabId, `\r\n\x1b[${color}m[TermCraft] ${msg}\x1b[0m\r\n`);
  }

  _setState(t, state, extra = {}) {
    t.state = state;
    this._send('conn:state', t.tabId, { state, ...extra });
  }

  async open(tabId, sessionRef, cols, rows) {
    this.close(tabId, true);
    const session = this.deps.store.resolveSession(sessionRef);
    const Proto = PROTOCOLS[session.protocol];
    if (!Proto) throw new Error(`Unknown protocol ${session.protocol}`);
    const t = new TabConnection(tabId, session);
    this.tabs.set(tabId, t);
    t.decoder = this._decoder(session.terminal?.encoding);

    const conn = new Proto(session, {
      store: this.deps.store,
      prompt: (req) => this.deps.request('prompt', { ...req, tabId }),
    });
    t.conn = conn;
    conn.on('data', (buf) => this._onData(t, buf));
    conn.on('info', (msg) => this.info(tabId, msg));
    conn.on('status', (st) => this._send('conn:status', tabId, st));
    conn.on('credentials', (creds) => this._saveCredentials(tabId, creds.target || sessionRef, creds));
    conn.on('error', (err) => this.info(tabId, `Error: ${err.message}`, 31));
    conn.on('close', () => this._onClose(t));

    const target = session.protocol === 'serial' ? session.serial?.path
      : session.protocol === 'local' ? 'local shell' : `${session.host}:${session.port}`;
    this._setState(t, 'connecting', { target });
    // Open the log before connecting so banners and MOTD are captured.
    if (session.logging?.enabled) this.startLog(tabId);
    try {
      await conn.connect(cols, rows);
    } catch (err) {
      if (this.tabs.get(tabId) !== t) return; // replaced or closed while connecting
      this.info(tabId, `Connection to ${target} failed: ${err.message}`, 31);
      this._setState(t, 'failed', { error: err.message });
      this.stopLog(tabId);
      conn.close?.();
      return;
    }
    if (this.tabs.get(tabId) !== t) { conn.close(); return; }
    t.connectedAt = Date.now();
    this._setState(t, 'connected', { connectedAt: t.connectedAt, username: conn.username || session.username });

    t.autoLogin = createAutoLogin(session);
    if (session.logonActions?.length) t.logon = { index: 0 };
    this._advanceLogon(t);
    this._startAntiIdle(t);
    if (session.logonScript) this.deps.runScript(session.logonScript, tabId).catch((e) => this.info(tabId, `Logon script: ${e.message}`, 31));
  }

  /** Persist a login the user chose to save, then tell the UI which session now holds it. */
  _saveCredentials(tabId, ref, creds) {
    try {
      const saved = this.deps.store.saveCredentials(ref, creds);
      this._send('session:saved', tabId, { session: saved, forTab: !creds.target });
    } catch (e) {
      this.info(tabId, `Could not save login: ${e.message}`, 31);
    }
  }

  _decoder(encoding) {
    try { return new TextDecoder(encoding || 'utf-8', { fatal: false }); } catch { return new TextDecoder('utf-8'); }
  }

  _encode(t, str) {
    const enc = (t.session.terminal?.encoding || 'utf-8').toLowerCase();
    if (['iso-8859-1', 'latin1', 'windows-1252', 'us-ascii'].includes(enc)) return Buffer.from(str, 'latin1');
    return Buffer.from(str, 'utf8');
  }

  _onData(t, buf) {
    // During an XMODEM/YMODEM/ZMODEM transfer the bytes belong to the transfer, not the screen.
    if (t.raw) { t.raw(buf); return; }
    // The device started ZMODEM ("rz" waits for files, "sz" sends): hand the rest to a transfer.
    if (this.deps.onZmodem && this.deps.store.getSettings().zmodemAutoStart !== false) {
      const scan = t.zTail ? Buffer.concat([t.zTail, buf]) : buf;
      const hit = zmodem.detect(scan);
      if (hit) {
        const before = scan.subarray(0, hit.at).subarray(t.zTail?.length || 0);
        const rest = scan.subarray(hit.at);
        t.zTail = null;
        if (before.length) this._onData(t, before);
        this.deps.onZmodem(t.tabId, hit.direction, rest);
        return;
      }
      t.zTail = scan.subarray(-5);
    }
    const text = t.decoder.decode(buf, { stream: true });
    if (!text) return;
    // Coalesce bursts into a single IPC message per tick.
    t.pending += text;
    if (!t.flushScheduled) {
      t.flushScheduled = true;
      setImmediate(() => {
        t.flushScheduled = false;
        const out = t.pending;
        t.pending = '';
        this._send('conn:data', t.tabId, out);
      });
    }
    this._writeLog(t, text);
    const plain = stripAnsi(text);
    t.recent = (t.recent + plain).slice(-MATCH_WINDOW);
    const answer = t.autoLogin?.feed(plain);
    if (answer) this.write(t.tabId, answer, true);
    this._advanceLogon(t);
    for (const w of [...t.waiters]) w.feed(plain);
  }

  _advanceLogon(t) {
    const actions = t.session.logonActions || [];
    while (t.logon && t.logon.index < actions.length) {
      const a = actions[t.logon.index];
      if (a.expect) {
        const at = t.recent.indexOf(a.expect);
        if (at < 0) return;
        t.recent = t.recent.slice(at + a.expect.length);
      }
      t.logon.index++;
      if (a.send != null) this.write(t.tabId, expandEscapes(a.send), true);
    }
    t.logon = null;
  }

  _startAntiIdle(t) {
    const ai = t.session.antiIdle;
    if (!ai?.enabled || !(ai.interval > 0)) return;
    t.antiIdleTimer = setInterval(() => {
      if (Date.now() - t.lastInput >= ai.interval * 1000) this.write(t.tabId, expandEscapes(ai.string || ''), true);
    }, Math.min(ai.interval * 1000, 10000));
  }

  _onClose(t) {
    if (this.tabs.get(t.tabId) !== t) return;
    const tail = t.decoder.decode();
    if (tail) this._send('conn:data', t.tabId, tail);
    clearInterval(t.antiIdleTimer);
    this.stopLog(t.tabId);
    for (const w of [...t.waiters]) w.finish(-1);
    const wasConnected = t.state === 'connected';
    this._setState(t, 'disconnected', { reconnect: wasConnected && t.session.reconnect?.enabled ? t.session.reconnect.delay || 5 : 0 });
    if (wasConnected) this.info(t.tabId, `Disconnected (${new Date().toLocaleTimeString()})`, 33);
  }

  /** @param {boolean} automated true when sent by logon actions / anti-idle / scripts (doesn't reset idle timer) */
  write(tabId, data, automated = false) {
    const t = this.tabs.get(tabId);
    if (!t?.conn || t.state !== 'connected') return false;
    if (!automated) t.lastInput = Date.now();
    t.conn.write(this._encode(t, data));
    return true;
  }

  resize(tabId, cols, rows) {
    const t = this.tabs.get(tabId);
    if (t?.conn && t.state === 'connected') t.conn.resize(cols, rows);
  }

  sendBreak(tabId) {
    const t = this.tabs.get(tabId);
    t?.conn?.sendBreak?.();
  }

  close(tabId, silent = false) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    if (silent) this.tabs.delete(tabId);
    clearInterval(t.antiIdleTimer);
    this.stopLog(tabId);
    for (const w of [...t.waiters]) w.finish(-1);
    t.conn?.close();
    if (silent) return;
    this.tabs.delete(tabId);
  }

  closeAll() { for (const id of [...this.tabs.keys()]) this.close(id, true); }

  /**
   * Hand a connected tab's byte stream to `fn(io)` (file transfer protocols) until it finishes.
   * io = { write(Buffer), onData(cb) -> unsubscribe }.
   */
  async rawTransfer(tabId, fn, initial = null) {
    const t = this.tabs.get(tabId);
    if (!t || t.state !== 'connected') throw new Error('Connect the tab first');
    if (t.raw) throw new Error('A file transfer is already running in this tab');
    const subs = new Set();
    // Bytes that arrive before the protocol starts listening (e.g. while a file dialog is open) are kept.
    const queued = initial?.length ? [initial] : [];
    t.raw = (buf) => { if (subs.size) for (const cb of subs) cb(buf); else queued.push(buf); };
    const io = {
      write: (b) => t.conn.write(b),
      onData: (cb) => { subs.add(cb); while (queued.length) cb(queued.shift()); return () => subs.delete(cb); },
    };
    try { return await fn(io); } finally { t.raw = null; t.zTail = null; }
  }

  // ---- logging -------------------------------------------------------
  startLog(tabId, file) {
    const t = this.tabs.get(tabId);
    if (!t) return null;
    this.stopLog(tabId);
    const cfg = t.session.logging || {};
    const target = file || expandLogPath(cfg.path || '~/TermCraft Logs/%S-%Y%M%D-%h%m%s.log', t.session);
    // Session logs can contain sensitive output: private directory and file.
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    t.log = { stream: fs.createWriteStream(target, { flags: cfg.append === false ? 'w' : 'a', mode: 0o600 }), path: target, cfg };
    t.logLineStart = true;
    t.log.stream.write(`\n===== Session log started ${timestamp()} (${t.session.name || t.session.host}) =====\n`);
    t.log.stream.on('error', (e) => { this.info(tabId, `Log error: ${e.message}`, 31); this.stopLog(tabId); });
    this._send('conn:log', tabId, { logging: true, path: target });
    return target;
  }

  stopLog(tabId) {
    const t = this.tabs.get(tabId);
    if (!t?.log) return;
    t.log.stream.end(`\n===== Session log stopped ${timestamp()} =====\n`);
    t.log = null;
    this._send('conn:log', tabId, { logging: false });
  }

  _writeLog(t, text) {
    if (!t.log) return;
    let out = t.log.cfg.stripAnsi === false ? text : stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '');
    if (t.log.cfg.timestamps) {
      let res = '';
      for (const ch of out) {
        if (t.logLineStart) { res += `[${timestamp()}] `; t.logLineStart = false; }
        res += ch;
        if (ch === '\n') t.logLineStart = true;
      }
      out = res;
    }
    t.log.stream.write(out);
  }

  // ---- scripting support ----------------------------------------------
  /**
   * Wait until one of `patterns` appears in output received after this call.
   * Resolves { index (0-based, -1 on timeout/disconnect), before }.
   */
  waitFor(tabId, patterns, timeoutMs) {
    const t = this.tabs.get(tabId);
    if (!t || t.state !== 'connected') return Promise.resolve({ index: -1, before: '' });
    return new Promise((resolve) => {
      let buf = '';
      let timer = null;
      const w = {
        feed(text) {
          buf = (buf + text).slice(-MATCH_WINDOW * 4);
          let best = null;
          patterns.forEach((p, i) => {
            const at = buf.indexOf(p);
            if (at >= 0 && (!best || at < best.at)) best = { i, at };
          });
          if (best) w.finish(best.i, buf.slice(0, best.at));
        },
        finish(index, before = buf) {
          clearTimeout(timer);
          t.waiters.delete(w);
          resolve({ index, before });
        },
      };
      t.waiters.add(w);
      if (timeoutMs > 0) timer = setTimeout(() => w.finish(-1), timeoutMs);
    });
  }
}

module.exports = { ConnectionManager, PROTOCOLS };
