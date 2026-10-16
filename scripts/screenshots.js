// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Capture README screenshots from a clean demo profile (made-up hosts, no personal data).
// Run: TERMCRAFT_SMOKE=scripts/screenshots.js npx electron . --user-data-dir=$(mktemp -d)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

// Fake terminal output for the demo sessions (plain printf, rendered by a neutral /bin/sh).
const DEMOS = {
  web: [
    "ops@web-01:~$ systemctl status nginx --no-pager | head -4",
    "\\033[1;32m●\\033[0m nginx.service - A high performance web server",
    "     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)",
    "     Active: \\033[1;32mactive (running)\\033[0m since Mon 2026-10-12 09:14:02 UTC; 3 days ago",
    "ops@web-01:~$ tail -n 4 /var/log/nginx/error.log",
    "2026/10/15 18:02:11 [warn] 812#812: upstream response is buffered to a temporary file",
    "2026/10/15 18:04:37 [error] 812#812: connect() failed (111: Connection refused) while connecting to upstream",
    "2026/10/15 18:04:39 [notice] 812#812: upstream server is up again",
    "ops@web-01:~$ ",
  ],
  db: [
    "ops@db-01:~$ psql -c 'select now(), version();' | head -3",
    "              now              |  version",
    "-------------------------------+---------------------------------",
    " 2026-10-15 18:06:21.410+00    | PostgreSQL 17.4 on x86_64-pc-linux-gnu",
    "ops@db-01:~$ df -h /var/lib/postgresql",
    "Filesystem      Size  Used Avail Use% Mounted on",
    "/dev/nvme1n1    500G  212G  288G  43% /var/lib/postgresql",
    "ops@db-01:~$ ",
  ],
  sw: [
    "core-sw-01# show ip interface brief | include up",
    "Vlan10          10.10.0.1       YES NVRAM  up                    up",
    "Vlan20          10.20.0.1       YES NVRAM  up                    up",
    "Gi1/0/1         unassigned      YES unset  up                    up",
    "Gi1/0/24        unassigned      YES unset  down                  down",
    "core-sw-01# show logging | include FAIL",
    "%LINK-3-UPDOWN: Interface Gi1/0/24, changed state to down — link FAIL",
    "core-sw-01# ",
  ],
};

