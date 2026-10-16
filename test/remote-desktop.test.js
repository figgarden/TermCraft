// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const { Server, utils } = require('ssh2');
const { Store } = require('../src/main/store');
const { VncBridge, RdpService, rdpFile, freerdpArgs } = require('../src/main/remote-desktop');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `termcraft-${p}-`));

/** A TCP server that greets like an RFB server and echoes whatever it receives. */
function fakeVnc() {
  const s = net.createServer((c) => { c.write('RFB 003.008\n'); c.on('data', (d) => c.write(d)); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

/** SSH server that only allows direct-tcpip forwarding (an SSH tunnel endpoint). */
function sshTunnelServer() {
  const stats = { tunnels: 0 };
  const clients = new Set();
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    clients.add(client);
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      stats.tunnels++;
      const sock = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(sock).pipe(ch); });
      sock.on('error', () => reject());
    }));
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
  });
  const close = server.close.bind(server);
  server.close = () => { for (const c of clients) c.end(); close(); };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, stats })));
}

function wsRoundTrip(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['binary']);
    const got = [];
    ws.on('message', (d) => {
      got.push(Buffer.from(d).toString());
      if (got.length === 1) ws.send(Buffer.from('ping'));
      else { ws.close(); resolve(got); }
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('close', (code) => { if (got.length < 2) reject(new Error(`closed ${code}`)); });
  });
}

const deps = (store) => ({ store, request: async (type, req) => (req.kind === 'hostkey' ? 'once' : null), send: () => {} });

test('vnc bridge: WebSocket ⇄ TCP, direct and through an SSH tunnel; rejects unknown tokens', async (t) => {
  const vnc = await fakeVnc();
  const tunnel = await sshTunnelServer();
  t.after(() => { vnc.close(); tunnel.server.close(); });
  const store = new Store(tmp('vnc'), null);
  const bridge = new VncBridge(deps(store));
  t.after(() => bridge.closeAll());
  const vncPort = vnc.address().port;

  // Direct.
  const direct = store.saveSession({ name: 'mac', protocol: 'vnc', host: '127.0.0.1', port: vncPort, auth: { password: 'vncpw' } });
  const info = await bridge.open('tab1', direct.id);
  assert.match(info.url, /^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[0-9a-f]{48}$/);
  assert.strictEqual(info.password, 'vncpw');
  assert.deepStrictEqual(await wsRoundTrip(info.url), ['RFB 003.008\n', 'ping']);

  // Unknown token is refused.
  await assert.rejects(wsRoundTrip(info.url.replace(/[0-9a-f]{48}$/, 'f'.repeat(48))), /closed 1008/);

  // Through an SSH tunnel.
  const ssh = store.saveSession({ name: 'bastion', protocol: 'ssh2', host: '127.0.0.1', port: tunnel.server.address().port, username: 'u', auth: { password: 'secret', methods: ['password'], useAgent: false } });
  const viaSsh = store.saveSession({ name: 'mac via bastion', protocol: 'vnc', host: '127.0.0.1', port: vncPort, tunnel: { sshSessionId: ssh.id } });
  const info2 = await bridge.open('tab2', viaSsh.id);
  assert.strictEqual(info2.via, 'bastion');
  assert.deepStrictEqual(await wsRoundTrip(info2.url), ['RFB 003.008\n', 'ping']);
  assert.strictEqual(tunnel.stats.tunnels, 1);

  // Closing a tab revokes its URL.
  bridge.close('tab1');
  await assert.rejects(wsRoundTrip(info.url), /closed 1008/);
});

test('rdp: .rdp file and FreeRDP arguments', () => {
  const target = { host: 'win.example', port: 3389, username: 'alice', domain: 'CORP', rdp: { width: 1920, height: 1080, multimon: true } };
  const file = rdpFile(target);
  assert.match(file, /full address:s:win\.example:3389\r\n/);
  assert.match(file, /username:s:CORP\\alice\r\n/);
  assert.match(file, /desktopwidth:i:1920/);
  assert.match(file, /use multimon:i:1/);
  assert.ok(!/password/i.test(file), 'no password in the .rdp file');
  const args = freerdpArgs(target, true);
  assert.ok(args.includes('/v:win.example:3389') && args.includes('/u:alice') && args.includes('/d:CORP') && args.includes('/size:1920x1080') && args.includes('/multimon'));
  assert.ok(args.includes('/from-stdin'), 'password is sent on stdin');
  assert.ok(!args.some((a) => a.startsWith('/p:')), 'never puts the password on the command line');
  assert.ok(freerdpArgs({ ...target, rdp: { fullscreen: true } }, false).includes('/f'));
});

test('rdp: SSH tunnel carries the client connection (custom client command)', async (t) => {
  const target = net.createServer((c) => c.on('data', (d) => c.end(`rdp:${d}`)));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tunnel = await sshTunnelServer();
  t.after(() => { target.close(); tunnel.server.close(); });
  const dir = tmp('rdp');
  const store = new Store(dir, null);
  const marker = path.join(dir, 'launched.txt');
  // Custom clients run without a shell, so record the arguments with a tiny script.
  const recorder = path.join(dir, 'record.js');
  fs.writeFileSync(recorder, "require('fs').writeFileSync(process.argv[2], process.argv.slice(3).join(' '))");
  store.saveSettings({ rdpClient: `"${process.execPath}" "${recorder}" "${marker}" {host} {port} {user}` });
  const ssh = store.saveSession({ name: 'bastion', protocol: 'ssh2', host: '127.0.0.1', port: tunnel.server.address().port, username: 'u', auth: { password: 'secret', methods: ['password'], useAgent: false } });
  const sess = store.saveSession({ name: 'win', protocol: 'rdp', host: '127.0.0.1', port: target.address().port, username: 'alice', tunnel: { sshSessionId: ssh.id } });
  const rdp = new RdpService(deps(store));
  t.after(() => rdp.closeAll());
  const info = await rdp.launch('tab1', sess.id);
  assert.strictEqual(info.via, 'bastion');
  assert.ok(info.localPort > 0);
  // The launched client was pointed at the local end of the tunnel.
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), `127.0.0.1 ${info.localPort} alice`);
  // Traffic to the local port reaches the RDP host through SSH.
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(info.localPort, '127.0.0.1', () => c.write('hello'));
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(buf));
    c.on('error', reject);
  });
  assert.strictEqual(reply, 'rdp:hello');
  assert.strictEqual(tunnel.stats.tunnels, 1);
});
