// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// End-to-end checks for the network/sysadmin tools against a fake Telnet switch on localhost.
// Run: TERMCRAFT_SMOKE=test/smoke/netops-smoke.js npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const { dialog } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Cisco-like switch over Telnet: login, "terminal"-free paging with --More--. */
function fakeSwitch() {
  const server = net.createServer((sock) => {
    let stage = 'user';
    let line = '';
    let user = '';
    let skip = 0;
    let more = false;
    sock.write('\r\nUser Access Verification\r\n\r\nUsername: ');
    sock.on('data', (buf) => {
      for (const b of buf) {
        if (skip) { skip--; continue; }
        if (b === 255) { skip = 2; continue; } // ignore telnet negotiation
        const ch = String.fromCharCode(b);
        if (ch === '\n' || ch === '\0') continue;
        if (more) { more = false; sock.write('\r          \r\nlab-sw1 uptime is 3 weeks\r\nlab-sw1#'); continue; }
        if (ch !== '\r') { line += ch; if (stage !== 'pass') sock.write(ch); continue; }
        const cmd = line; line = '';
        if (stage === 'user') { user = cmd; stage = 'pass'; sock.write('\r\nPassword: '); continue; }
        if (stage === 'pass') { stage = user === 'netops' && cmd === 'S3cret!' ? 'cli' : 'user'; sock.write(stage === 'cli' ? '\r\nlab-sw1#' : '\r\n% Login invalid\r\nUsername: '); continue; }
        if (cmd === 'show version') { more = true; sock.write('\r\nCisco IOS Software, C2960 (fake)\r\n --More-- '); } else sock.write(`\r\n% output of ${cmd}\r\nlab-sw1#`);
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function tftpGet(port, name) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const req = Buffer.concat([Buffer.from([0, 1]), Buffer.from(`${name}\0octet\0`)]);
    const chunks = [];
    const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 5000);
    sock.on('message', (m, r) => {
      if (m.readUInt16BE(0) === 5) { clearTimeout(t); sock.close(); return resolve({ error: m.readUInt16BE(2) }); }
      chunks.push(m.subarray(4));
      sock.send(Buffer.from([0, 4, m[2], m[3]]), r.port, r.address);
      if (m.length - 4 < 512) { clearTimeout(t); sock.close(); resolve({ data: Buffer.concat(chunks) }); }
    });
    sock.send(req, port, '127.0.0.1');
  });
}

module.exports = async function smoke(win) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const rejected = (expr) => js(`(${expr}).then(() => '', (e) => e.message)`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-netops-'));
  // Native dialogs answer with scratch paths.
  const answers = [];
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [answers.shift()] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: answers.shift() });
  await sleep(1000);

  // --- shared credential + bulk import ---------------------------------------------------
  const sw = await fakeSwitch();
  const port = sw.address().port;
  await js(`window.api.store.saveCredential({ name: 'TACACS', username: 'netops', password: 'S3cret!' })`);
  const csv = `name,host,folder,protocol,credential\nlab-sw1,127.0.0.1:${port},Lab/Access,telnet,TACACS\nlab-sw2,127.0.0.1:1,Lab/Access,telnet,TACACS`;
  const parsed = JSON.parse(await js(`window.api.store.parseHosts(${JSON.stringify(csv)}, {})`));
  check('CSV import parses rows', parsed.rows.length === 2 && parsed.rows[0].port === port);
  const imp = JSON.parse(await js(`window.api.store.importHosts(${JSON.stringify(parsed.rows)}, {})`));
  check('hosts imported into Lab/Access', imp.created === 2);
  await js(`window.termcraft.reloadTree()`);
  const tree = JSON.parse(await js(`window.termcraft.tree`));
  const sw1 = tree.sessions.find((s) => s.name === 'lab-sw1');
  const lab = tree.folders.find((f) => f.name === 'Lab');
  check('credential linked by name and its secret hidden from the page', !!sw1?.auth.credentialId && !JSON.stringify(tree).includes('S3cret'));

  // --- telnet auto-login in a real tab ------------------------------------------------------
  await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.name === 'lab-sw1'))`);
  await sleep(2500);
  const screen = await js(`window.termcraft.active.screenLines().join('\\n')`);
  check('telnet auto-login answers Username/Password from the credential', /lab-sw1#\s*$/m.test(screen) && !screen.includes('S3cret'));

  // --- folder color reaches the tab ---------------------------------------------------------
  await js(`window.api.store.saveFolder({ ...window.termcraft.tree.folders.find((f) => f.name === 'Lab'), color: '#e5484d' })`);
  await js(`window.termcraft.reloadTree().then(() => window.termcraft.renderTabs())`);
  check('folder color marks the tab', (await js(`getComputedStyle(document.querySelector('.tab.active')).getPropertyValue('--tab-color').trim()`)) === '#e5484d');

  // --- save output ----------------------------------------------------------------------------
  const outFile = path.join(scratch, 'out.txt');
  answers.push(outFile);
  await js(`window.termcraft.dispatch('saveOutput')`);
  await sleep(300);
  check('Save Output writes the scrollback', fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').includes('User Access Verification'));

  // --- run commands on a folder ------------------------------------------------------------------
  const outRoot = path.join(scratch, 'runs');
  fs.mkdirSync(outRoot);
  answers.push(outRoot);
  const chosen = await js(`window.api.dialog.openDir({ title: 'x' })`);
  await js(`void window.termcraft.openBatch({ sessionIds: window.termcraft.tree.sessions.filter((s) => s.parent && s.name.startsWith('lab-')).map((s) => s.id), commands: ['show version', 'show clock'], concurrency: 2, timeoutSec: 10, outputDir: ${JSON.stringify(chosen)} })`);
  for (let i = 0; i < 200 && (await js(`window.termcraft.active.state`)) === 'connecting'; i++) await sleep(100);
  const runDir = fs.readdirSync(outRoot).map((d) => path.join(outRoot, d))[0];
  const out = runDir && fs.existsSync(path.join(runDir, 'lab-sw1.txt')) ? fs.readFileSync(path.join(runDir, 'lab-sw1.txt'), 'utf8') : '';
  check('batch output saved per device, pager answered', /lab-sw1# show version\nCisco IOS Software, C2960 \(fake\)\n.*uptime is 3 weeks/s.test(out) && /lab-sw1# show clock\n% output of show clock/.test(out));
  check('batch reports the unreachable device as failed', /Done.*Failed|Failed.*Done/s.test(await js(`[...document.querySelectorAll('.scp-table td.status')].map((x) => x.textContent).join(' ')`)));
  check('batch never writes the password to the output', !out.includes('S3cret'));
  check('batch refuses an output folder that was not picked in a dialog', /Browse/.test(await rejected(`window.api.batch.start('x', { sessionIds: ['${sw1.id}'], commands: ['x'], outputDir: ${JSON.stringify(os.homedir())} })`)));

  // --- TFTP server ----------------------------------------------------------------------------------
  const tftpRoot = path.join(scratch, 'tftp');
  fs.mkdirSync(tftpRoot);
  fs.writeFileSync(path.join(tftpRoot, 'ios.bin'), Buffer.alloc(3000, 7));
  check('TFTP refuses a folder that was not picked in a dialog (e.g. ~/.ssh)', /Browse/.test(await rejected(`window.api.tftp.start({ root: ${JSON.stringify(path.join(os.homedir(), '.ssh'))}, port: 0 })`)));
  await js(`window.termcraft.openTftp()`);
  await sleep(300);
  answers.push(tftpRoot);
  await js(`[...document.querySelectorAll('.pane.active button')].find((b) => b.textContent === 'Browse…').click()`);
  await sleep(200);
  const tport = 20000 + Math.floor(Math.random() * 20000);
  await js(`(() => { const t = window.termcraft.active; t.port.value = '${tport}'; t.iface.value = '127.0.0.1'; return t.start(); })()`);
  await sleep(300);
  const got = await tftpGet(tport, 'ios.bin').catch((e) => ({ error: e.message }));
  check('TFTP serves a file from the chosen folder', got.data?.length === 3000);
  check('TFTP refuses paths outside the folder', (await tftpGet(tport, '../../etc/hosts').catch(() => ({}))).error === 2);
  await sleep(400);
  check('TFTP tab lists the transfer', /ios\.bin/.test(await js(`document.querySelector('.pane.active tbody').textContent`)));
  await js(`window.termcraft.active.stop()`);

  // --- highlight presets and session editor ------------------------------------------------------------
  await js(`void window.termcraft.dispatch('editHighlights')`);
  await sleep(400);
  const before = Number(await js(`document.querySelectorAll('.list-editor tbody tr').length`));
  await js(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Network devices').click()`);
  check('network highlight preset adds rules', Number(await js(`document.querySelectorAll('.list-editor tbody tr').length`)) > before);
  await js(`document.querySelector('.modal-footer button').click()`);
  await sleep(200);
  await js(`void window.termcraft.sm.editSelected.call(Object.assign(window.termcraft.sm, { selected: { kind: 'session', id: '${sw1.id}' } }))`);
  await sleep(400);
  await js(`document.querySelector('.cat[data-cat="Authentication"]').click()`);
  check('telnet session shows Credential and auto-login options', (await js(`document.querySelector('[data-path="auth.credentialId"]').value`)) === sw1.auth.credentialId
    && (await js(`!document.querySelector('[data-path="auth.autoLogin"]').closest('.inband-only').hidden`)));
  await js(`document.querySelector('.modal-footer button').click()`);

  sw.close();
  fs.rmSync(scratch, { recursive: true, force: true });
};
