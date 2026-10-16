// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// SCP against the real OpenSSH `scp` binary (run server-side via exec), directly and through a jump host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Duplex } = require('stream');
const { Server, utils } = require('ssh2');
const { SshConnection } = require('../src/main/protocols/ssh');
const { Store } = require('../src/main/store');
const scp = require('../src/main/scp');

const hostKey = utils.generateKeyPairSync('ed25519').private;

// These tests run the real OpenSSH scp binary through /bin/sh, which Windows runners don't have.
const posixOnly = process.platform === 'win32' ? { skip: 'needs /bin/sh and OpenSSH scp' } : {};
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `termcraft-${p}-`));

/** SSH server whose exec runs real commands with HOME/cwd = remoteRoot. Counts tunnel (jump) channels. */
function startServer(remoteRoot) {
  const clients = new Set();
  const stats = { tunnels: 0, execs: [] };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, reject, info) => {
          stats.execs.push(info.command);
          const ch = acceptExec();
          const proc = spawn('/bin/sh', ['-c', info.command], { cwd: remoteRoot, env: { ...process.env, HOME: remoteRoot } });
          ch.pipe(proc.stdin);
          proc.stdout.pipe(ch, { end: false });
          proc.stderr.pipe(ch.stderr, { end: false });
          proc.on('close', (code) => { ch.exit(code ?? 0); ch.end(); });
          ch.on('close', () => proc.kill());
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        stats.tunnels++;
        const sock = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(sock).pipe(ch); });
        sock.on('error', () => reject());
      });
    });
    client.on('error', () => {});
  });
  const close = server.close.bind(server);
  server.close = () => { for (const c of clients) c.end(); close(); };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, stats, port: server.address().port })));
}

function ctx(store) {
  return { store, prompt: async (req) => (req.kind === 'hostkey' ? 'once' : null) };
}

