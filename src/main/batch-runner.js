// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Run a list of commands on many saved sessions (routers, switches, servers) without opening
 * tabs, and save each device's output to its own file: audits, config backups, "show version"
 * across a site. Works over SSH2, Telnet, Rlogin and Serial; pagers (--More--) are answered
 * automatically, so it works without vendor-specific "terminal length 0" commands.
 */
const fs = require('fs');
const path = require('path');
const { stripAnsi, timestamp } = require('./util');
const { createAutoLogin } = require('./auto-login');

const SUPPORTED = new Set(['ssh2', 'telnet', 'rlogin', 'serial']);
// Shell and CLI prompts: "user@host:~$", "root@h:/#", "switch#", "router>", "[admin@fw] >", "PS C:\>".
const PROMPT_RE = /[#>$%\]]\s?$/;
// Pagers from IOS/NX-OS/EOS/JunOS/ProCurve/Huawei/FortiOS/less/more.
// A login prompt that is still showing after auto-login answered (or with nothing to answer it).
const LOGIN_RE = /(?:user ?name|login|password)\s*:\s*$/i;
const PAGER_RE = /(?:-+\s*\(?more\b[^\n]*?\)?\s*-*|<---\s*more\s*--->|press any key to continue[^\n]*|\(END\)|---- more ----|--more--)\s*$/i;

const safeName = (s) => String(s || 'session').replace(/[^\w.@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';

/**
 * Line-oriented expect over a terminal connection.
 * @param {EventEmitter & { write(buf), close() }} conn  emits 'data' (Buffer) and 'close'
 */
class PromptSession {
  constructor(conn, { quietMs = 600, strangerMs = 5000, autoLogin = null, encoding = 'utf-8' } = {}) {
    this.conn = conn;
    this.quietMs = quietMs;
    this.strangerMs = strangerMs;
    this.autoLogin = autoLogin;
    this.decoder = new TextDecoder(encoding, { fatal: false });
    this.buf = '';
    this.lastData = Date.now();
    this.closed = false;
    conn.on('data', (b) => this._onData(b));
    conn.on('close', () => { this.closed = true; });
  }

  _onData(b) {
    const plain = stripAnsi(this.decoder.decode(b, { stream: true })).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    this.buf += plain;
    this.lastData = Date.now();
    const answer = this.autoLogin?.feed(plain);
    if (answer) { this.conn.write(Buffer.from(answer)); return; }
    const tail = this.buf.slice(-120);
    const pager = PAGER_RE.exec(tail);
    if (pager) {
      this.buf = this.buf.slice(0, this.buf.length - tail.length + pager.index).replace(/[ \t]+$/, '');
      this.conn.write(Buffer.from(' '));
    }
  }

  lastLine() { return this.buf.split('\n').pop().trimEnd(); }

  /**
   * Wait until output is quiet and the last line looks like a prompt. Once the device's prompt is
   * known (`expect`), a line starting with the same hostname ("sw1#", "sw1(config)#") counts after
   * quietMs; any other prompt-like line needs a longer pause, so slow output isn't cut short.
   */
  waitPrompt(timeoutMs, { nudgeAfterMs = 0, signal, expect = '' } = {}) {
    const stem = expect.replace(/[#>$%\]]\s?$/, '').split(/[(:\s]/)[0];
    const start = Date.now();
    let nudged = false;
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        if (signal?.cancelled) { clearInterval(tick); return reject(new Error('Cancelled')); }
        if (this.closed) { clearInterval(tick); return reject(new Error('Connection closed')); }
        const idle = Date.now() - this.lastData;
        const quiet = idle >= this.quietMs;
        const line = this.lastLine();
        const known = stem && line.startsWith(stem);
        if (PROMPT_RE.test(line) && (this.autoLogin?.done ?? true) && (known ? quiet : idle >= (stem ? this.strangerMs : this.quietMs))) {
          clearInterval(tick);
          return resolve(line);
        }
        if (quiet && LOGIN_RE.test(line) && (this.autoLogin?.done ?? true)) {
          clearInterval(tick);
          return reject(new Error(this.autoLogin ? 'Login failed (the device asked for the login again)' : 'The device asks for a login: add a username and password, or a credential, to the session'));
        }
        // Consoles often print nothing until Enter is pressed.
        if (nudgeAfterMs && !nudged && Date.now() - start > nudgeAfterMs && quiet && !this.buf.trim()) { nudged = true; this.conn.write(Buffer.from('\r')); }
        if (Date.now() - start > timeoutMs) {
          clearInterval(tick);
          reject(new Error(`Timed out waiting for a prompt (last output: "${this.lastLine().slice(-60)}")`));
        }
      }, 100);
    });
  }

  /** Send one command and return its output (without the echoed command and the final prompt). */
  async run(command, timeoutMs, signal, expect = '') {
    this.buf = '';
    this.conn.write(Buffer.from(command + '\r'));
    // Make sure the device has started answering before treating quiet as "done".
    this.lastData = Date.now();
    const prompt = await this.waitPrompt(timeoutMs, { signal, expect });
    const lines = this.buf.split('\n');
    lines.pop(); // the prompt
    if (lines.length && lines[0].trim().endsWith(command.trim())) lines.shift(); // echo
    return { output: lines.join('\n').replace(/\s+$/, ''), prompt };
  }
}

class BatchRunner {
  /** @param {{ store, request, send, protocols: object }} deps */
  constructor(deps) {
    this.deps = deps;
    this.runs = new Map(); // runId -> { cancelled, conns:Set }
  }

  /**
   * @param {string} runId
   * @param {{ sessionIds: string[], commands: string[], concurrency?: number, timeoutSec?: number, outputDir: string }} opts
   */
  async start(runId, opts) {
    const commands = (opts.commands || []).map((c) => String(c)).filter((c) => c.trim());
    if (!commands.length) throw new Error('Enter at least one command');
    const ids = [...new Set(opts.sessionIds || [])];
    if (!ids.length) throw new Error('Choose at least one session');
    const run = { cancelled: false, conns: new Set(), names: new Set() };
    this.runs.set(runId, run);
    fs.mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
    const timeoutMs = Math.max(5, Number(opts.timeoutSec) || 60) * 1000;
    const queue = [...ids];
    const results = [];
    const worker = async () => {
      while (queue.length && !run.cancelled) {
        const id = queue.shift();
        results.push(await this._runOne(runId, run, id, commands, timeoutMs, opts.outputDir));
      }
    };
    const n = Math.min(Math.max(1, Number(opts.concurrency) || 5), 20, ids.length);
    await Promise.all(Array.from({ length: n }, worker));
    for (const id of queue) this.deps.send('batch:update', runId, { sessionId: id, state: 'cancelled' });
    this.runs.delete(runId);
    const summary = { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, cancelled: run.cancelled, outputDir: opts.outputDir };
    this.deps.send('batch:done', runId, summary);
    return summary;
  }

  async _runOne(runId, run, id, commands, timeoutMs, outputDir) {
    const update = (st) => this.deps.send('batch:update', runId, { sessionId: id, ...st });
    const started = Date.now();
    let conn;
    let transcript = '';
    let session;
    try {
      session = this.deps.store.resolveSession(id);
      if (!SUPPORTED.has(session.protocol)) throw new Error(`${session.protocol} sessions can't run commands`);
      update({ state: 'connecting' });
      // A quiet, tab-less connection: no forwards, X11, agent forwarding or logging.
      session.forwards = [];
      session.ssh = { ...(session.ssh || {}), x11: false, agentForward: false };
      const Proto = this.deps.protocols[session.protocol];
      conn = new Proto(session, {
        store: this.deps.store,
        prompt: (req) => this.deps.request('prompt', { ...req, title: `${req.title || 'Login'} — ${session.name}` }),
      });
      conn.on('error', () => {});
      conn.on('info', () => {});
      run.conns.add(conn);
      const io = new PromptSession(conn, { autoLogin: createAutoLogin(session), encoding: session.terminal?.encoding });
      await conn.connect(250, 50);
      if (run.cancelled) throw new Error('Cancelled');
      update({ state: 'running', step: 'waiting for prompt' });
      await io.waitPrompt(Math.max(timeoutMs, 30000), { nudgeAfterMs: 3000, signal: run });
      let prompt = io.lastLine();
      const banner = io.buf.split('\n').slice(0, -1).join('\n').trim();
      transcript = banner ? `${banner}\n` : '';
      for (let i = 0; i < commands.length; i++) {
        update({ state: 'running', step: `${i + 1}/${commands.length}: ${commands[i]}` });
        const res = await io.run(commands[i], timeoutMs, run, prompt);
        transcript += `${prompt} ${commands[i]}\n${res.output}\n`;
        prompt = res.prompt;
      }
      const file = this._save(run, outputDir, session, transcript, null);
      update({ state: 'done', ms: Date.now() - started, file, preview: transcript.slice(-4000) });
      return { ok: true };
    } catch (e) {
      const msg = run.cancelled ? 'Cancelled' : e.message;
      const file = transcript && session ? this._save(run, outputDir, session, transcript, msg) : '';
      update({ state: run.cancelled ? 'cancelled' : 'failed', error: msg, ms: Date.now() - started, file, preview: transcript.slice(-4000) });
      return { ok: false };
    } finally {
      if (conn) { run.conns.delete(conn); try { conn.close(); } catch { /* closed */ } }
    }
  }

  _save(run, dir, session, transcript, error) {
    let base = safeName(session.name);
    if (run.names.has(base)) base += `_${safeName(session.id)}`;
    run.names.add(base);
    const file = path.join(dir, `${base}.txt`);
    const head = `# ${session.name} (${session.protocol === 'serial' ? session.serial?.path : `${session.host}:${session.port}`}) — ${timestamp()}${error ? `\n# FAILED: ${error}` : ''}\n\n`;
    fs.writeFileSync(file, head + transcript.replace(/\n/g, process.platform === 'win32' ? '\r\n' : '\n'), { mode: 0o600 });
    return file;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.cancelled = true;
    for (const c of run.conns) { try { c.close(); } catch { /* closed */ } }
  }

  cancelAll() { for (const id of this.runs.keys()) this.cancel(id); }
}

module.exports = { BatchRunner, PromptSession, PAGER_RE, PROMPT_RE, safeName };
