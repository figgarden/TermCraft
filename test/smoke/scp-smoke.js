// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// SCP Transfer Manager end-to-end (real scp server-side, through a jump host).
// Run: TERMCRAFT_SMOKE=test/smoke/scp-smoke.js TERMCRAFT_SHOTS=/tmp/shots npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(root, stats) {
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      client.on('session', (accept) => accept().on('exec', (acc, rej, info) => {
        const ch = acc();
        const proc = spawn('/bin/sh', ['-c', info.command], { cwd: root, env: { ...process.env, HOME: root } });
        ch.pipe(proc.stdin);
        proc.stdout.pipe(ch, { end: false });
        proc.stderr.pipe(ch.stderr, { end: false });
        proc.on('close', (code) => { ch.exit(code ?? 0); ch.end(); });
        ch.on('close', () => proc.kill());
      }));
      client.on('tcpip', (accept, reject, info) => {
        stats.tunnels++;
        const sock = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(sock).pipe(ch); });
        sock.on('error', () => reject());
      });
    });
    client.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = async function smoke(win, { store }) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(os.tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('[smoke] shot', name); };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const tab = 'window.termcraft.active';

  // Answer whatever dialog is showing: accept host keys, type the password.
  let answering = true;
  const prompts = [];
  (async () => {
    while (answering) {
      const title = await js(`document.querySelector('.modal-header span')?.textContent || ''`).catch(() => '');
      if (/Host Key/.test(title)) { prompts.push('hostkey'); await js(`document.querySelector('.modal-footer .primary').click()`); }
      else if (/Password/.test(title)) { prompts.push('password'); await js(`(() => { document.querySelector('.modal input[type=password]').value = 'secret'; document.querySelector('.modal-footer .primary').click(); })()`); }
      await sleep(100);
    }
  })();

  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scp-remote-'));
  fs.mkdirSync(path.join(remoteRoot, 'incoming'));
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scp-local-'));
  fs.writeFileSync(path.join(localRoot, 'notes.txt'), 'notes over a jump host\n');
  fs.mkdirSync(path.join(localRoot, 'configs', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(localRoot, 'configs', 'router.cfg'), 'hostname core1\n');
  fs.writeFileSync(path.join(localRoot, 'configs', 'nested', 'switch.cfg'), 'hostname sw1\n');
  fs.writeFileSync(path.join(localRoot, 'big.iso'), Buffer.alloc(400 * 1024 * 1024, 1));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scp-dl-'));

  const targetStats = { tunnels: 0 };
  const jumpStats = { tunnels: 0 };
  const target = await startServer(remoteRoot, targetStats);
  const jump = await startServer(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-jump-')), jumpStats);
  const bastion = store.saveSession({ name: 'Bastion', protocol: 'ssh2', host: '127.0.0.1', port: jump.address().port, username: 'ops', auth: { methods: ['password'], useAgent: false, password: 'secret' } });

  win.setSize(1280, 800);
  await sleep(800);
  await js(`window.termcraft.reloadTree()`);
  await js(`void window.termcraft.dispatch('scpTab')`);
  await sleep(400);
  check('SCP tab opened', (await js(`${tab}.kind`)) === 'scp');

  // Ad-hoc target, through the saved "Bastion" jump host.
  await js(`(() => { const t = ${tab}; t.hostInput.value = 'tester@127.0.0.1:${target.address().port}'; t.jumpSel.value = '${bastion.id}'; t.localInput.value = ${JSON.stringify(downloads)}; })()`);
  await js(`void ${tab}.connect()`);
  for (let i = 0; i < 60 && (await js(`${tab}.state`)) !== 'connected'; i++) await sleep(100);
  const status = await js(`${tab}.statusText.textContent`);
  check(`connected via jump host: "${status}"`, /via jump host Bastion/.test(status) && jumpStats.tunnels === 1);
  check(`prompts answered (${prompts.join(',')})`, prompts.includes('password'));

  await js(`${tab}.remoteInput.value = 'incoming'`);
  await js(`${tab}.queueUploads(${JSON.stringify([path.join(localRoot, 'notes.txt'), path.join(localRoot, 'configs')])})`);
  for (let i = 0; i < 50 && (await js(`${tab}.jobs.filter((j) => j.state === 'done').length`)) < 2; i++) await sleep(100);
  check('uploaded file', fs.readFileSync(path.join(remoteRoot, 'incoming', 'notes.txt'), 'utf8') === 'notes over a jump host\n');
  check('uploaded folder recursively', fs.readFileSync(path.join(remoteRoot, 'incoming', 'configs', 'nested', 'switch.cfg'), 'utf8') === 'hostname sw1\n');

  // Downloads (relative to the remote folder, plus a wildcard).
  await js(`${tab}._add({ dir: 'down', name: 'configs', src: 'incoming/configs', dest: ${JSON.stringify(downloads)} })`);
  await js(`${tab}._add({ dir: 'down', name: '*.txt', src: 'incoming/*.txt', dest: ${JSON.stringify(downloads)} })`);
  for (let i = 0; i < 50 && (await js(`${tab}.jobs.filter((j) => j.state === 'done').length`)) < 4; i++) await sleep(100);
  check('downloaded folder', fs.readFileSync(path.join(downloads, 'configs', 'router.cfg'), 'utf8') === 'hostname core1\n');
  check('downloaded wildcard', fs.existsSync(path.join(downloads, 'notes.txt')));

  // A big upload: capture it mid-flight, then cancel it.
  await js(`${tab}.queueUploads([${JSON.stringify(path.join(localRoot, 'big.iso'))}])`);
  for (let i = 0; i < 100 && !(await js(`(${tab}.jobs.at(-1).done || 0) > 5e6`)); i++) await sleep(50);
  await sleep(600);
  await shot('01-scp-transfers');
  const bigJob = await js(`${tab}.jobs.at(-1).state`);
  await js(`${tab}.cancel(${tab}.jobs.at(-1))`);
  for (let i = 0; i < 40 && (await js(`${tab}.jobs.at(-1).state`)) === 'active'; i++) await sleep(100);
  check(`big transfer was running (${bigJob}) and cancels`, bigJob === 'active' && (await js(`${tab}.jobs.at(-1).state`)) === 'cancelled');
  await sleep(300);
  await shot('02-scp-cancelled');

  // Switch the same tab to a direct connection.
  await js(`(() => { ${tab}.jumpSel.value = '__none'; })()`);
  await js(`void ${tab}.connect()`);
  for (let i = 0; i < 60 && (await js(`${tab}.state`)) !== 'connected'; i++) await sleep(100);
  check(`direct connection: "${await js(`${tab}.statusText.textContent`)}"`, /\(direct\)/.test(await js(`${tab}.statusText.textContent`)) && jumpStats.tunnels === 1);

  answering = false;
  target.close();
  jump.close();
  for (const d of [remoteRoot, localRoot, downloads]) fs.rmSync(d, { recursive: true, force: true });
};
