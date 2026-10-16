// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Layout smoke test: sidebar collapse rail, stacked/side-by-side layouts, maximize terminal area.
// Run: TERMCRAFT_SMOKE=test/smoke/layout-smoke.js TERMCRAFT_SHOTS=/tmp/shots npx electron . --user-data-dir=/tmp/termcraft-smoke
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => {
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
    console.log('[smoke] shot', name);
  };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  win.setSize(1280, 800);
  await sleep(1000);

  for (let i = 0; i < 3; i++) {
    await js(`window.termcraft.dispatch('localShell')`);
    await sleep(700);
    await js(`window.termcraft.active.send("echo session ${i + 1}\\r")`);
  }
  await sleep(500);

  // Make sure the sidebar starts visible, then collapse it with the « button.
  if (!await js(`window.termcraft.settings.showSessionManager`)) await js(`window.termcraft.dispatch('toggleSessionManager')`);
  await sleep(300);
  const widthOpen = await js(`document.querySelector('.workspace').offsetWidth`);
  await js(`document.querySelector('.sm-collapse').click()`);
  await sleep(500);
  check('sidebar hidden after « click', await js(`document.querySelector('.session-manager').hidden`));
  check('rail visible', await js(`!document.querySelector('.sm-rail').hidden`));
  const widthCollapsed = await js(`document.querySelector('.workspace').offsetWidth`);
  // Relative check: CI machines can have screens smaller than the requested window.
  check(`workspace widened (${widthOpen}px → ${widthCollapsed}px)`, widthCollapsed > widthOpen + 150);

  // Stacked layout via the toolbar switch.
  await js(`document.querySelector('.segmented [data-layout="tile-h"]').click()`);
  await sleep(700);
  const rects = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.pane')].map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height), Math.round(r.width)]; }))`));
  check(`3 panes stacked vertically ${JSON.stringify(rects)}`, rects.length === 3 && rects[0][0] < rects[1][0] && rects[1][0] < rects[2][0] && rects.every((r) => r[1] > 100));
  const rows = await js(`window.termcraft.tabs.map((t) => t.term.rows).join(',')`);
  check(`each terminal resized to its pane (rows: ${rows})`, rows.split(',').every((r) => Number(r) < 25));
  await shot('01-stacked-collapsed-sidebar');

  // Maximize terminal area hides every panel.
  await js(`window.termcraft.dispatch('focusMode')`);
  await sleep(600);
  check('toolbar hidden in focus mode', await js(`getComputedStyle(document.querySelector('.toolbar')).display === 'none'`));
  await shot('02-maximized-stacked');
  await js(`document.querySelector('.exit-focus').click()`);
  await sleep(400);
  check('toolbar restored', await js(`getComputedStyle(document.querySelector('.toolbar')).display !== 'none'`));

  // Side by side, then back to tabs; re-open the sidebar from the rail.
  await js(`document.querySelector('.segmented [data-layout="tile-v"]').click()`);
  await sleep(500);
  await shot('03-side-by-side');
  await js(`document.querySelector('.segmented [data-layout="tabs"]').click()`);
  await js(`document.querySelector('.sm-rail').click()`);
  await sleep(500);
  check('sidebar restored from rail', await js(`!document.querySelector('.session-manager').hidden`));
  check('tabs layout restored', await js(`document.querySelector('.workspace').classList.contains('layout-tabs')`));
  await shot('04-tabs-sidebar');
};
