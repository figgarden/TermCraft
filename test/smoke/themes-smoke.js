// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Themes end-to-end: the Global Options picker recolors the app and theme-following terminals.
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win, { store }) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const cssVar = (name) => js(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  const termBg = (i) => js(`window.termcraft.tabs[${i}].term.options.theme.background`);
  win.setSize(1440, 900);
  await sleep(800);

  // One terminal following the theme, one pinned to Monokai.
  await js(`void window.termcraft.openSession({ name: 'follows theme', protocol: 'local', local: { shell: '/bin/sh' } })`);
  await sleep(800);
  await js(`void window.termcraft.openSession({ name: 'pinned Monokai', protocol: 'local', local: { shell: '/bin/sh' }, terminal: { colorScheme: 'Monokai' } })`);
  await sleep(800);
  check('default theme is TermCraft Dark', (await js(`window.termcraft.theme.name`)) === 'TermCraft Dark');

  await js(`void window.termcraft.dispatch('globalOptions')`);
  await sleep(500);
  const cards = await js(`document.querySelectorAll('.theme-card').length`);
  check(`theme picker shows all themes (${cards} cards)`, cards >= 27);
  await js(`[...document.querySelectorAll('.theme-card')].find((c) => c.title === 'Catppuccin Mocha').click()`);
  await sleep(400);
  check('clicking a card previews it live', (await cssVar('--bg-2')) === '#1e1e2e' && (await termBg(0)) === '#1e1e2e');
  check('a pinned session keeps its own scheme', (await termBg(1)) === '#272822');
  fs.writeFileSync(path.join(out, 'themes.png'), (await win.webContents.capturePage()).resize({ width: 1600, quality: 'best' }).toPNG());

  // Cancel reverts the preview.
  await js(`[...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === 'Cancel').click()`);
  await sleep(300);
  check('Cancel reverts the preview', (await js(`window.termcraft.theme.name`)) === 'TermCraft Dark' && (await termBg(0)) === '#1b1d23');

  // Choose Nord and save.
  await js(`void window.termcraft.dispatch('globalOptions')`);
  await sleep(400);
  await js(`[...document.querySelectorAll('.theme-card')].find((c) => c.title === 'Nord').click()`);
  await js(`document.querySelector('.modal-footer .primary').click()`);
  await sleep(500);
  check('OK saves the theme', store.getSettings().theme === 'Nord' && (await cssVar('--accent')) === '#88c0d0' && (await termBg(0)) === '#2e3440');
  check('light themes switch the UI to light mode', await js(`(window.termcraft.applyTheme('Gruvbox Light'), document.documentElement.dataset.theme === 'light')`));
  await js(`window.termcraft.applyTheme()`);
  check('new terminals pick up the theme', await js(`(async () => { await window.termcraft.openSession({ name: 'new', protocol: 'local', local: { shell: '/bin/sh' } }); return window.termcraft.active.term.options.theme.background === '#2e3440'; })()`));
};
