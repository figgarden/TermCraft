// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// In-app attack tests: each check tries something a malicious server or compromised page would do.
// Run: TERMCRAFT_SMOKE=test/smoke/security-smoke.js npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, shell, dialog } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  // Fails (true) if the renderer-side call is rejected by the main process.
  const rejected = (expr) => js(`(${expr}).then(() => false, () => true)`);
  // Never actually open anything during tests.
  const externalOpened = [];
  shell.openExternal = async (u) => { externalOpened.push(u); };
  await sleep(1000);

  // --- Process isolation ------------------------------------------------------------
  check('renderer is sandboxed (webPreferences)', win.webContents.getLastWebPreferences().sandbox === true);
  check('no Node.js in the page', await js(`typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'`));
  check('context isolation: preload internals unreachable', await js(`typeof window.ipcRenderer === 'undefined' && typeof window.api.onRequest === 'function'`));

  // --- Content Security Policy ---------------------------------------------------------
  await js(`(() => { const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.append(s); })()`);
  await js(`(() => { const s = document.createElement('script'); s.src = 'data:text/javascript,window.__pwned2=1'; document.body.append(s); })()`);
  await js(`(() => { const i = document.createElement('img'); i.setAttribute('src', 'x'); i.setAttribute('onerror', 'window.__pwned3 = 1'); document.body.append(i); })()`);
  await sleep(300);
  check('CSP blocks injected inline script', (await js(`window.__pwned`)) == null);
  check('CSP blocks data: script', (await js(`window.__pwned2`)) == null);
  check('CSP blocks inline event handlers', (await js(`window.__pwned3`)) == null);
  check('CSP blocks plugins / objects', (await js(`(() => { const o = document.createElement('object'); o.data = 'file:///etc/hosts'; document.body.append(o); return o.contentDocument == null; })()`)));

  // --- Navigation and windows -----------------------------------------------------------
  const before = win.webContents.getURL();
  await js(`(() => { location.href = 'https://example.com/phish'; })()`);
  await sleep(400);
  check('page cannot navigate away', win.webContents.getURL() === before);
  await js(`window.open('file:///etc/passwd')`);
  await js(`window.open('javascript:alert(1)')`);
  await sleep(300);
  check('window.open creates no windows', BrowserWindow.getAllWindows().length === 1);
  check('non-http links never reach the OS', externalOpened.length === 0);
  await js(`window.open('https://example.com/docs')`);
  await sleep(200);
  check('http(s) links go to the system browser only', externalOpened.length === 1 && BrowserWindow.getAllWindows().length === 1);

  // --- Permissions -------------------------------------------------------------------------
  check('camera/microphone denied', await js(`navigator.mediaDevices.getUserMedia({ video: true }).then(() => false, () => true)`));
  check('notifications denied', (await js(`Notification.requestPermission()`)) !== 'granted');
  check('geolocation denied', await js(`new Promise((r) => navigator.geolocation.getCurrentPosition(() => r(false), () => r(true)))`));

  // --- IPC abuse from a compromised renderer -------------------------------------------------
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-attack-'));
  const victim = path.join(scratch, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  const pwned = path.join(scratch, 'PWNED');
  check('cannot read arbitrary files', await rejected(`window.api.file.readText('/etc/passwd')`));
  check('cannot run arbitrary commands', await rejected(`window.api.app.run('touch ${pwned}')`));
  check('cannot run an unapproved script', await rejected(`window.api.script.run('${victim}', null)`));
  check('cannot delete files outside browsed folders', await rejected(`window.api.sftp.localOp('delete', '${victim}')`));
  check('cannot open a file (could launch an executable)', (await js(`window.api.app.openPath('${victim}').then((r) => r)`)) === '');
  await sleep(300);
  check('victim file untouched, nothing executed', fs.readFileSync(victim, 'utf8') === 'keep me' && !fs.existsSync(pwned));
  await js(`window.api.store.saveSettings(JSON.parse('{"__proto__": {"rdpClient": "calc"}}'))`);
  check('prototype pollution via settings blocked', {}.rdpClient === undefined);

  // --- Launch Application buttons: no shell, native approval the page can't skip -------------------
  if (process.platform !== 'win32') {
    const asked = [];
    let answer = 0; // 0 Cancel, 1 Run Once, 2 Always Allow
    const realBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_w, opts) => { asked.push(opts.detail); return { response: answer }; };
    const marks = ['A', 'B', 'C'].map((n) => path.join(scratch, `INJECTED_${n}`));
    const cmd = `echo safe; touch ${marks[0]} && touch ${marks[1]} $(touch ${marks[2]}) \`touch ${marks[2]}\``;
    // A compromised page plants a button, then tries to run it.
    await js(`window.api.store.saveSettings({ buttonBars: [{ id: 'evil', name: 'Evil', buttons: [{ label: 'x', action: 'run', value: ${JSON.stringify(cmd)} }] }] })`);
    check('planted command still needs native approval (Cancel = not run)', (await js(`window.api.app.run(${JSON.stringify(cmd)})`)) === false && asked.length === 1);
    answer = 1;
    check('approved command runs', (await js(`window.api.app.run(${JSON.stringify(cmd)})`)) === true);
    await sleep(500);
    check('shell operators ; && $( ) and backticks are not interpreted', marks.every((m) => !fs.existsSync(m)));
    check('approval dialog shows the exact program and command', /Program: echo/.test(asked[1]) && asked[1].includes(cmd));
    answer = 2;
    await js(`window.api.app.run(${JSON.stringify(cmd)})`);
    await js(`window.api.app.run(${JSON.stringify(cmd)})`);
    check('"Always Allow" is remembered for that exact command', asked.length === 3);
    const missing = 'no-such-program-termcraft';
    await js(`window.api.store.saveSettings({ buttonBars: [{ id: 'evil', name: 'Evil', buttons: [{ label: 'x', action: 'run', value: '${missing}' }] }] })`);
    check('missing program reports an error', (await js(`window.api.app.run('${missing}').then(() => '', (e) => e.message)`)).includes('Program not found'));
    dialog.showMessageBox = realBox;
  }

  // --- Terminal output cannot inject HTML ---------------------------------------------------------
  await js(`void window.termcraft.dispatch('localShell')`);
  await sleep(1500);
  await js(`window.termcraft.active.send("printf '\\\\033]0;<img src=x onerror=window.__pwned4=1>\\\\007'\\r")`);
  await sleep(800);
  check('remote window title is shown as text, not HTML', (await js(`document.querySelectorAll('.tabbar img, .pane-title img').length`)) === 0 && (await js(`window.__pwned4`)) == null);
  await js(`window.termcraft.active.send("printf '\\\\033]8;;file:///etc/passwd\\\\033\\\\\\\\click\\\\033]8;;\\\\033\\\\\\\\\\\\n'\\r")`);
  await sleep(500);
  check('OSC 8 links to non-http targets are not followed', externalOpened.length === 1);

  fs.rmSync(scratch, { recursive: true, force: true });
};