function startSshServer(root) {
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'demo' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => accept().on('exec', (acc, rej, info) => {
      const ch = acc();
      const proc = spawn('/bin/sh', ['-c', info.command], { cwd: root, env: { ...process.env, HOME: root } });
      ch.pipe(proc.stdin);
      proc.stdout.pipe(ch, { end: false });
      proc.stderr.pipe(ch.stderr, { end: false });
      proc.on('close', (code) => { ch.exit(code ?? 0); ch.end(); });
    })));
    client.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = async function screenshots(win, { store }) {
  fs.mkdirSync(OUT, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => {
    let img = await win.webContents.capturePage();
    if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'best' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('[shots]', name);
  };
  const modalClose = () => js(`document.querySelector('.modal-footer button')?.click()`);

  // Demo session tree: nothing here is real.
  const f = (name, parent = '') => store.saveFolder({ name, parent });
  const prod = f('Production');
  const stage = f('Staging');
  const net = f('Network');
  const ssh = (name, host, parent, extra = {}) => store.saveSession({ name, protocol: 'ssh2', host, port: 22, username: 'ops', parent: parent.id, ...extra });
  const bastion = ssh('bastion', 'bastion.example.net', prod);
  ssh('web-01', 'web-01.example.net', prod, { ssh: { jumpSessionId: bastion.id } });
  ssh('web-02', 'web-02.example.net', prod, { ssh: { jumpSessionId: bastion.id } });
  ssh('db-01', 'db-01.example.net', prod, { ssh: { jumpSessionId: bastion.id } });
  ssh('web-stage', 'web.stage.example.net', stage);
  store.saveSession({ name: 'core-sw-01', protocol: 'ssh2', host: '10.10.0.1', port: 22, username: 'admin', parent: net.id, terminal: { buttonBar: 'network' } });
  store.saveSession({ name: 'console (USB)', protocol: 'serial', serial: { path: '/dev/tty.usbserial-0001', baudRate: 9600 }, parent: net.id });
  store.saveSession({ name: 'build-win', protocol: 'rdp', host: 'build-win.example.net', port: 3389, username: 'ci', parent: stage.id });
  store.saveSession({ name: 'design-mac', protocol: 'vnc', host: 'design-mac.example.net', port: 5900, parent: stage.id });

  win.setSize(1440, 900);
  await sleep(600);
  await js(`window.termcraft.reloadTree()`);
  await js(`(() => { for (const n of document.querySelectorAll('.node.folder')) n.click(); })()`);
  await shot('welcome');

  // Three "server" tabs: local /bin/sh with a neutral prompt printing demo output.
  const demoTab = async (name, lines) => {
    await js(`void window.termcraft.openSession({ name: ${JSON.stringify(name)}, protocol: 'local', local: { shell: '/bin/sh', args: '' } })`);
    await sleep(900);
    // %% so printf prints literal percent signs; '\\'' to embed single quotes.
    const script = `PS1=''; clear; printf '${lines.map((l) => l.replace(/%/g, '%%').replace(/'/g, "'\\''")).join('\\n')}'`;
    await js(`window.termcraft.active.send(${JSON.stringify(script + '\r')})`);
    await sleep(500);
  };
  await demoTab('web-01', DEMOS.web);
  await demoTab('db-01', DEMOS.db);
  await demoTab('core-sw-01', DEMOS.sw);
  await js(`(() => { const s = document.querySelector('.bb-select'); s.value = 'network'; s.dispatchEvent(new Event('change')); })()`);
  await js(`window.termcraft.setLayout('tile-h')`);
  await sleep(800);
  await shot('stacked-sessions');
  await js(`window.termcraft.setLayout('grid')`);
  await sleep(600);
  await shot('grid');
  await js(`window.termcraft.setLayout('tabs')`);
  await js(`window.termcraft.activate(window.termcraft.tabs[0])`);
  await sleep(400);
  await shot('tabs');

  // Session editor on a jump-host session.
  const web01 = store.getTree().sessions.find((s) => s.name === 'web-01');
  await js(`(() => { window.termcraft.sm.selected = { kind: 'session', id: '${web01.id}' }; window.termcraft.sm.render(); })()`);
  await js(`void window.termcraft.sm.editSelected()`);
  await sleep(500);
  await js(`document.querySelector('.cat[data-cat="SSH"]').click()`);
  await sleep(300);
  await shot('session-options');
  await modalClose();
  await sleep(300);

  // SCP transfer manager with real transfers to a throwaway local server.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shot-remote-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shot-local-'));
  fs.mkdirSync(path.join(remote, 'releases'));
  for (const [n, size] of [['app-2026.10.15.tar.gz', 48e6], ['nginx.conf', 2400], ['migrations', 0]]) {
    if (size) fs.writeFileSync(path.join(local, n), Buffer.alloc(size, 7));
    else { fs.mkdirSync(path.join(local, n)); for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(local, n, `00${i}_schema.sql`), 'select 1;\n'); }
  }
  const server = await startSshServer(remote);
  // An unsaved session, so the demo server never appears in the Session Manager.
  const target = { name: 'web-01.example.net', protocol: 'ssh2', host: '127.0.0.1', port: server.address().port, username: 'ops', auth: { methods: ['password'], useAgent: false, password: 'demo' } };
  let answering = true;
  (async () => { while (answering) { if (/Host Key/.test(await js(`document.querySelector('.modal-header span')?.textContent || ''`).catch(() => ''))) await js(`document.querySelector('.modal-footer .primary').click()`); await sleep(100); } })();
  await js(`void window.termcraft.openScp(${JSON.stringify(target)})`);
  for (let i = 0; i < 60 && (await js(`window.termcraft.active.state`)) !== 'connected'; i++) await sleep(100);
  answering = false;
  await js(`(() => { const t = window.termcraft.active; t.remoteInput.value = 'releases'; t.localInput.value = ${JSON.stringify(local)}; t.statusText.textContent = 'Connected to ops@web-01.example.net:22 via jump host bastion — home /home/ops'; })()`);
  await js(`window.termcraft.active.queueUploads(${JSON.stringify(['app-2026.10.15.tar.gz', 'nginx.conf', 'migrations'].map((n) => path.join(local, n)))})`);
  for (let i = 0; i < 100 && (await js(`window.termcraft.active.jobs.filter((j) => j.state === 'done').length`)) < 3; i++) await sleep(100);
  // Show demo values instead of the throwaway server's address and temp folder.
  await js(`(() => {
    const t = window.termcraft.active;
    for (const el of document.querySelectorAll('.scp-table td.dest')) el.textContent = 'releases';
    t.localInput.value = '~/builds';
    t.info = { ...t.info, host: 'web-01.example.net', port: 22, via: 'bastion', username: 'ops' };
    window.termcraft.updateStatus();
    document.querySelectorAll('.toast').forEach((x) => x.remove());
  })()`);
  await sleep(300);
  await shot('scp-transfers');
  server.close();
  fs.rmSync(remote, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });

  // Button bar editor and light theme.
  await js(`window.termcraft.activate(window.termcraft.tabs[2])`);
  await js(`void window.termcraft.dispatch('editButtons')`);
  await sleep(500);
  await js(`(() => { const s = document.querySelector('.cat-content select'); s.value = 'network'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  await shot('button-bars');
  await modalClose();
  await js(`window.termcraft.saveSettings({ theme: 'light' })`);
  await js(`window.termcraft.activate(window.termcraft.tabs[0])`);
  await sleep(600);
  await shot('light-theme');
};
