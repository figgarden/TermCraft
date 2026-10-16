// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// ZMODEM auto-start in a real terminal tab: "rz" on the other side asks for files, "sz" downloads.
// Needs lrzsz (rz/sz) on this machine; skipped otherwise.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { dialog } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (process.platform === 'win32') { console.log('[smoke] PASS skipped on Windows (rz/sz are Unix tools)'); return; }
  const rz = (spawnSync('/bin/sh', ['-c', 'command -v rz || ls /opt/homebrew/bin/rz /usr/local/bin/rz /usr/bin/rz 2>/dev/null | head -1'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  if (!rz) { console.log('[smoke] PASS skipped: lrzsz not installed'); return; }
  const binDir = path.dirname(rz);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-zm-'));
  const src = path.join(dir, 'src');
  const dest = path.join(dir, 'device');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  const files = { '1-loader.bin': crypto.randomBytes(40000), '2-kernel.img': crypto.randomBytes(150000), '3-config.txt': Buffer.from('hostname lab-5164\n') };
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(src, n), d);
  // The "Send" file dialog picks the files in the wrong order on purpose.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['3-config.txt', '1-loader.bin', '2-kernel.img'].map((n) => path.join(src, n)) });
  await sleep(1000);

  await js(`void window.termcraft.openSession({ name: 'device', protocol: 'local', local: { shell: '/bin/sh', args: '', cwd: ${JSON.stringify(dest)} } })`);
  await sleep(1200);
  await js(`window.termcraft.active.send(${JSON.stringify(`cd '${dest}' && PATH='${binDir}':$PATH rz\r`)})`);
  // The order dialog appears: it should already be sorted 1, 2, 3; press Send.
  let shown = '';
  for (let i = 0; i < 200 && !shown; i++) { await sleep(100); shown = await js(`document.querySelector('.modal-header span')?.textContent || ''`); }
  check('rz in the terminal starts ZMODEM and asks to order the files', /Send 3 Files — ZMODEM/.test(shown));
  check('a series of files is offered in order', (await js(`[...document.querySelectorAll('.modal td.name')].map((x) => x.textContent).join(',')`)) === '1-loader.bin,2-kernel.img,3-config.txt');
  await js(`document.querySelector('.modal-footer .primary').click()`);
  for (let i = 0; i < 300 && fs.readdirSync(dest).length < 3; i++) await sleep(100);
  await sleep(500);
  check('all files arrive intact on the device side', Object.entries(files).every(([n, d]) => fs.existsSync(path.join(dest, n)) && fs.readFileSync(path.join(dest, n)).equals(d)));
  const screen = await js(`window.termcraft.active.screenLines().join('\\n')`);
  check('the terminal is usable again afterwards', /ZMODEM transfer complete/.test(screen));
  check('no ZMODEM control garbage is printed', !/\*\*\x18B0|B0100000023be50/.test(screen));

  // sz from the device: downloads to ~/Downloads under a unique name.
  const name = `termcraft-smoke-${Date.now()}.bin`;
  const payload = crypto.randomBytes(60000);
  fs.writeFileSync(path.join(dest, name), payload);
  await js(`window.termcraft.active.send(${JSON.stringify(`PATH='${binDir}':$PATH sz ${name}\r`)})`);
  const got = path.join(os.homedir(), 'Downloads', name);
  for (let i = 0; i < 300 && !fs.existsSync(got); i++) await sleep(100);
  await sleep(300);
  check('sz in the terminal downloads automatically to Downloads', fs.existsSync(got) && fs.readFileSync(got).equals(payload));
  fs.rmSync(got, { force: true });

  // Cancelling the file picker cancels the device's rz cleanly.
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await js(`window.termcraft.active.send(${JSON.stringify(`PATH='${binDir}':$PATH rz; echo RZ-DONE\r`)})`);
  let done = false;
  for (let i = 0; i < 300 && !done; i++) { await sleep(100); done = /RZ-DONE\s*$/m.test(await js(`window.termcraft.active.screenLines().join('\\n')`)); }
  check('cancelling the file picker stops rz and returns to the prompt', done);
  fs.rmSync(dir, { recursive: true, force: true });
};
