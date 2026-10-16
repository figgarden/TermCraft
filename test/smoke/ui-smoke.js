// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// UI smoke test. Run: TERMCRAFT_SMOKE=test/smoke/ui-smoke.js TERMCRAFT_SHOTS=/tmp/shots npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  // Wrap so non-cloneable results (tabs, DOM nodes) come back as null.
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    console.log('[smoke] shot', name);
  };
  win.setSize(1280, 800);
  await sleep(1200);
  await shot('01-welcome');

  // Local shell tab with keyword highlighting.
  await js(`window.termcraft.dispatch('localShell')`);
  await sleep(1500);
  await js(`window.termcraft.active.send("echo 'hello from TermCraft: build OK, 0 errors, warning none'\\r")`);
  await sleep(800);
  const screen = await js(`window.termcraft.active.screenLines().join('\\n')`);
  console.log('[smoke] screen contains hello:', screen.includes('hello from TermCraft'));
  console.log('[smoke] state:', await js(`window.termcraft.active.state`));
  await shot('02-local-shell');

  // Second tab + tiling.
  await js(`window.termcraft.dispatch('localShell')`);
  await sleep(1200);
  await js(`window.termcraft.setLayout('tile-v')`);
  await sleep(600);
  await shot('03-tiled');
  await js(`window.termcraft.setLayout('tabs')`);

  // Session editor.
  await js(`void window.termcraft.sm.newSession('')`);
  await sleep(500);
  await shot('04-session-editor');
  await js(`document.querySelector('.cat[data-cat="Port Forwarding"]').click()`);
  await sleep(300);
  await shot('05-port-forwarding');
  await js(`document.querySelector('.modal-footer button').click()`);
  await sleep(300);

  // Quick connect + global options.
  await js(`void window.termcraft.dispatch('quickConnect')`);
  await sleep(400);
  await shot('06-quick-connect');
  await js(`document.querySelector('.modal-footer button').click()`);
  await js(`void window.termcraft.dispatch('globalOptions')`);
  await sleep(400);
  await js(`document.querySelector('.cat[data-cat="Keyword Highlighting"]').click()`);
  await sleep(300);
  await shot('07-global-options');
  await js(`document.querySelector('.modal-footer button').click()`);

  // Light theme.
  await js(`window.termcraft.saveSettings({ theme: 'light', showCommandWindow: true })`);
  await sleep(600);
  await shot('08-light-theme');
  await js(`window.termcraft.saveSettings({ theme: 'dark', showCommandWindow: false })`);
  await sleep(300);
};
