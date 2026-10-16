// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// Integration test: runs TermCraft's SSH client against an in-process ssh2 server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Server, utils } = require('ssh2');
const { SshConnection } = require('../src/main/protocols/ssh');
const { SftpService } = require('../src/main/sftp-service');
const { ConnectionManager } = require('../src/main/connection-manager');
const { Store } = require('../src/main/store');

const hostKey = utils.generateKeyPairSync('ed25519').private;

function startServer() {
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') return ctx.accept();
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          (ctx.username === 'tester' && answers[0] === 'secret' ? ctx.accept() : ctx.reject(['password', 'keyboard-interactive'])));
      }
      ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a && a());
        session.on('window-change', (a) => a && a());
        session.on('shell', (a) => {
          const stream = a();
          stream.write('Welcome\r\n$ ');
          stream.on('data', (d) => {
            const s = d.toString();
            if (s.includes('exit')) return stream.exit(0) || stream.end();
            stream.write(`echo:${s.trim()}\r\n$ `);
          });
        });
        session.on('sftp', (a) => {
          const sftp = a();
          // Minimal SFTP: REALPATH and an OPENDIR/READDIR listing one file.
          const { STATUS_CODE } = utils.sftp;
          let listed = false;
          sftp.on('REALPATH', (id) => sftp.name(id, [{ filename: '/home/tester', longname: '', attrs: {} }]));
          sftp.on('OPENDIR', (id) => sftp.handle(id, Buffer.from('d')));
          sftp.on('READDIR', (id) => {
            if (listed) return sftp.status(id, STATUS_CODE.EOF);
            listed = true;
            sftp.name(id, [{ filename: 'notes.txt', longname: '', attrs: { mode: 0o100644, size: 12, mtime: 1700000000, atime: 0, uid: 0, gid: 0 } }]);
          });
          sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
        });
      });
      client.on('request', (accept, reject, name, info) => (name === 'tcpip-forward' ? accept() : reject()));
      client.on('tcpip', (accept, reject, info) => {
        // Direct-tcpip: connect to the requested local echo server.
        const sock = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(sock).pipe(ch); });
        sock.on('error', () => reject());
      });
    });
    client.on('error', () => {});
  });
  // Close lingering client connections too, so the test process can exit.
  const close = server.close.bind(server);
  server.close = () => { for (const c of clients) c.end(); close(); };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function echoServer() {
  const s = net.createServer((c) => c.pipe(c));
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('ssh: password auth, host key verify, shell, forwards, sftp', async (t) => {
  const server = await startServer();
  const echo = await echoServer();
  const port = server.address().port;
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-ssh-')), null);
  const lPort = await freePort();
  const dPort = await freePort();
  const prompts = [];
  const session = store.resolveSession({
    name: 'test', protocol: 'ssh2', host: '127.0.0.1', port, username: 'tester',
    auth: { methods: ['password'], useAgent: false },
    forwards: [
      { type: 'L', bindHost: '127.0.0.1', bindPort: lPort, destHost: '127.0.0.1', destPort: echo.address().port },
      { type: 'D', bindHost: '127.0.0.1', bindPort: dPort },
    ],
  });
  const ctx = {
    store,
    prompt: async (req) => {
      prompts.push(req.kind);
      if (req.kind === 'hostkey') return 'save';
      if (req.kind === 'password') return 'secret';
      return null;
    },
  };

  const conn = new SshConnection(session, ctx);
  let out = '';
  conn.on('data', (d) => { out += d.toString(); });
  await conn.connect(80, 24);
  assert.deepStrictEqual(prompts, ['hostkey', 'password']);
  assert.ok(store.getKnownHost(`127.0.0.1:${port}`).fingerprint.startsWith('SHA256:'));

  conn.write('hello\r');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(out, /Welcome/);
  assert.match(out, /echo:hello/);

  // Local forward round-trip.
  await new Promise((r) => setTimeout(r, 100));
  const viaL = await new Promise((resolve, reject) => {
    const c = net.connect(lPort, '127.0.0.1', () => c.write('ping'));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
  });
  assert.strictEqual(viaL, 'ping');

  // Dynamic (SOCKS5) forward round-trip.
  const viaD = await new Promise((resolve, reject) => {
    const c = net.connect(dPort, '127.0.0.1', () => c.write(Buffer.from([5, 1, 0])));
    let stage = 0;
    c.on('data', (d) => {
      if (stage === 0) {
        stage = 1;
        const p = echo.address().port;
        c.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, p >> 8, p & 255]));
      } else if (stage === 1) {
        stage = 2;
        assert.strictEqual(d[1], 0);
        c.write('socks!');
      } else { resolve(d.toString()); c.end(); }
    });
    c.on('error', reject);
  });
  assert.strictEqual(viaD, 'socks!');
  conn.close();

  // Second connect: known host, no host key prompt.
  prompts.length = 0;
  const conn2 = new SshConnection({ ...session, forwards: [] }, ctx);
  await conn2.connect();
  assert.deepStrictEqual(prompts, ['password']);
  conn2.close();

  // SFTP listing through the service.
  const sftp = new SftpService({ store, request: (type, req) => ctx.prompt(req), send: () => {} });
  const info = await sftp.open('x', { ...session, forwards: [] });
  assert.strictEqual(info.home, '/home/tester');
  const list = await sftp.listRemote('x', '/home/tester');
  assert.deepStrictEqual(list.entries.map((e) => [e.name, e.size, e.mode]), [['notes.txt', 12, '-rw-r--r--']]);
  sftp.closeAll();

  server.close();
  echo.close();
});

