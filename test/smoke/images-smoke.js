// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Inline images: Kitty graphics protocol (PNG, raw RGB, chunked + zlib, query, delete), Sixel, and refusal
// of file-based transmission (the remote side must never make TermCraft read local files).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A w×h PNG filled with one color. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async function smoke(win) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  await sleep(1000);
  // A tab whose "remote side" is just the screen: write escape sequences straight into the terminal.
  await js(`void window.termcraft.openSession({ name: 'images', protocol: 'local', local: { shell: '${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}', args: '' } })`);
  await sleep(1200);
  await js(`(() => { const t = window.termcraft.active; window.__replies = []; t.term.onData((d) => window.__replies.push(d)); t.term.write('\\x1b[2J\\x1b[H'); })()`);
  const put = async (s) => { await js(`new Promise((r) => window.termcraft.active.write(${JSON.stringify(s)}) || setTimeout(r, 400))`); await sleep(400); };
  const usage = () => js(`window.termcraft.active.images?.storageUsage || 0`);

  check('image support is loaded', (await js(`!!window.termcraft.active.images`)) === true);
  // 1) Kitty: transmit + display a PNG directly, 4 columns x 2 rows.
  const red = png(64, 32, [220, 30, 30]).toString('base64');
  await put(`\x1b_Ga=T,f=100,i=7,c=4,r=2,q=2;${red}\x1b\\`);
  const u1 = await usage();
  check('Kitty PNG is drawn', u1 > 0);
  check('the image is in the cell where it was placed', (await js(`!!window.termcraft.active.images.getImageAtBufferCell(0, 0)`)) === true);
  // 2) Kitty: chunked, zlib-compressed raw RGB (how big images are sent).
  const rgb = zlib.deflateSync(Buffer.alloc(50 * 20 * 3, 0x40)).toString('base64');
  const parts = rgb.match(/.{1,96}/g);
  let seq = '';
  parts.forEach((p, i) => { seq += i === 0 ? `\x1b_Ga=T,f=24,s=50,v=20,o=z,i=8,q=2,m=${i < parts.length - 1 ? 1 : 0};${p}\x1b\\` : `\x1b_Gm=${i < parts.length - 1 ? 1 : 0};${p}\x1b\\`; });
  await put(`\r\n${seq}`);
  check('Kitty chunked + zlib RGB image is drawn', (await usage()) > u1);
  // 3) Kitty query: programs use this to detect support; TermCraft must answer OK.
  await js(`window.__replies.length = 0`);
  await put('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\');
  check('Kitty support query is answered OK', /\x1b_Gi=31;OK\x1b\\/.test(await js(`window.__replies.join('')`)));
  // 4) Security: file / temp-file / shared-memory transmission is refused.
  const secret = path.join(os.tmpdir(), `termcraft-secret-${Date.now()}.png`);
  fs.writeFileSync(secret, png(8, 8, [0, 0, 255]));
  await js(`window.__replies.length = 0`);
  const before = await usage();
  for (const [id, t] of [[41, 'f'], [42, 't'], [43, 's']]) await put(`\x1b_Ga=T,f=100,t=${t},i=${id};${Buffer.from(secret).toString('base64')}\x1b\\`);
  const replies = await js(`window.__replies.join('')`);
  check('file, temp-file and shared-memory transmission are refused', (replies.match(/EINVAL:unsupported transmission medium/g) || []).length === 3 && (await usage()) === before);
  check('a refused temp file is not deleted (TermCraft never touches local files)', fs.existsSync(secret));
  fs.rmSync(secret, { force: true });
  // 5) Kitty delete all.
  await put('\x1b_Ga=d,d=A,q=2\x1b\\');
  check('Kitty delete removes the images', (await usage()) === 0);
  // 6) Sixel: a 4-pixel-high red bar.
  await put('\x1bPq#0;2;100;0;0#0~~~~~~~~\x1b\\');
  check('Sixel image is drawn', (await usage()) > 0);
  // 7) Keyword highlighting never corrupts image data (base64 can contain words like "error").
  await js(`window.termcraft.saveSettings({ highlights: [{ pattern: 'AAAA', regex: false, caseSensitive: true, color: '#ff0000', bold: true, enabled: true }] })`);
  await put('\x1b_Ga=d,d=A,q=2\x1b\\');
  await put(`\x1b_Ga=T,f=100,i=9,q=2;${red}\x1b\\`);
  check('images still decode with keyword highlighting on', (await usage()) > 0);
};
