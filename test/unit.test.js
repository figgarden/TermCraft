// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { expandEscapes, stripAnsi, expandLogPath, parseConnectString, hostKeyInfo } = require('../src/main/util');
const { TelnetParser, IAC, DO, WILL, SB, SE, OPT } = require('../src/main/protocols/telnet-parser');
const { parseSocks5Greeting, parseSocks5Request, parseSocks4Request } = require('../src/main/protocols/socks');
const { Store } = require('../src/main/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('expandEscapes', () => {
  assert.strictEqual(expandEscapes('ls\\r\\n\\t\\x41\\e\\\\'), 'ls\r\n\tA\x1b\\');
});

test('stripAnsi removes CSI/OSC sequences', () => {
  assert.strictEqual(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok'), 'red ok');
});

test('expandLogPath tokens', () => {
  const p = expandLogPath('/logs/%S-%H-%Y%M%D-%h%m%s.log', { name: 'r1', host: '10.0.0.1' }, new Date(2026, 0, 2, 3, 4, 5));
  assert.strictEqual(p, '/logs/r1-10.0.0.1-20260102-030405.log');
});

test('parseConnectString', () => {
  assert.deepStrictEqual(parseConnectString('admin@10.0.0.1:2222'), { protocol: 'ssh2', username: 'admin', host: '10.0.0.1', port: 2222 });
  assert.deepStrictEqual(parseConnectString('telnet://router'), { protocol: 'telnet', username: '', host: 'router', port: 23 });
  assert.deepStrictEqual(parseConnectString('ssh://me@[::1]:22'), { protocol: 'ssh2', username: 'me', host: '::1', port: 22 });
});

test('hostKeyInfo parses type and fingerprint', () => {
  const name = Buffer.from('ssh-ed25519');
  const len = Buffer.alloc(4); len.writeUInt32BE(name.length);
  const info = hostKeyInfo(Buffer.concat([len, name, Buffer.alloc(36, 1)]));
  assert.strictEqual(info.type, 'ssh-ed25519');
  assert.match(info.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
});

test('telnet: negotiation, TTYPE, NAWS, IAC escaping', () => {
  const sent = [];
  const data = [];
  const p = new TelnetParser({ send: (b) => sent.push(...b), data: (b) => data.push(b.toString('latin1')), termType: 'xterm', size: () => [100, 30] });
  p.feed(Buffer.from([IAC, DO, OPT.NAWS, 65, 66, IAC, IAC, IAC, SB, OPT.TTYPE, 1, IAC, SE, 67]));
  assert.strictEqual(data.join(''), 'AB\xffC');
  const s = Buffer.from(sent);
  assert.ok(s.includes(Buffer.from([IAC, WILL, OPT.NAWS])));
  assert.ok(s.includes(Buffer.from([IAC, SB, OPT.NAWS, 0, 100, 0, 30, IAC, SE])));
  assert.ok(s.includes(Buffer.from('XTERM')));
  assert.deepStrictEqual([...TelnetParser.escape(Buffer.from([1, 255, 2]))], [1, 255, 255, 2]);
});

test('telnet: sequences split across chunks', () => {
  const data = [];
  const p = new TelnetParser({ send: () => {}, data: (b) => data.push(b.toString()) });
  p.feed(Buffer.from([72, IAC]));
  p.feed(Buffer.from([WILL]));
  p.feed(Buffer.from([OPT.ECHO, 105]));
  assert.strictEqual(data.join(''), 'Hi');
  assert.strictEqual(p.remoteEcho, true);
});

test('socks parsers', () => {
  assert.deepStrictEqual(parseSocks5Greeting(Buffer.from([5, 1, 0])), { consumed: 3, noAuth: true });
  assert.strictEqual(parseSocks5Greeting(Buffer.from([5, 2, 0])), null);
  const dom = Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from('example.com'), Buffer.from([0, 80])]);
  assert.deepStrictEqual(parseSocks5Request(dom), { cmd: 1, host: 'example.com', port: 80, consumed: dom.length });
  assert.deepStrictEqual(parseSocks5Request(Buffer.from([5, 1, 0, 1, 10, 0, 0, 1, 1, 187])), { cmd: 1, host: '10.0.0.1', port: 443, consumed: 10 });
  const s4a = Buffer.concat([Buffer.from([4, 1, 0, 22, 0, 0, 0, 1]), Buffer.from('u\0host\0')]);
  assert.deepStrictEqual(parseSocks4Request(s4a), { cmd: 1, host: 'host', port: 22, consumed: s4a.length });
});