test('manager: logon actions, waitFor, logging', async () => {
  const server = await startServer();
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-mgr-'));
  const store = new Store(dir, null);
  const logFile = path.join(dir, 'session.log');
  const s = store.saveSession({
    name: 'm', protocol: 'ssh2', host: '127.0.0.1', port, username: 'tester',
    auth: { methods: ['password'], useAgent: false, password: 'secret' },
    logonActions: [{ expect: 'Welcome', send: 'auto\\r' }],
    logging: { enabled: true, path: logFile, timestamps: true },
  });
  const events = [];
  const mgr = new ConnectionManager({
    store,
    send: (ch, id, payload) => events.push([ch, payload]),
    request: async (type, req) => (req.kind === 'hostkey' ? 'once' : null),
    runScript: async () => {},
  });
  const waiting = mgr.open('tab1', s.id, 80, 24).then(() => mgr.waitFor('tab1', ['echo:auto'], 3000));
  const r = await waiting;
  assert.strictEqual(r.index, 0, 'logon action should have sent "auto"');
  const w = mgr.waitFor('tab1', ['nope', 'echo:x'], 3000);
  mgr.write('tab1', 'x\r');
  assert.deepStrictEqual((await w).index, 1);
  const timeout = await mgr.waitFor('tab1', ['never'], 100);
  assert.strictEqual(timeout.index, -1);
  mgr.close('tab1');
  await new Promise((res) => setTimeout(res, 100));
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] Welcome/);
  assert.ok(events.some(([ch, p]) => ch === 'conn:state' && p.state === 'connected'));
  server.close();
});

test('save login: only a working password is saved, then no prompts on reconnect', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const port = server.address().port;
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-save-')), null);
  const prompts = [];
  const passwords = ['wrong', 'secret'];
  const ctx = {
    store,
    prompt: async (req) => {
      prompts.push(req.kind);
      if (req.kind === 'hostkey') return 'save';
      if (req.kind === 'text') {
        assert.ok(!req.offerSave, 'username prompt must not offer saving');
        return 'tester';
      }
      assert.strictEqual(req.offerSave, true, 'password prompt offers saving');
      if (req.kind === 'password') return { value: passwords.shift(), save: true };
      return null;
    },
  };
  // Ad-hoc quick-connect session: no username, password-only auth.
  const adHoc = { name: 'quick', protocol: 'ssh2', host: '127.0.0.1', port, auth: { methods: ['password'], useAgent: false } };
  const conn = new SshConnection(store.resolveSession(adHoc), ctx);
  const saved = new Promise((r) => conn.once('credentials', r));
  await conn.connect();
  const creds = await saved;
  assert.deepStrictEqual(creds, { username: 'tester', password: 'secret' }, 'username saved together with the password');
  assert.deepStrictEqual(prompts, ['text', 'hostkey', 'password', 'password']);
  conn.close();

  const session = store.saveCredentials(adHoc, creds);
  assert.strictEqual(session.username, 'tester');
  assert.strictEqual(session.auth.hasPassword, true);
  assert.ok(!JSON.stringify(store.getTree()).includes('secret'), 'password never exposed in the tree');
  assert.ok(!fs.readFileSync(store.files.sessions, 'utf8').includes('secret'), 'password not stored in plain text');

  // Reconnect with the saved session: no username or password prompts at all.
  prompts.length = 0;
  const again = new SshConnection(store.resolveSession(session.id), ctx);
  let emitted = false;
  again.on('credentials', () => { emitted = true; });
  await again.connect();
  assert.deepStrictEqual(prompts, []);
  assert.strictEqual(emitted, false);
  again.close();

  // Keyboard-interactive (how macOS sshd asks for passwords) can be saved too.
  const kbdStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-kbd-')), null);
  const kbdSession = kbdStore.saveSession({ name: 'k', protocol: 'ssh2', host: '127.0.0.1', port, username: 'tester', auth: { methods: ['keyboard-interactive'], useAgent: false } });
  const kbd = new SshConnection(kbdStore.resolveSession(kbdSession.id), {
    store: kbdStore,
    prompt: async (req) => (req.kind === 'hostkey' ? 'once' : (assert.strictEqual(req.offerSave, true), { answers: ['secret'], save: true })),
  });
  const kbdCreds = new Promise((r) => kbd.once('credentials', r));
  await kbd.connect();
  kbdStore.saveCredentials(kbdSession.id, await kbdCreds);
  kbd.close();
  assert.strictEqual(kbdStore.resolveSession(kbdSession.id).auth.password, 'secret');
  server.close();
});

test('save login: nothing is saved unless the box is ticked on the password prompt', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-nosave-')), null);
  const conn = new SshConnection(store.resolveSession({ protocol: 'ssh2', host: '127.0.0.1', port: server.address().port, auth: { methods: ['password'], useAgent: false } }), {
    store,
    prompt: async (req) => (req.kind === 'hostkey' ? 'once' : req.kind === 'text' ? 'tester' : { value: 'secret', save: false }),
  });
  let emitted = false;
  conn.on('credentials', () => { emitted = true; });
  await conn.connect();
  conn.close();
  assert.strictEqual(emitted, false);
});
