// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PromptSession, BatchRunner, PAGER_RE } = require('../src/main/batch-runner');
const { createAutoLogin } = require('../src/main/auto-login');

/** A fake Cisco-like CLI over a telnet-ish stream: login, pager, config mode, slow commands. */
class FakeDevice extends EventEmitter {
  constructor({ login = true, hostname = 'core-sw-01' } = {}) {
    super();
    this.hostname = hostname;
    this.mode = '#';
    this.stage = login ? 'user' : 'cli';
    this.line = '';
    this.pages = null;
    this.got = [];
  }
  out(s, delay = 5) { setTimeout(() => this.emit('data', Buffer.from(s)), delay); }
  prompt() { return `${this.hostname}${this.mode === 'config' ? '(config)#' : '#'}`; }
  async connect() { this.out(this.stage === 'user' ? '\r\nUser Access Verification\r\n\r\nUsername: ' : `\r\n${this.prompt()}`); }
  write(buf) {
    for (const ch of buf.toString()) {
      if (this.pages) { if (ch === ' ') this._page(); continue; }
      if (ch !== '\r') { this.line += ch; if (this.stage !== 'pass') this.out(ch, 0); continue; }
      const cmd = this.line; this.line = ''; this.got.push(cmd);
      if (this.stage === 'user') { this.user = cmd; this.stage = 'pass'; this.out('\r\nPassword: '); continue; }
      if (this.stage === 'pass') { this.stage = cmd === 'secret' && this.user === 'netops' ? 'cli' : 'user'; this.out(this.stage === 'cli' ? `\r\n${this.prompt()}` : '\r\n% Login invalid\r\nUsername: '); continue; }
      if (cmd === 'show run') { this.pages = ['line 1\r\nline 2\r\n', 'line 3\r\nline 4\r\n', 'end\r\n']; this.out('\r\n'); this._page(); continue; }
      if (cmd === 'conf t') { this.mode = 'config'; this.out(`\r\nEnter configuration commands, one per line.\r\n${this.prompt()}`); continue; }
      if (cmd === 'end') { this.mode = '#'; this.out(`\r\n${this.prompt()}`); continue; }
      if (cmd === 'ping 10.0.0.9') { this.out('\r\nType escape sequence to abort.\r\nSending 5, 100-byte ICMP Echos, timeout is 2 seconds: >'); this.out(`\r\n!!!!!\r\nSuccess rate is 100 percent (5/5)\r\n${this.prompt()}`, 1500); continue; }
      this.out(`\r\n% output of ${cmd}\r\n${this.prompt()}`);
    }
  }
  _page() {
    const p = this.pages.shift();
    if (this.pages.length) this.out(`${p} --More-- `); else { this.pages = null; this.out(`${p}${this.prompt()}`); }
  }
  close() { this.emit('close'); }
}

test('batch: logs in, answers --More--, follows config-mode prompts and waits for slow output', { timeout: 20000 }, async () => {
  const dev = new FakeDevice();
  const session = { protocol: 'telnet', username: 'netops', auth: { password: 'secret' } };
  const io = new PromptSession(dev, { autoLogin: createAutoLogin(session), quietMs: 200 });
  await dev.connect();
  const prompt = await io.waitPrompt(5000);
  assert.strictEqual(prompt, 'core-sw-01#');
  assert.deepStrictEqual(dev.got.slice(0, 2), ['netops', 'secret']);
  const run = await io.run('show run', 5000, null, prompt);
  assert.strictEqual(run.output, 'line 1\nline 2\nline 3\nline 4\nend');
  const conf = await io.run('conf t', 5000, null, prompt);
  assert.strictEqual(conf.prompt, 'core-sw-01(config)#');
  await io.run('end', 5000, null, conf.prompt);
  const ping = await io.run('ping 10.0.0.9', 8000, null, prompt);
  assert.match(ping.output, /Success rate is 100 percent/, 'did not stop at the ">" in the middle of ping output');
});

test('batch: pager patterns from common vendors', () => {
  for (const p of [' --More-- ', '-- More --', '<--- More --->', '--More--(42%)', '---- More ----', 'Press any key to continue (Q to quit)', '(END)']) {
    assert.ok(PAGER_RE.test(`some output\n${p}`), p);
  }
  assert.ok(!PAGER_RE.test('show more details\nrouter#'));
});

test('batch: runner saves one file per device and reports failures', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-batch-'));
  const sessions = {
    a: { id: 'a', name: 'core-sw-01', protocol: 'telnet', host: '10.0.0.1', port: 23, username: 'netops', auth: { password: 'secret' } },
    b: { id: 'b', name: 'edge/rtr', protocol: 'telnet', host: '10.0.0.2', port: 23, username: 'netops', auth: { password: 'wrong' } },
    c: { id: 'c', name: 'desk-mac', protocol: 'vnc', host: '10.0.0.3', port: 5900, auth: {} },
  };
  class Proto extends FakeDevice { constructor(s) { super({ hostname: s.name.replace(/\W/g, '') }); } }
  const events = [];
  const runner = new BatchRunner({
    store: { resolveSession: (id) => JSON.parse(JSON.stringify(sessions[id])) },
    request: async () => null,
    send: (ch, runId, st) => events.push([ch, st]),
    protocols: { telnet: Proto },
  });
  const summary = await runner.start('r1', { sessionIds: ['a', 'b', 'c'], commands: ['show ver'], timeoutSec: 5, outputDir: dir });
  assert.strictEqual(summary.ok, 1);
  assert.strictEqual(summary.failed, 2);
  const text = fs.readFileSync(path.join(dir, 'core-sw-01.txt'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on Windows
  assert.match(text, /# core-sw-01 \(10\.0\.0\.1:23\)/);
  assert.match(text, /coresw01# show ver\n% output of show ver/);
  assert.ok(!/secret/.test(text), 'password never appears in the transcript');
  const failed = events.filter(([ch, st]) => ch === 'batch:update' && st.state === 'failed').map(([, st]) => st.sessionId).sort();
  assert.deepStrictEqual(failed, ['b', 'c']);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'core-sw-01.txt')).mode & 0o777, 0o600);
});
