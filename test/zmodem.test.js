// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const zmodem = require('../src/main/zmodem');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-zm-'));
const HAVE_LRZSZ = spawnSync('sz', ['--version'], { encoding: 'utf8' }).status === 0;

/** Connected pair; `corrupt` flips a byte in the listed writes of side A. */
function line({ corrupt = [] } = {}) {
  const mk = () => ({ subs: new Set(), onData(cb) { this.subs.add(cb); return () => this.subs.delete(cb); } });
  const a = mk(); const b = mk();
  let n = 0;
  a.write = (buf) => { buf = Buffer.from(buf); if (corrupt.includes(n++) && buf.length > 300) buf[200] ^= 0x55; setImmediate(() => b.subs.forEach((cb) => cb(buf))); };
  b.write = (buf) => { buf = Buffer.from(buf); setImmediate(() => a.subs.forEach((cb) => cb(buf))); };
  return { a, b };
}

function lrzsz(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  return {
    io: { write: (b) => p.stdin.write(b), onData: (cb) => { p.stdout.on('data', cb); return () => p.stdout.off('data', cb); } },
    done: new Promise((r) => p.on('close', r)),
  };
}

function series(dir) {
  const files = [
    ['01-boot.cfg', Buffer.from('boot system image.bin\n')],
    ['02-image.bin', crypto.randomBytes(120000)],
    ['03-empty.txt', Buffer.alloc(0)],
    ['04-tricky.dat', Buffer.from([...Array(256).keys(), 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x2a, 0x2a, 0x0d, 0x11, 0x13, 0xff, 0x7f])],
  ];
  for (const [n, d] of files) fs.writeFileSync(path.join(dir, n), d);
  return files;
}
const same = (dir, files) => files.every(([n, d]) => fs.existsSync(path.join(dir, n)) && fs.readFileSync(path.join(dir, n)).equals(d));

test('zmodem: detects rz and sz starting in terminal output', () => {
  assert.deepStrictEqual(zmodem.detect(Buffer.from('rz waiting to receive.**\x18B0100000023be50\r\n')), { direction: 'send', at: 22 });
  assert.deepStrictEqual(zmodem.detect(Buffer.from('**\x18B00000000000000\r\n')), { direction: 'receive', at: 0 });
  assert.strictEqual(zmodem.detect(Buffer.from('** bold ** text B01')), null);
  assert.strictEqual(zmodem.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zmodem: a series of files survives corrupted packets (loopback)', { timeout: 60000 }, async () => {
  const dir = tmp();
  const files = series(dir);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const { a, b } = line({ corrupt: [6, 15, 30] });
  const [, saved] = await Promise.all([
    zmodem.send(a, files.map(([n]) => path.join(dir, n))),
    zmodem.receive(b, out),
  ]);
  assert.deepStrictEqual(saved.map((f) => path.basename(f)), files.map(([n]) => n), 'received in the order sent');
  assert.ok(same(out, files));
});

test('zmodem: received names cannot escape the folder or overwrite', { timeout: 60000 }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'authorized_keys');
  fs.writeFileSync(src, 'evil');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'authorized_keys'), 'mine');
  // A sender that claims a path: rename the file on the wire by sending from a symlink-free copy with a crafted name.
  const { a, b } = line();
  const orig = a.write;
  a.write = (buf) => orig(Buffer.from(Buffer.from(buf).toString('latin1').replace('authorized_keys\0', '../../.ssh/authorized_keys\0'), 'latin1'));
  const [, saved] = await Promise.all([zmodem.send(a, [src]).catch(() => {}), zmodem.receive(b, out).catch(() => [])]);
  for (const f of saved) assert.strictEqual(path.dirname(f), out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'authorized_keys'), 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(dir, '..', '.ssh', 'authorized_keys')) || fs.readFileSync(path.join(dir, '..', '.ssh', 'authorized_keys'), 'utf8') !== 'evil');
});

test('zmodem: works with the real rz and sz (lrzsz)', { skip: !HAVE_LRZSZ && 'lrzsz not installed', timeout: 60000 }, async () => {
  const dir = tmp();
  const files = series(dir);
  const paths = files.map(([n]) => path.join(dir, n));
  const rzDir = path.join(dir, 'rz');
  fs.mkdirSync(rzDir);
  let p = lrzsz('rz', ['-q'], rzDir);
  await zmodem.send(p.io, paths);
  assert.strictEqual(await p.done, 0);
  assert.ok(same(rzDir, files), 'rz received every file intact');
  const got = path.join(dir, 'got');
  fs.mkdirSync(got);
  p = lrzsz('sz', ['-q', '-e', ...paths], dir);
  const saved = await zmodem.receive(p.io, got);
  assert.strictEqual(await p.done, 0);
  assert.deepStrictEqual(saved.map((f) => path.basename(f)), files.map(([n]) => n));
  assert.ok(same(got, files), 'every file from sz intact');
});

test('ymodem and xmodem: work with the real rb/sb/rx (lrzsz)', { skip: !HAVE_LRZSZ && 'lrzsz not installed', timeout: 60000 }, async () => {
  const xmodem = require('../src/main/xmodem');
  const dir = tmp();
  const files = series(dir).filter(([, d]) => d.length);
  const paths = files.map(([n]) => path.join(dir, n));
  const rb = path.join(dir, 'rb');
  fs.mkdirSync(rb);
  let p = lrzsz('rz', ['--ymodem', '-q'], rb);
  await xmodem.send(p.io, paths, { protocol: 'ymodem' });
  assert.strictEqual(await p.done, 0);
  assert.ok(same(rb, files));
  const got = path.join(dir, 'got');
  fs.mkdirSync(got);
  p = lrzsz('sz', ['--ymodem', '-q', ...paths], dir);
  await xmodem.receive(p.io, got, { protocol: 'ymodem' });
  assert.strictEqual(await p.done, 0);
  assert.ok(same(got, files));
});