function makeLocalTree() {
  const dir = tmp('local');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello scp\n');
  fs.mkdirSync(path.join(dir, 'proj', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proj', 'a.txt'), 'A'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'proj', 'sub', 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 17, 7)); // > one chunk
  fs.writeFileSync(path.join(dir, "it's here.txt"), 'quote in name'); // shell quoting
  const old = new Date('2020-01-02T03:04:05Z');
  fs.utimesSync(path.join(dir, 'hello.txt'), old, old);
  return dir;
}

test('scp: upload and download files and folders, direct connection', posixOnly, async (t) => {
  const remote = tmp('remote');
  fs.mkdirSync(path.join(remote, 'uploads'));
  const { server, stats, port } = await startServer(remote);
  t.after(() => server.close());
  const store = new Store(tmp('store'), null);
  const conn = new SshConnection(store.resolveSession({ protocol: 'ssh2', host: '127.0.0.1', port, username: 'u', auth: { password: 'secret', methods: ['password'], useAgent: false } }), { ...ctx(store), mode: 'tunnel' });
  await conn.connect();
  t.after(() => conn.close());
  const exec = (c) => conn.exec(c);
  const local = makeLocalTree();

  const progress = [];
  const up = await scp.upload(exec, [path.join(local, 'hello.txt'), path.join(local, 'proj'), path.join(local, "it's here.txt")], 'uploads', { onProgress: (p) => progress.push(p) });
  assert.strictEqual(up.bytes, up.total);
  assert.strictEqual(fs.readFileSync(path.join(remote, 'uploads', 'hello.txt'), 'utf8'), 'hello scp\n');
  assert.ok(fs.readFileSync(path.join(remote, 'uploads', 'proj', 'sub', 'big.bin')).equals(Buffer.alloc(3 * 1024 * 1024 + 17, 7)));
  assert.strictEqual(fs.readFileSync(path.join(remote, 'uploads', "it's here.txt"), 'utf8'), 'quote in name');
  assert.strictEqual(fs.statSync(path.join(remote, 'uploads', 'hello.txt')).mtime.toISOString(), '2020-01-02T03:04:05.000Z', 'mtime preserved');
  assert.ok(progress.length > 3 && progress.at(-1).done === up.total);

  // Download the folder back, plus a ~/ path.
  const back = tmp('back');
  const down = await scp.download(exec, 'uploads/proj', back);
  assert.strictEqual(down.files, 2);
  assert.ok(fs.readFileSync(path.join(back, 'proj', 'sub', 'big.bin')).equals(Buffer.alloc(3 * 1024 * 1024 + 17, 7)));
  await scp.download(exec, '~/uploads/hello.txt', back);
  assert.strictEqual(fs.readFileSync(path.join(back, 'hello.txt'), 'utf8'), 'hello scp\n');
  assert.strictEqual(fs.statSync(path.join(back, 'hello.txt')).mtime.toISOString(), '2020-01-02T03:04:05.000Z');

  // Wildcards.
  const wild = tmp('wild');
  const w = await scp.download(exec, 'uploads/*.txt', wild);
  assert.strictEqual(w.files, 2);

  // Errors are reported, not hung.
  await assert.rejects(scp.upload(exec, [path.join(local, 'hello.txt')], 'no/such/dir'), /No such file|not a directory/i);
  await assert.rejects(scp.download(exec, 'missing.txt', back), /No such file/i);
  assert.strictEqual(stats.tunnels, 0, 'direct: no jump tunnel used');
});

test('scp: works through a jump host (saved and ad-hoc)', posixOnly, async (t) => {
  const remote = tmp('remote');
  const target = await startServer(remote);
  const jumpHost = await startServer(tmp('jumproot'));
  t.after(() => { target.server.close(); jumpHost.server.close(); });
  const store = new Store(tmp('store'), null);
  const auth = { password: 'secret', methods: ['password'], useAgent: false };
  const jumpSaved = store.saveSession({ name: 'bastion', protocol: 'ssh2', host: '127.0.0.1', port: jumpHost.port, username: 'j', auth });
  const local = makeLocalTree();

  // Saved jump session.
  const viaSaved = new SshConnection(store.resolveSession({ protocol: 'ssh2', host: '127.0.0.1', port: target.port, username: 'u', auth, ssh: { jumpSessionId: jumpSaved.id } }), { ...ctx(store), mode: 'tunnel' });
  await viaSaved.connect();
  await scp.upload((c) => viaSaved.exec(c), [path.join(local, 'hello.txt')], '.');
  viaSaved.close();
  assert.strictEqual(fs.readFileSync(path.join(remote, 'hello.txt'), 'utf8'), 'hello scp\n');
  assert.strictEqual(jumpHost.stats.tunnels, 1, 'went through the jump host');

  // Ad-hoc jump host (typed as user@host:port, not saved).
  const viaAdhoc = new SshConnection(store.resolveSession({
    protocol: 'ssh2', host: '127.0.0.1', port: target.port, username: 'u', auth,
    ssh: { jumpSession: { protocol: 'ssh2', host: '127.0.0.1', port: jumpHost.port, username: 'j', auth } },
  }), { ...ctx(store), mode: 'tunnel' });
  await viaAdhoc.connect();
  const back = tmp('back');
  await scp.download((c) => viaAdhoc.exec(c), 'hello.txt', back);
  viaAdhoc.close();
  assert.strictEqual(fs.readFileSync(path.join(back, 'hello.txt'), 'utf8'), 'hello scp\n');
  assert.strictEqual(jumpHost.stats.tunnels, 2);
  assert.strictEqual(target.stats.execs.length, 2, 'scp commands ran on the target, not the jump host');
  assert.strictEqual(jumpHost.stats.execs.length, 0);
});

/** Fake exec channel that replays a scripted server response (for malicious-server tests). */
function fakeExec(serverBytes) {
  return async () => {
    let sent = false;
    const d = new Duplex({
      read() { if (!sent) { sent = true; this.push(serverBytes); this.push(null); } },
      write(chunk, enc, cb) { cb(); },
    });
    d.stderr = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
    return d;
  };
}

test('scp: refuses path traversal from a malicious server', async () => {
  const dir = tmp('evil');
  for (const name of ['../escape.txt', '/etc/passwd', '..', 'a/b.txt']) {
    await assert.rejects(scp.download(fakeExec(Buffer.from(`C0644 4 ${name}\nevil\0`)), 'x', dir), /unsafe file name|unexpected file/i);
  }
  await assert.rejects(scp.download(fakeExec(Buffer.from('D0755 0 ..\nE\n')), 'x', dir), /unsafe directory name/i);
  // A server answering a request for "report.txt" with a different file is rejected too.
  await assert.rejects(scp.download(fakeExec(Buffer.from('C0644 4 .bashrc\nevil\0')), 'report.txt', dir), /unexpected file/i);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing written');
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.txt')));
});

test('scp: quoting and name checks', () => {
  assert.strictEqual(scp.quoteRemote("it's"), "it\\'s");
  assert.strictEqual(scp.quoteRemote('~/my dir/*.log'), '~/my\\ dir/*.log');
  assert.strictEqual(scp.quoteRemote('a;rm -rf x'), 'a\\;rm\\ -rf\\ x');
  assert.throws(() => scp.quoteRemote('a\nb'), /line break/);
  assert.strictEqual(scp.quoteRemote(''), '.');
  assert.ok(scp.safeName('report.txt'));
  assert.ok(!scp.safeName('../x') && !scp.safeName('a/b') && !scp.safeName('C:evil') && !scp.safeName('..'));
});
