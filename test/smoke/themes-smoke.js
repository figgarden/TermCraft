// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Appearance end-to-end: theme family + Light/Dark/Auto, terminal colors and typography, previewed live,
// reverted by Cancel and saved by OK.
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
  const click = (sel, text) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`);
  const openAppearance = async () => {
    await js(`void window.termcraft.dispatch('globalOptions')`);
    await sleep(400);
    await js(`document.querySelector('.cat[data-cat="Appearance"]').click()`);
    await sleep(300);
  };
  win.setSize(1440, 900);
  await sleep(800);
  await js(`window.termcraft.saveSettings({ appearance: 'dark', lightTheme: 'TermCraft Light', darkTheme: 'TermCraft Dark' })`);

  // One terminal following the theme, one pinned to Monokai.
  await js(`void window.termcraft.openSession({ name: 'follows theme', protocol: 'local', local: { shell: '${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}' } })`);
  await js(`void window.termcraft.openSession({ name: 'pinned', protocol: 'local', local: { shell: '${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}' }, terminal: { colorScheme: 'Monokai' } })`);
  await sleep(1200);
  check('starts on TermCraft Dark', (await js(`window.termcraft.theme.name`)) === 'TermCraft Dark');

  await openAppearance();
  check('one family card per theme family (13)', (await js(`document.querySelectorAll('.ap-family').length`)) === 13);
  check('the live preview is shown', !!(await js(`!!document.querySelector('.ap-window .ap-term')`)));
  await click('.ap-family', 'Catppuccin');
  await sleep(300);
  check('picking a family previews it everywhere (Mocha in dark mode)', (await js(`window.termcraft.theme.name`)) === 'Catppuccin Mocha' && (await termBg(0)) === '#1e1e2e');
  check('a session with its own palette keeps it', (await termBg(1)) === '#272822');
  check('families with several dark variants offer them', (await js(`[...document.querySelectorAll('.ap-variants button')].map((b) => b.textContent).join(',')`)) === 'Frappé,Macchiato,Mocha');
  await click('.ap-variants button', 'Macchiato');
  await sleep(200);
  check('a variant can be chosen', (await js(`window.termcraft.theme.name`)) === 'Catppuccin Macchiato');
  await click('.ap-mode button', 'Light');
  await sleep(300);
  check('Light mode shows the family’s light variant', (await js(`window.termcraft.theme.name`)) === 'Catppuccin Latte' && (await js(`document.documentElement.dataset.theme`)) === 'light');
  fs.writeFileSync(path.join(out, 'themes.png'), (await win.webContents.capturePage()).resize({ width: 1600, quality: 'best' }).toPNG());
  await click('.ap-family', 'Nord');
  await sleep(300);
  check('a dark-only family switches to Dark and says why', (await js(`window.termcraft.theme.name`)) === 'Nord' && /only comes in dark/.test(await js(`document.querySelector('.ap-note').textContent`)));
  await js(`document.querySelector('.modal-footer button').click()`); // Cancel
  await sleep(300);
  check('Cancel reverts everything', (await js(`window.termcraft.theme.name`)) === 'TermCraft Dark' && (await termBg(0)) === '#1b1d23');

  // Choose Gruvbox, Auto, a different terminal palette and relaxed spacing, then OK.
  await openAppearance();
  await click('.ap-family', 'Gruvbox');
  await click('.ap-mode button', 'Auto');
  await js(`(() => { const s = document.querySelector('[aria-label="Terminal colors"]'); s.value = 'Dracula'; s.dispatchEvent(new Event('change')); })()`);
  await click('.ap .segmented button', 'Relaxed');
  await sleep(300);
  check('terminal colors can differ from the window', (await termBg(0)) === '#282a36' && (await cssVar('--accent')) !== '');
  check('line spacing previews live', (await js(`window.termcraft.tabs[0].term.options.lineHeight`)) === 1.3);
  await js(`document.querySelector('.modal-footer .primary').click()`);
  await sleep(300);
  const s = store.getSettings();
  check('OK saves mode, both variants, colors and spacing', s.appearance === 'auto' && s.lightTheme === 'Gruvbox Light' && s.darkTheme === 'Gruvbox Dark'
    && s.defaultSession.terminal.colorScheme === 'Dracula' && String(s.lineHeight) === '1.3');
  const prefersDark = await js(`matchMedia('(prefers-color-scheme: dark)').matches`);
  check('Auto follows the system', (await js(`window.termcraft.theme.name`)) === (prefersDark ? 'Gruvbox Dark' : 'Gruvbox Light'));
  check('new terminals use the saved choices', await js(`(async () => { await window.termcraft.openSession({ name: 'new', protocol: 'local', local: { shell: '${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}' } }); const o = window.termcraft.active.term.options; return o.theme.background === '#282a36' && o.lineHeight === 1.3; })()`));
  check('the bundled font is used', (await js(`document.fonts.check('14px "JetBrains Mono"')`)) === true && /JetBrains Mono/.test(await js(`window.termcraft.active.term.options.fontFamily`)));
  check('the active tab blends into its terminal', (await js(`getComputedStyle(document.querySelector('.tab.active')).backgroundColor`)) === 'rgb(40, 42, 54)');
};
