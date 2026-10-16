// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Command Buffer: command mode (Enter sends) and script mode (line stepping, Send All that waits for
// the prompt between lines, Stop), below or beside the terminal.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(win, { store }) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (process.platform === 'win32') { console.log('[smoke] PASS skipped on Windows (uses /bin/sh)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-buffer-'));
  const log = path.join(dir, 'log.txt');
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  win.setSize(1400, 880);
  await sleep(900);
  await js(`void window.termcraft.openSession({ name: 'device', protocol: 'local', local: { shell: '/bin/sh', args: '' } })`);
  await sleep(1200);
  await js(`window.termcraft.active.send("PS1='dev# '\\r")`);
  await sleep(300);

  // Command mode (default): a strip below the terminal.
  await js(`window.termcraft.dispatch('toggleCommandWindow')`);
  await sleep(400);
  const box = () => js(`(() => { const b = document.querySelector('.command-buffer').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.top) }; })()`).then(JSON.parse);
  let b = await box();
  check('Command Buffer opens below the terminal, about 7% high', b.h >= 56 && b.h <= 0.12 * 880 + 60 && b.y > 500);
  await js(`(() => { const e = document.querySelector('.cb-editor'); e.focus(); e.value = 'echo one >> ${log}'; e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  check('Enter sends the command and clears the buffer', lines().join() === 'one' && (await js(`document.querySelector('.cb-editor').value`)) === '');
  await js(`(() => { const e = document.querySelector('.cb-editor'); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); })()`);
  check('↑ recalls the previous command', (await js(`document.querySelector('.cb-editor').value`)) === `echo one >> ${log}`);

  // Script mode: moves beside the terminal (half and half) with line numbers.
  await js(`[...document.querySelectorAll('.cb-seg button')].find((x) => x.dataset.v === 'script').click()`);
  await sleep(500);
  b = await box();
  check('Script mode sits beside the terminal, about half the width', b.w > 400 && b.w < 1000 && (await js(`!!document.querySelector('.cb-side .cb-gutter div')`)));
  const termWidth = await js(`document.querySelector('.workspace').getBoundingClientRect().width`);
  check('the terminal shrinks to share the window', termWidth < 1100);
  const script = [`echo two >> ${log}`, `sleep 1; echo three >> ${log}`, `echo four >> ${log}`, `echo five >> ${log}`].join('\n');
  await js(`(() => { const e = document.querySelector('.cb-editor'); e.value = ${JSON.stringify(script)}; e.dispatchEvent(new Event('input')); e.focus(); e.setSelectionRange(0, 0); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); })()`);
  await sleep(600);
  check('⌘/Ctrl+Enter sends the current line', lines().join() === 'one,two');
  check('…and moves the cursor to the next line', (await js(`document.querySelector('.cb-editor').selectionStart`)) === script.indexOf('\n') + 1);
  // Send the rest: the slow line must finish before the next one is sent.
  await js(`(() => { const e = document.querySelector('.cb-editor'); e.setSelectionRange(script.indexOf('sleep'), script.length); })()`.replace('script.indexOf', `${JSON.stringify(script)}.indexOf`).replace('script.length', String(script.length)));
  await js(`document.querySelector('.cb-actions .small[title^="Send the selected"]').click()`);
  for (let i = 0; i < 60 && lines().length < 5; i++) await sleep(100);
  await sleep(300);
  check('Send Selection waits for the prompt, so lines run in order', lines().join() === 'one,two,three,four,five');
  // Stop in the middle of a long script.
  await js(`(() => { const e = document.querySelector('.cb-editor'); e.value = ${JSON.stringify(Array.from({ length: 8 }, (_, i) => `sleep 1; echo s${i} >> ${log}`).join('\n'))}; e.dispatchEvent(new Event('input')); })()`);
  await js(`document.querySelector('.cb-actions .primary').click()`);
  await sleep(1600);
  await js(`document.querySelector('.cb-actions .danger').click()`);
  await sleep(2500);
  const stopped = lines().filter((l) => l.startsWith('s')).length;
  check('Stop halts the script part-way', stopped >= 1 && stopped < 8 && (await js(`document.querySelector('.cb-actions .danger').hidden`)));

  // Position switch and persistence.
  await js(`[...document.querySelectorAll('.cb-seg button')].find((x) => x.dataset.v === 'bottom').click()`);
  await sleep(500);
  b = await box();
  check('the script buffer can also sit below the terminal', b.y > 400 && b.w > 1000);
  await sleep(1000);
  check('the buffer text is saved', /sleep 1; echo s7/.test(store.getSettings().bufferText) && store.getSettings().bufferMode === 'script');
  fs.rmSync(dir, { recursive: true, force: true });
};
