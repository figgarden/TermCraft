// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Branding smoke test: welcome logo, About box, license viewer.
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('[smoke] shot', name); };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  win.setSize(1280, 800);
  await sleep(1200);
  check('welcome logo loaded', await js(`(() => { const i = document.querySelector('.welcome-logo'); return !!i && i.complete && i.naturalWidth > 0; })()`));
  await shot('01-welcome');
  await js(`void window.termcraft.dispatch('about')`);
  await sleep(500);
  const about = await js(`document.querySelector('.about')?.textContent || ''`);
  check('about shows GPL notice', /GNU General Public License/.test(about) && /ABSOLUTELY NO WARRANTY/.test(about));
  check('about box has no third-party trademark notices', !/trademark/i.test(about));
  await shot('02-about');
  await js(`[...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === 'View License').click()`);
  await sleep(500);
  check('license viewer shows GPLv2 text', /GNU GENERAL PUBLIC LICENSE[\s\S]*Version 2, June 1991/.test(await js(`document.querySelector('pre.license')?.textContent || ''`)));
};
