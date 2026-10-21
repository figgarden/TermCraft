// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Button bars end-to-end. Run: npm run test:e2e -- button-bars
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win, { store }) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('[smoke] shot', name); };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const screen = () => js(`window.termcraft.active.screenLines().join('\\n')`);
  const barName = () => js(`document.querySelector('.bb-select').selectedOptions[0].textContent`);
  const labels = () => js(`[...document.querySelectorAll('.bb-buttons .bb:not(.bb-add)')].map((b) => b.textContent).join('|')`);
  const modal = () => js(`document.querySelector('.modal-header span')?.textContent || ''`);
  const waitFor = async (expr, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { if (await js(expr)) return true; await sleep(100); } return false; };

  win.setSize(1280, 800);
  // A cold start can take a few seconds: wait for the app and the shell tab rather than a fixed delay.
  await waitFor(`!!(window.termcraft && document.querySelector('.bb-select'))`);
  await js(`void window.termcraft.dispatch('localShell')`);
  await waitFor(`window.termcraft.active?.state === 'connected'`);
  await sleep(500);

  check(`starts on Default bar (${await barName()})`, (await barName()) === 'Default');
  check(`default buttons (${await labels()})`, (await labels()).startsWith('ls -la|'));

  // Switch to the Network Devices bar via the dropdown.
  await js(`(() => { const s = document.querySelector('.bb-select'); s.value = 'network'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  check(`switched to Network Devices (${await labels()})`, (await barName()) === 'Network Devices' && (await labels()).includes('show ver'));
  await shot('01-network-bar');

  // Create a new bar.
  await js(`void window.termcraft.buttons.newBar()`);
  await sleep(300);
  await js(`(() => { const i = document.querySelector('.modal input'); i.value = 'Linux Admin'; document.querySelector('.modal-footer .primary').click(); })()`);
  await sleep(500);
  check(`new bar "Linux Admin" selected and empty`, (await barName()) === 'Linux Admin' && (await labels()) === '');

  // Add a button through the Map Button dialog (＋ on the bar).
  await js(`document.querySelector('.bb-add').click()`);
  await sleep(400);
  check(`map button dialog opens (${await modal()})`, /New Button/.test(await modal()));
  await js(`(() => {
    const m = document.querySelector('.modal');
    const label = m.querySelector('input[aria-label=Label]'); label.value = 'Who'; label.dispatchEvent(new Event('input'));
    m.querySelector('textarea[aria-label="String to send"]').value = 'echo termcraft-button-ok\\\\r';
    const c = m.querySelector('select[aria-label=Color]'); c.value = 'green'; c.dispatchEvent(new Event('change'));
    m.querySelector('input[aria-label=Tooltip]').value = 'Prints the current user';
  })()`);
  await shot('02-map-button-dialog');
  await js(`document.querySelector('.modal-footer .primary').click()`);
  await sleep(500);
  check(`button added (${await labels()})`, (await labels()) === 'Who');

  // Click it: sends to the active terminal.
  await js(`document.querySelector('.bb-buttons .bb').click()`);
  await sleep(800);
  // Match the command's output line, not the echoed command itself.
  check('button sent its command', /^termcraft-button-ok\s*$/m.test(await screen()));

  // A ${prompt:} button asks for a value, then sends it.
  await js(`window.termcraft.buttons.save([...window.termcraft.settings.buttonBars.map((b) => b.id === window.termcraft.buttons.current.id ? { ...b, buttons: [...b.buttons, { label: 'Greet…', action: 'send', value: 'echo hello \${prompt:Name}\\\\r', color: 'blue' }] } : b)])`);
  await sleep(400);
  await js(`document.querySelectorAll('.bb-buttons .bb')[1].click()`);
  await sleep(400);
  check(`prompt variable asks (${await modal()})`, /Button Input/.test(await modal()));
  await js(`(() => { document.querySelector('.modal input').value = 'TermCraft'; document.querySelector('.modal-footer .primary').click(); })()`);
  await sleep(800);
  check('prompted value was sent', (await screen()).includes('hello TermCraft'));

  // Reorder by moving the second button first.
  await js(`window.termcraft.buttons.move(1, 0)`);
  await sleep(300);
  check(`reordered (${await labels()})`, (await labels()) === 'Greet…|Who');
  await shot('03-linux-admin-bar');

  // Right-click menu on a button.
  await js(`document.querySelector('.bb-buttons .bb').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 700 }))`);
  await sleep(300);
  const menuItems = await js(`[...document.querySelectorAll('.context-menu .item')].map((i) => i.textContent).join('|')`);
  check(`button context menu (${menuItems})`, /Edit Button/.test(menuItems) && /Delete Button/.test(menuItems) && /Copy to/.test(menuItems));
  await shot('04-button-context-menu');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

  // Per-session bar: a saved session that always shows "Network Devices".
  const saved = await store.saveSession({ name: 'Core Switch (local)', protocol: 'local', terminal: { buttonBar: 'network' } });
  await js(`window.termcraft.reloadTree()`);
  await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.id === '${saved.id}'))`);
  await sleep(1200);
  check(`session tab shows its own bar (${await barName()})`, (await barName()) === 'Network Devices');
  await js(`window.termcraft.activate(window.termcraft.tabs[0])`);
  await sleep(300);
  check(`other tab returns to selected bar (${await barName()})`, (await barName()) === 'Linux Admin');

  // Persistence.
  const s = (await store.getSettings());
  check('bars persisted', s.buttonBars.some((b) => b.name === 'Linux Admin' && b.buttons.length === 2) && s.activeButtonBar === s.buttonBars.find((b) => b.name === 'Linux Admin').id);

  // Global Options editor.
  await js(`void window.termcraft.dispatch('editButtons')`);
  await sleep(500);
  await shot('05-global-options-button-bars');
  await js(`document.querySelector('.modal-footer button').click()`);
};