test('store: secrets are hidden from tree and preserved on update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-'));
  const store = new Store(dir, null);
  const saved = store.saveSession({ name: 'a', protocol: 'ssh2', host: 'h', auth: { password: 'pw' } });
  assert.strictEqual(saved.auth.hasPassword, true);
  assert.strictEqual(saved.auth.password, undefined);
  assert.ok(!JSON.stringify(store.getTree()).includes('pw'));
  store.saveSession({ ...saved, name: 'b', auth: { ...saved.auth } }); // password undefined -> kept
  assert.strictEqual(store.resolveSession(saved.id).auth.password, 'pw');
  assert.strictEqual(store.resolveSession(saved.id).terminal.scrollback, 10000); // defaults merged
  store.saveSession({ ...saved, auth: { password: '' } });
  assert.strictEqual(store.resolveSession(saved.id).auth.password, '');
});

test('store: folder delete cascades', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-')), null);
  const f1 = store.saveFolder({ name: 'f1', parent: '' });
  const f2 = store.saveFolder({ name: 'f2', parent: f1.id });
  store.saveSession({ name: 's', host: 'h', parent: f2.id });
  store.saveSession({ name: 'keep', host: 'h', parent: '' });
  store.deleteFolder(f1.id);
  const t = store.getTree();
  assert.strictEqual(t.folders.length, 0);
  assert.deepStrictEqual(t.sessions.map((s) => s.name), ['keep']);
});

test('store: ssh config import with ProxyJump', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-'));
  const cfg = path.join(dir, 'config');
  fs.writeFileSync(cfg, 'Host bastion\n  HostName 1.2.3.4\n  User ops\nHost db\n  HostName 10.0.0.5\n  Port 2222\n  ProxyJump bastion\nHost *\n  ServerAliveInterval 30\n');
  const store = new Store(dir, null);
  assert.strictEqual(store.importSshConfig(cfg), 2);
  const db = store.findSessionByName('db');
  const bastion = store.findSessionByName('bastion');
  assert.strictEqual(db.port, 2222);
  assert.strictEqual(db.ssh.jumpSessionId, bastion.id);
  assert.strictEqual(bastion.username, 'ops');
});

test('highlight: colors text but never inside escape sequences', async () => {
  const { compileHighlights, applyHighlights } = await import('../src/renderer/js/highlight.js');
  const c = compileHighlights([{ pattern: 'error', color: '#ff0000', bold: false }]);
  const out = applyHighlights('\x1b]0;error title\x07an error\x1b[31m', c);
  assert.strictEqual(out, '\x1b]0;error title\x07an \x1b[38;2;255;0;0merror\x1b[39m\x1b[31m');
  assert.strictEqual(compileHighlights([{ pattern: '(', regex: true }]), null); // bad regex skipped
});

test('button bars: send string escapes, \\p pauses and ${prompt:} variables', async () => {
  const { prepareSendString } = await import('../src/renderer/js/button-bars.js');
  assert.deepStrictEqual(await prepareSendString('show ver\\r'), ['show ver\r']);
  assert.deepStrictEqual(await prepareSendString('conf t\\r\\pint ${prompt:Port}\\r\\pdesc ${prompt:Port}\\r', async () => 'Gi0/1'),
    ['conf t\r', 'int Gi0/1\r', 'desc Gi0/1\r']);
  const asked = [];
  await prepareSendString('${prompt:A} ${prompt:B} ${prompt:A}', async (t, label) => { asked.push(label); return 'x'; });
  assert.deepStrictEqual(asked, ['A:', 'B:'], 'each distinct prompt asked once');
  assert.strictEqual(await prepareSendString('x ${prompt:Y}', async () => null), null, 'cancel aborts');
});

test('store: old flat buttons migrate into a "Default" button bar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ buttons: [{ label: 'mine', action: 'send', value: 'x' }] }));
  const s = new Store(dir, null).getSettings();
  assert.strictEqual(s.buttons, undefined);
  assert.deepStrictEqual(s.buttonBars[0], { id: 'default', name: 'Default', buttons: [{ label: 'mine', action: 'send', value: 'x' }] });
  assert.ok(s.buttonBars.length > 1, 'built-in example bars added alongside');
  assert.strictEqual(s.activeButtonBar, 'default');
});
