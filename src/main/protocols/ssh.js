// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { Client, utils } = require('ssh2');
const { hostKeyInfo } = require('../util');
const { handleSocksConnection } = require('./socks');

function defaultAgent() {
  if (process.platform === 'win32') {
    // Prefer the Windows OpenSSH agent pipe, fall back to Pageant.
    return process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK || '';
}

function connectX11() {
  const display = process.env.DISPLAY || ':0';
  if (display.startsWith('/')) return net.connect(display); // XQuartz launchd socket
  const m = /^(.*?):(\d+)(?:\.\d+)?$/.exec(display);
  const host = m ? m[1] : '';
  const n = m ? Number(m[2]) : 0;
  if ((!host || host === 'unix') && process.platform !== 'win32') return net.connect(`/tmp/.X11-unix/X${n}`);
  return net.connect(6000 + n, host || '127.0.0.1');
}

class SshConnection extends EventEmitter {
  /**
   * @param {object} session  resolved session config
   * @param {object} ctx      { prompt(req) => Promise, store, mode: 'shell'|'sftp'|'tunnel' }
   */
  constructor(session, ctx) {
    super();
    this.session = session;
    this.ctx = ctx;
    this.mode = ctx.mode || 'shell';
    this.client = null;
    this.stream = null;
    this.jump = null;
    this.servers = [];
    this.remoteForwards = [];
    this.closed = false;
    this.cols = 80;
    this.rows = 24;
  }

  info(msg) { this.emit('info', msg); }

  /**
   * Prompt. Only password prompts (offerSave) show the "Save login" checkbox; saving
   * stores the username and password together. Resolves { value, save } or null on cancel.
   * Accepts plain-string answers too (scripts, tests).
   */
  async _ask(req, offerSave = false) {
    const r = await this.ctx.prompt(offerSave ? { ...req, offerSave } : req);
    if (r == null) return null;
    if (typeof r === 'object' && !Array.isArray(r)) return { value: r.value, save: !!r.save };
    return { value: r, save: false };
  }

  async connect(cols = 80, rows = 24) {
    this.cols = cols; this.rows = rows;
    this.toSave = {}; // credentials the user asked to remember; saved only after auth succeeds
    await this._connectClient();
    // A login is saved as a unit: the password together with the username it belongs to.
    if (this.toSave.password !== undefined) {
      this.emit('credentials', { username: this.username, password: this.toSave.password });
    }
    if (this.mode === 'shell') await this._openShell();
    if (this.mode !== 'tunnel') this._startForwards();
  }

  async _connectClient() {
    const s = this.session;
    const ssh = s.ssh || {};
    let sock;
    // Jump host: a saved session id, or an ad-hoc session object (e.g. user@host typed in the SCP manager).
    const jumpRef = ssh.jumpSession || ssh.jumpSessionId;
    if (jumpRef) {
      const jumpCfg = this.ctx.store.resolveSession(jumpRef);
      if (jumpCfg.id && jumpCfg.id === s.id) throw new Error('A session cannot use itself as its jump host');
      this.info(`Connecting to jump host ${jumpCfg.host}:${jumpCfg.port || 22}...`);
      this.jump = new SshConnection(jumpCfg, { ...this.ctx, mode: 'tunnel' });
      this.jump.on('info', (m) => this.info('[jump] ' + m));
      // `target` says whose login this is, so it is saved on the jump host, not on this session.
      this.jump.on('credentials', (c) => this.emit('credentials', { ...c, target: c.target || jumpCfg.id || jumpRef }));
      await this.jump.connect();
      sock = await new Promise((resolve, reject) =>
        this.jump.client.forwardOut('127.0.0.1', 0, s.host, Number(s.port) || 22, (err, st) => (err ? reject(err) : resolve(st))));
      this.info(`Tunnel through ${jumpCfg.host} established`);
    }

    let username = s.username;
    if (!username) {
      const r = await this._ask({ kind: 'text', title: 'Username', message: `Username for ${s.host}:` });
      if (!r) throw new Error('Authentication cancelled');
      username = r.value;
    }
    this.username = username;

    const client = new Client();
    this.client = client;
    const hostPort = `${s.host}:${s.port || 22}`;

    const cfg = {
      host: s.host,
      port: Number(s.port) || 22,
      sock,
      username,
      readyTimeout: (ssh.readyTimeout || 20) * 1000,
      keepaliveInterval: (ssh.keepAlive || 0) * 1000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      authHandler: this._authHandler(username),
      hostVerifier: (key, verify) => {
        this._verifyHostKey(hostPort, key).then(verify, () => verify(false));
      },
      debug: ssh.trace ? (m) => this.info(m) : undefined,
    };
    if (ssh.compression) cfg.algorithms = { compress: ['zlib@openssh.com', 'zlib', 'none'] };
    if (ssh.agentForward && this._agentPath()) {
      cfg.agent = this._agentPath();
      cfg.agentForward = true;
    }

    client.on('banner', (msg) => this.emit('data', Buffer.from(msg.replace(/\r?\n/g, '\r\n'))));
    client.on('handshake', (n) => {
      this.negotiated = n;
      this.emit('status', { cipher: n.cs?.cipher, mac: n.cs?.mac, kex: n.kex, hostKey: n.serverHostKey, compress: n.cs?.compress });
    });
    client.on('tcp connection', (info, accept, reject) => this._onRemoteForward(info, accept, reject));
    client.on('x11', (info, accept, reject) => {
      const local = connectX11();
      local.once('connect', () => { const ch = accept(); ch.pipe(local).pipe(ch); });
      local.once('error', () => reject());
    });

    await new Promise((resolve, reject) => {
      let ready = false;
      client.once('ready', () => { ready = true; resolve(); });
      client.on('error', (err) => {
        if (!ready) reject(err);
        else this.emit('error', err);
      });
      client.on('close', () => this._onClose());
      client.connect(cfg);
    });
  }

  _agentPath() {
    return this.session.auth?.useAgent === false ? '' : defaultAgent();
  }

  _authHandler(username) {
    const s = this.session;
    const auth = s.auth || {};
    const order = (auth.methods && auth.methods.length ? auth.methods : ['publickey', 'keyboard-interactive', 'password']).slice();
    const queue = [];
    if (this._agentPath() && order.includes('publickey')) queue.push('agent');
    for (const m of order) queue.push(m);
    let passwordAttempts = 0;
    let kbdAttempts = 0;
    let knownPassword = auth.password || '';

    const next = async (methodsLeft) => {
      while (queue.length) {
        const m = queue.shift();
        const wire = m === 'agent' ? 'publickey' : m;
        if (methodsLeft && !methodsLeft.includes(wire)) continue;

        if (m === 'agent') return { type: 'agent', username, agent: this._agentPath() };

        if (m === 'publickey') {
          if (!auth.keyFile) continue;
          const keyPath = auth.keyFile.replace(/^~/, os.homedir());
          let keyData;
          try { keyData = fs.readFileSync(keyPath); } catch (e) { this.info(`Cannot read key ${keyPath}: ${e.message}`); continue; }
          let passphrase = auth.passphrase || undefined;
          let parsed = utils.parseKey(keyData, passphrase);
          for (let tries = 0; parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message) && tries < 3; tries++) {
            const r = await this._ask({ kind: 'password', title: 'Key Passphrase', message: `Passphrase for ${keyPath}:` });
            if (!r) break;
            passphrase = r.value;
            parsed = utils.parseKey(keyData, passphrase);
          }
          if (parsed instanceof Error) { this.info(`Key ${keyPath}: ${parsed.message}`); continue; }
          return { type: 'publickey', username, key: keyData, passphrase };
        }

        if (m === 'keyboard-interactive') {
          if (kbdAttempts++ >= 3) continue;
          return {
            type: 'keyboard-interactive',
            username,
            prompt: (name, instructions, lang, prompts, finish) => {
              // Auto-answer a lone password prompt with the saved password once.
              if (prompts.length === 1 && !prompts[0].echo && knownPassword && kbdAttempts === 1) {
                return finish([knownPassword]);
              }
              if (!prompts.length) return finish([]);
              // A single hidden prompt is a password (macOS and many Linux servers use
              // keyboard-interactive for passwords) and can be saved; multi-step MFA cannot.
              const isPassword = prompts.length === 1 && !prompts[0].echo;
              this.ctx.prompt({
                kind: 'kbdint', title: name || `Login to ${s.host}`, message: instructions,
                prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo })),
                offerSave: isPassword, retry: isPassword && kbdAttempts > 1,
              }).then((res) => {
                const answers = Array.isArray(res) ? res : res?.answers;
                if (isPassword && answers) this.toSave.password = res?.save ? answers[0] : undefined;
                finish(answers || prompts.map(() => ''));
              });
            },
          };
        }

        if (m === 'password') {
          if (passwordAttempts >= 3) continue;
          let password = passwordAttempts === 0 ? knownPassword : '';
          if (!password) {
            const r = await this._ask({
              kind: 'password', title: 'Password', message: `Password for ${username}@${s.host}:`,
              retry: passwordAttempts > 0,
            }, true);
            if (!r) return false;
            password = r.value;
            // The latest attempt wins, so only a password that actually works gets saved.
            this.toSave.password = r.save ? password : undefined;
          }
          passwordAttempts++;
          knownPassword = password;
          if (passwordAttempts < 3) queue.unshift('password');
          return { type: 'password', username, password };
        }

        if (m === 'none') return { type: 'none', username };
      }
      return false;
    };

    return (methodsLeft, partialSuccess, callback) => {
      next(methodsLeft).then(callback, () => callback(false));
    };
  }

  async _verifyHostKey(hostPort, key) {
    const info = hostKeyInfo(key);
    const known = this.ctx.store.getKnownHost(hostPort);
    if (known && known.fingerprint === info.fingerprint) return true;
    const answer = await this.ctx.prompt({
      kind: 'hostkey',
      changed: !!known,
      host: hostPort,
      keyType: info.type,
      fingerprint: info.fingerprint,
      md5: info.md5,
      oldFingerprint: known?.fingerprint,
    });
    if (answer === 'save') { this.ctx.store.setKnownHost(hostPort, info); return true; }
    return answer === 'once';
  }

  _openShell() {
    const s = this.session;
    const term = s.terminal || {};
    return new Promise((resolve, reject) => {
      const opts = {};
      if (s.ssh?.x11) opts.x11 = true;
      if (s.env) opts.env = s.env;
      this.client.shell(
        { term: term.termType || 'xterm-256color', cols: this.cols, rows: this.rows },
        opts,
        (err, stream) => {
          if (err) return reject(err);
          this.stream = stream;
          stream.on('data', (d) => this.emit('data', d));
          stream.stderr.on('data', (d) => this.emit('data', d));
          stream.on('close', () => this.client.end());
          resolve();
        });
    });
  }

  _startForwards() {
    for (const f of this.session.forwards || []) {
      if (f.enabled === false) continue;
      try {
        if (f.type === 'L' || f.type === 'D') this._listenLocal(f);
        else if (f.type === 'R') this._listenRemote(f);
      } catch (e) {
        this.info(`Forward ${f.type} ${f.bindPort} failed: ${e.message}`);
      }
    }
  }

  _listenLocal(f) {
    const bindHost = f.bindHost || '127.0.0.1';
    const server = net.createServer((sock) => {
      if (f.type === 'D') {
        handleSocksConnection(sock, (host, port, cb) => this.client.forwardOut('127.0.0.1', 0, host, port, cb),
          (err) => this.info(`SOCKS: ${err.message}`));
      } else {
        this.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, f.destHost, Number(f.destPort), (err, stream) => {
          if (err) { this.info(`Forward to ${f.destHost}:${f.destPort} failed: ${err.message}`); return sock.destroy(); }
          sock.pipe(stream).pipe(sock);
          sock.on('error', () => stream.destroy());
          stream.on('error', () => sock.destroy());
        });
      }
    });
    server.on('error', (e) => this.info(`Port forward ${bindHost}:${f.bindPort}: ${e.message}`));
    server.listen(Number(f.bindPort), bindHost, () => {
      this.info(f.type === 'D'
        ? `Dynamic SOCKS forward listening on ${bindHost}:${f.bindPort}`
        : `Local forward ${bindHost}:${f.bindPort} -> ${f.destHost}:${f.destPort}`);
    });
    this.servers.push(server);
  }

  _listenRemote(f) {
    const bindHost = f.bindHost || 'localhost';
    this.client.forwardIn(bindHost, Number(f.bindPort), (err, port) => {
      if (err) return this.info(`Remote forward ${bindHost}:${f.bindPort} failed: ${err.message}`);
      this.remoteForwards.push({ ...f, boundPort: port || Number(f.bindPort), bindHost });
      this.info(`Remote forward ${bindHost}:${port || f.bindPort} -> ${f.destHost}:${f.destPort}`);
    });
  }

  _onRemoteForward(info, accept, reject) {
    const f = this.remoteForwards.find((r) => r.boundPort === info.destPort);
    if (!f) return reject();
    const sock = net.connect(Number(f.destPort), f.destHost || '127.0.0.1', () => {
      const ch = accept();
      ch.pipe(sock).pipe(ch);
      ch.on('error', () => sock.destroy());
    });
    sock.on('error', () => reject());
  }

  /** Run a remote command on a new exec channel (used by SCP). */
  exec(command) {
    return new Promise((resolve, reject) => this.client.exec(command, (err, stream) => (err ? reject(err) : resolve(stream))));
  }

  sftp() {
    return new Promise((resolve, reject) => this.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
  }

  write(data) { this.stream?.write(data); }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  sendBreak() { this.stream?.signal?.('INT'); }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.servers) s.close();
    this.jump?.close();
    this.emit('close');
  }

  close() {
    try { this.stream?.end(); } catch { /* already closed */ }
    try { this.client?.end(); } catch { /* already closed */ }
    this._onClose();
  }
}

module.exports = { SshConnection };
