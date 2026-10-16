// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { parseHosts } = require('../src/main/host-import');
const { createAutoLogin } = require('../src/main/auto-login');
const keys = require('../src/main/ssh-keys');

const newStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-')), null);

test('credentials: shared login is applied, hidden from the UI, and updated once for every session', () => {
  const store = newStore();
  const cred = store.saveCredential({ name: 'TACACS', username: 'netops', password: 'Old-Secret-1' });
  assert.strictEqual(cred.hasPassword, true);
  assert.strictEqual(cred.password, undefined);
  const a = store.saveSession({ name: 'sw1', protocol: 'telnet', host: '10.0.0.1', username: 'local', auth: { credentialId: cred.id } });
  const b = store.saveSession({ name: 'sw2', protocol: 'ssh2', host: '10.0.0.2', auth: { credentialId: cred.id } });
  assert.strictEqual(store.resolveSession(a.id).username, 'netops');
  assert.strictEqual(store.resolveSession(b.id).auth.password, 'Old-Secret-1');
  assert.strictEqual(store.getTree().credentials[0].usedBy, 2);
  assert.ok(!JSON.stringify(store.getTree()).includes('Old-Secret-1'), 'no secret reaches the renderer');
  // A "Save login" after a password change updates the credential, not the session.
  store.saveCredentials(a.id, { username: 'netops', password: 'new' });
  assert.strictEqual(store.resolveSession(b.id).auth.password, 'new');
  assert.strictEqual(store.getSession(a.id).auth.password, '');
  // Deleting it falls back to the session's own login.
  store.deleteCredential(cred.id);
  assert.strictEqual(store.resolveSession(a.id).username, 'local');
  assert.strictEqual(store.getSession(a.id).auth.credentialId, '');
});

test('credentials: export/import keeps the link and only exports secrets when asked', () => {
  const store = newStore();
  const cred = store.saveCredential({ name: 'Lab', username: 'admin', password: 'pw' });
  store.saveSession({ name: 'r1', protocol: 'ssh2', host: 'r1', auth: { credentialId: cred.id } });
  const plain = store.exportSessions(false);
  assert.strictEqual(plain.credentials[0].password, '');
  const other = newStore();
  other.importSessions(store.exportSessions(true));
  const s = other.getTree().sessions.find((x) => x.name === 'r1');
  assert.strictEqual(other.resolveSession(s.id).auth.password, 'pw');
  assert.notStrictEqual(s.auth.credentialId, cred.id, 'imported credentials get new ids');
});

test('host import: CSV with folders, credentials and jump hosts by name', () => {
  const store = newStore();
  store.saveCredential({ name: 'TACACS', username: 'netops', password: 'x' });
  const { rows, errors } = parseHosts('name,host,folder,protocol,credential,jump\nbastion,bastion.example.net,Sites/HQ,ssh,TACACS,\nsw1,10.0.0.1,Sites/HQ,telnet,TACACS,\nsw2,10.0.0.2,Sites/Branch,ssh,nope,bastion\n,!!bad,,,,');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(errors.length, 1);
  const r = store.importHosts(rows, {});
  assert.strictEqual(r.created, 3);
  assert.deepStrictEqual(r.warnings, ['sw2: no credential named "nope"']);
  const tree = store.getTree();
  const sites = tree.folders.find((f) => f.name === 'Sites');
  const hq = tree.folders.find((f) => f.name === 'HQ');
  assert.strictEqual(hq.parent, sites.id);
  const sw1 = tree.sessions.find((s) => s.name === 'sw1');
  assert.strictEqual(sw1.parent, hq.id);
  assert.strictEqual(sw1.port, 23);
  assert.strictEqual(store.resolveSession(sw1.id).username, 'netops');
  const sw2 = tree.sessions.find((s) => s.name === 'sw2');
  assert.strictEqual(sw2.ssh.jumpSessionId, tree.sessions.find((s) => s.name === 'bastion').id);
  // Importing again skips existing hosts.
  assert.deepStrictEqual(store.importHosts(rows, {}).created, 0);
  assert.strictEqual(tree.folders.filter((f) => f.name === 'HQ').length, 1);
});

test('auto-login: answers each prompt once, only for in-band protocols', () => {
  const al = createAutoLogin({ protocol: 'telnet', username: 'netops', auth: { password: 'pw' } });
  assert.strictEqual(al.feed('\r\nUser Access Verification\r\n\r\nUsername: '), 'netops\r');
  assert.strictEqual(al.feed('\r\nPassword: '), 'pw\r');
  assert.strictEqual(al.feed('\r\n% Login invalid\r\nUsername: '), null, 'never loops on a wrong password');
  assert.strictEqual(createAutoLogin({ protocol: 'ssh2', username: 'u', auth: { password: 'p' } }), null);
  assert.strictEqual(createAutoLogin({ protocol: 'serial', username: 'u', auth: { password: 'p', autoLogin: false } }), null);
  const r = createAutoLogin({ protocol: 'rlogin', username: 'u', auth: { password: 'p' } });
  assert.strictEqual(r.feed('login: '), null, 'rlogin sends the user name itself');
  assert.strictEqual(r.feed('Password:'), 'p\r');
  let t = 0;
  const late = createAutoLogin({ protocol: 'serial', username: 'u', auth: { password: 'p' } }, () => t);
  t = 200000;
  assert.strictEqual(late.feed('Password: '), null, 'nothing is answered after the login window');
  assert.strictEqual(createAutoLogin({ protocol: 'telnet', username: 'u', auth: {} }).feed('Last login: Mon\r\n$ '), null);
});

test('ssh keys: generate, list, and a safe install command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'));
  const k = keys.generateKey({ name: 'id_ed25519_test', kind: 'ed25519', passphrase: 'secret pw', comment: 'me@laptop' }, home);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(k.privateKey).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
  }
  assert.match(fs.readFileSync(k.privateKey, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  assert.throws(() => keys.generateKey({ name: 'id_ed25519_test' }, home), /already exists/);
  assert.throws(() => keys.generateKey({ name: '../evil' }, home), /simple file name/);
  const list = keys.listPublicKeys(home);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].comment, 'me@laptop');
  assert.match(list[0].fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const cmd = keys.installCommand(list[0].line);
  assert.ok(cmd.includes(`'${list[0].line}'`));
  assert.throws(() => keys.installCommand("ssh-ed25519 AAAA x'; rm -rf ~; echo '"), /valid/);
  assert.throws(() => keys.installCommand('ssh-ed25519 AAAA $(id)'), /valid/);
});

test('telnet: an unreachable host fails within the connect timeout instead of hanging', { timeout: 10000 }, async () => {
  const { TelnetConnection } = require('../src/main/protocols/simple');
  const c = new TelnetConnection({ protocol: 'telnet', host: '192.0.2.1', port: 23, terminal: {}, ssh: { readyTimeout: 1 } }, {});
  const t0 = Date.now();
  await assert.rejects(c.connect(80, 24));
  assert.ok(Date.now() - t0 < 3000);
  c.close();
});
