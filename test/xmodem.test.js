// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const xmodem = require('../src/main/xmodem');

/** Two connected ends of a serial line; `corrupt` flips a byte in the Nth packet sent by A. */
function line({ corruptPacket = -1 } = {}) {
  const mk = () => ({ subs: new Set(), onData(cb) { this.subs.add(cb); return () => this.subs.delete(cb); } });
  const a = mk(); const b = mk();
  let n = 0;
  a.write = (buf) => { buf = Buffer.from(buf); if (buf.length > 100 && n++ === corruptPacket) buf[50] ^= 0xff; setImmediate(() => b.subs.forEach((cb) => cb(buf))); };
  b.write = (buf) => { buf = Buffer.from(buf); setImmediate(() => a.subs.forEach((cb) => cb(buf))); };
  return { a, b };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-xm-'));

test('xmodem: CRC-16/XMODEM check value', () => {
  assert.strictEqual(xmodem.crc16(Buffer.from('123456789')), 0x31c3);
});

for (const protocol of ['xmodem', 'xmodem-1k']) {
  test(`${protocol}: send and receive survive a corrupted block`, { timeout: 30000 }, async () => {
    const dir = tmp();
    const src = path.join(dir, 'c2960-lanbase.bin');
    const data = crypto.randomBytes(5000);
    fs.writeFileSync(src, data);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const { a, b } = line({ corruptPacket: 2 });
    const [, files] = await Promise.all([
      xmodem.send(a, [src], { protocol }),
      xmodem.receive(b, out, { protocol, name: 'image.bin' }),
    ]);
    assert.ok(fs.readFileSync(files[0]).equals(data));
  });
}

test('ymodem: batch transfer keeps names and exact sizes, and never writes outside the folder', { timeout: 30000 }, async () => {
  const dir = tmp();
  const f1 = path.join(dir, 'boot.cfg');
  const f2 = path.join(dir, 'image.bin');
  fs.writeFileSync(f1, 'boot system flash:image.bin\n');
  fs.writeFileSync(f2, crypto.randomBytes(3000));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'boot.cfg'), 'existing');
  const { a, b } = line();
  const [, files] = await Promise.all([xmodem.send(a, [f1, f2], { protocol: 'ymodem' }), xmodem.receive(b, out, { protocol: 'ymodem' })]);
  assert.deepStrictEqual(files.map((f) => path.basename(f)), ['boot (1).cfg', 'image.bin']);
  assert.strictEqual(fs.readFileSync(path.join(out, 'boot.cfg'), 'utf8'), 'existing', 'existing file kept');
  assert.ok(fs.readFileSync(files[1]).equals(fs.readFileSync(f2)));
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['boot (1).cfg', 'boot.cfg', 'image.bin']);
});

test('ymodem: a malicious sender cannot choose a path', { timeout: 30000 }, async () => {
  const dir = tmp();
  const evil = path.join(dir, 'x');
  fs.writeFileSync(evil, 'pwned');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  // Rename on the sender side to a traversal name by sending a crafted header.
  const { a, b } = line();
  const recv = xmodem.receive(b, out, { protocol: 'ymodem' });
  const rd = []; a.onData((d) => rd.push(...d));
  const wait = async (byte) => { for (let i = 0; i < 500 && !rd.includes(byte); i++) await new Promise((r) => setTimeout(r, 5)); rd.length = 0; };
  await wait(0x43);
  a.write(xmodem.block(0, Buffer.from('../../evil.sh\x005 0\x00', 'latin1'), 128, true, 0));
  await wait(0x43);
  a.write(xmodem.block(1, Buffer.from('pwned'), 128, true));
  await wait(0x06);
  a.write(Buffer.from([0x04])); await wait(0x15); a.write(Buffer.from([0x04])); await wait(0x43);
  a.write(xmodem.block(0, Buffer.alloc(0), 128, true, 0));
  const files = await recv;
  assert.deepStrictEqual(files.map((f) => path.dirname(f)), [out]);
  assert.strictEqual(path.basename(files[0]), 'evil.sh');
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.sh')));
});

test('xmodem: cancel stops both sides', { timeout: 30000 }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'big.bin');
  fs.writeFileSync(src, crypto.randomBytes(200000));
  const { a, b } = line();
  const signal = {};
  const onProgress = (p) => { if (p.bytes > 20000 && !signal.cancelled) { signal.cancelled = true; signal.onCancel?.(); } };
  const sending = xmodem.send(a, [src], { protocol: 'xmodem-1k', signal, onProgress });
  const receiving = xmodem.receive(b, dir, { protocol: 'xmodem', name: 'got.bin' });
  await assert.rejects(sending, /Cancelled/);
  await assert.rejects(receiving, /Cancelled by the sender/);
  assert.ok(!fs.existsSync(path.join(dir, 'got.bin')) && !fs.existsSync(path.join(dir, 'got.bin.part')));
});
