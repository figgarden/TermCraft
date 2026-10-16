// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// End-to-end: embedded noVNC against a minimal RFB 3.8 server (with VNC auth), and the RDP tab.
// Run: TERMCRAFT_SMOKE=test/smoke/remote-desktop-smoke.js TERMCRAFT_SHOTS=/tmp/shots npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 640;
const H = 400;
const BANDS = [[226, 169, 59], [224, 83, 44], [46, 139, 133], [239, 229, 207]]; // mustard, vermilion, teal, cream

/** Minimal RFB 3.8 server: VNC auth (accepts any response), Raw encoding, a striped desktop. */
function startFakeVnc(stats) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = 'version';
    let pf = { bpp: 32, rShift: 16, gShift: 8, bShift: 0, big: false };
    const need = (n) => buf.length >= n;
    const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    sock.write('RFB 003.008\n');
    const frame = () => {
      const px = Buffer.alloc(W * H * 4);
      for (let y = 0; y < H; y++) {
        const [r, g, b] = BANDS[Math.floor((y / H) * BANDS.length)];
        for (let x = 0; x < W; x++) {
          const v = (r << pf.rShift) | (g << pf.gShift) | (b << pf.bShift);
          if (pf.big) px.writeUInt32BE(v >>> 0, (y * W + x) * 4); else px.writeUInt32LE(v >>> 0, (y * W + x) * 4);
        }
      }
      const head = Buffer.alloc(16);
      head.writeUInt8(0, 0); head.writeUInt16BE(1, 2);
      head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6); head.writeUInt16BE(W, 8); head.writeUInt16BE(H, 10);
      head.writeInt32BE(0, 12); // Raw
      sock.write(Buffer.concat([head, px]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') { if (!need(12)) return; take(12); sock.write(Buffer.from([1, 2])); stage = 'sectype'; continue; }
        if (stage === 'sectype') { if (!need(1)) return; take(1); sock.write(Buffer.alloc(16, 7)); stage = 'auth'; continue; }
        if (stage === 'auth') {
          if (!need(16)) return;
          take(16);
          stats.authed++;
          const ok = Buffer.alloc(4); sock.write(ok); stage = 'clientinit'; continue;
        }
        if (stage === 'clientinit') {
          if (!need(1)) return;
          take(1);
          const name = Buffer.from('TermCraft Test Desktop');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          init.writeUInt32BE(name.length, 20);
          sock.write(Buffer.concat([init, name]));
          stage = 'normal';
          continue;
        }
        if (!need(1)) return;
        const type = buf[0];
        if (type === 0) { if (!need(20)) return; const m = take(20); pf = { bpp: m[4], big: !!m[6], rShift: m[14], gShift: m[15], bShift: m[16] }; continue; }
        if (type === 2) { if (!need(4)) return; const n = buf.readUInt16BE(2); if (!need(4 + n * 4)) return; take(4 + n * 4); continue; }
        if (type === 3) {
          if (!need(10)) return;
          const m = take(10);
          if (m[1] === 0 || !stats.sentFrame) { stats.sentFrame = true; frame(); }
          else setTimeout(() => { if (!sock.destroyed) { const z = Buffer.alloc(4); sock.write(z); } }, 250);
          continue;
        }
        if (type === 4) { if (!need(8)) return; take(8); stats.keys++; continue; }
        if (type === 5) { if (!need(6)) return; take(6); continue; }
        if (type === 6) { if (!need(8)) return; const n = buf.readUInt32BE(4); if (!need(8 + n)) return; stats.clip = take(8 + n).subarray(8).toString('latin1'); continue; }
        sock.destroy(); return;
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = async function smoke(win, { store }) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(os.tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('[smoke] shot', name); };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const modal = () => js(`document.querySelector('.modal-header span')?.textContent || ''`);
  const waitFor = async (expr, ms = 6000) => { for (let i = 0; i < ms / 100; i++) { if (await js(expr)) return true; await sleep(100); } return false; };

  const stats = { authed: 0, keys: 0, sentFrame: false };
  const vnc = await startFakeVnc(stats);
  win.setSize(1280, 800);
  await sleep(800);
  await js(`localStorage.removeItem('termcraft.saveLogin')`);

  const sess = store.saveSession({ name: 'Studio Mac', protocol: 'vnc', host: '127.0.0.1', port: vnc.address().port });
  await js(`window.termcraft.reloadTree()`);
  await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.id === '${sess.id}'))`);

  check('VNC password prompt shown', await waitFor(`/VNC login/.test(document.querySelector('.modal-header span')?.textContent || '')`));
  await js(`(() => { document.querySelector('.modal input[type=password]').value = 'hunter2'; document.querySelector('.save-login input').click(); document.querySelector('.modal-footer .primary').click(); })()`);
  check('connected', await waitFor(`window.termcraft.active.state === 'connected'`));
  check('server saw authentication', stats.authed === 1);
  check('desktop name shown in tab', await waitFor(`window.termcraft.active.displayTitle === 'TermCraft Test Desktop'`));
  await sleep(800);
  const pixel = await js(`(() => { const c = document.querySelector('.vnc-screen canvas'); const x = c.getContext('2d'); const p = x.getImageData(20, 20, 1, 1).data; const q = x.getImageData(20, c.height - 20, 1, 1).data; return [c.width, c.height, ...p.slice(0, 3), ...q.slice(0, 3)].join(','); })()`);
  check(`framebuffer drawn (${pixel})`, pixel === `${W},${H},226,169,59,239,229,207`);
  await shot('01-vnc');

  // Typing goes to the remote desktop.
  await js(`window.termcraft.active.rfb.sendKey(0x61, 'KeyA')`);
  await sleep(200);
  check('keystrokes reach the server', stats.keys >= 2);

  const saved = store.getTree().sessions.find((s) => s.id === sess.id);
  check('VNC login saved (encrypted)', saved?.auth.hasPassword === true && !fs.readFileSync(store.files.sessions, 'utf8').includes('hunter2'));

  // Reconnect: no prompt this time.
  await js(`window.termcraft.active.disconnect()`);
  await sleep(300);
  await js(`void window.termcraft.active.connect()`);
  check('reconnected without a prompt', (await waitFor(`window.termcraft.active.state === 'connected'`)) && (await modal()) === '' && stats.authed === 2);

  // RDP tab, using a harmless custom client command instead of launching a real client.
  const marker = path.join(os.tmpdir(), `termcraft-rdp-smoke-${process.pid}.txt`);
  // Custom clients run without a shell; record the arguments with a tiny script (run by Electron as Node).
  const recorder = path.join(os.tmpdir(), `termcraft-rdp-recorder-${process.pid}.js`);
  fs.writeFileSync(recorder, "require('fs').writeFileSync(process.argv[2], process.argv.slice(3).join(' '))");
  store.saveSettings({ rdpClient: `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} ${JSON.stringify(marker)} {host} {port} {user}` });
  const rdp = store.saveSession({ name: 'Build Server (Windows)', protocol: 'rdp', host: 'build-01.example', port: 3389, username: 'alice', rdp: { domain: 'CORP' } });
  await js(`window.termcraft.reloadTree()`);
  await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.id === '${rdp.id}'))`);
  check('RDP launched', await waitFor(`window.termcraft.active.state === 'connected'`));
  await sleep(300);
  check('RDP client got the target', fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === 'build-01.example 3389 alice');
  check('RDP card has no stray "null" text', !(await js(`document.querySelector('.rdp-card').textContent.includes('null')`)));
  await shot('02-rdp');
  store.saveSettings({ rdpClient: '' });
  fs.rmSync(marker, { force: true });
  fs.rmSync(recorder, { force: true });

  vnc.close();
};
