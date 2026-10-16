// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TftpServer, resolveInRoot } = require('../src/main/tftp-server');

/** Minimal TFTP client (what a router does for "copy tftp: flash:"). */
function client(port, op, name, { data, options = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const parts = [name, 'octet', ...Object.entries(options).flat()].join('\0') + '\0';
    const req = Buffer.alloc(2 + Buffer.byteLength(parts));
    req.writeUInt16BE(op === 'get' ? 1 : 2, 0);
    req.write(parts, 2, 'latin1');
    let blksize = 512;
    const chunks = [];
    let sent = 0;
    let oack = null;
    const timer = setTimeout(() => { sock.close(); reject(new Error('client timeout')); }, 15000);
    const done = (v) => { clearTimeout(timer); sock.close(); resolve(v); };
    const ack = (n, r) => { const b = Buffer.alloc(4); b.writeUInt16BE(4, 0); b.writeUInt16BE(n & 0xffff, 2); sock.send(b, r.port, r.address); };
    const sendData = (n, r) => {
      const chunk = data.subarray((n - 1) * blksize, n * blksize);
      const b = Buffer.concat([Buffer.from([0, 3, (n >> 8) & 0xff, n & 0xff]), chunk]);
      sent = n;
      sock.send(b, r.port, r.address);
      return chunk.length;
    };
    let lastLen = -1;
    sock.on('message', (msg, r) => {
      const code = msg.readUInt16BE(0);
      if (code === 5) return done({ error: msg.readUInt16BE(2), message: msg.subarray(4).toString().replace(/\0$/, '') });
      if (code === 6) {
        oack = Object.fromEntries(msg.subarray(2).toString('latin1').split('\0').filter(Boolean).reduce((a, x, i, arr) => (i % 2 ? a : [...a, [x, arr[i + 1]]]), []));
        if (oack.blksize) blksize = Number(oack.blksize);
        if (op === 'get') ack(0, r); else lastLen = sendData(1, r);
        return;
      }
      if (op === 'get' && code === 3) {
        const n = msg.readUInt16BE(2);
        chunks.push(msg.subarray(4));
        ack(n, r);
        if (msg.length - 4 < blksize) done({ data: Buffer.concat(chunks), oack });
      } else if (op === 'put' && code === 4) {
        const n = msg.readUInt16BE(2);
        if (n !== (sent & 0xffff)) return;
        if (sent > 0 && lastLen < blksize) return done({ ok: true, oack });
        lastLen = sendData(sent + 1, r);
      }
    });
    sock.send(req, port, '127.0.0.1');
  });
}

async function withServer(opts, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tftp-'));
  const srv = new TftpServer({ root, port: 0, host: '127.0.0.1', ...opts });
  const log = [];
  srv.on('log', (m) => log.push(m));
  const { port } = await srv.start();
  try { await fn({ root, port, log }); } finally { srv.stop(); }
}

test('tftp: download with and without blksize/tsize options, including exact-multiple sizes', async () => {
  await withServer({}, async ({ root, port }) => {
    const image = crypto.randomBytes(512 * 40); // exact multiple of 512: needs a final empty block
    fs.writeFileSync(path.join(root, 'ios.bin'), image);
    const plain = await client(port, 'get', 'ios.bin');
    assert.ok(plain.data.equals(image));
    const fast = await client(port, 'get', 'ios.bin', { options: { blksize: '1428', tsize: '0' } });
    assert.ok(fast.data.equals(image));
    assert.deepStrictEqual(fast.oack, { blksize: '1428', tsize: String(image.length) });
  });
});

test('tftp: uploads are off by default, then work, and never overwrite unless allowed', async () => {
  await withServer({}, async ({ port }) => {
    const r = await client(port, 'put', 'sw1.cfg', { data: Buffer.from('hostname sw1\n') });
    assert.strictEqual(r.error, 2);
  });
  await withServer({ allowWrite: true }, async ({ root, port }) => {
    const cfg = crypto.randomBytes(3000);
    assert.ok((await client(port, 'put', 'backups/sw1.cfg', { data: cfg, options: { blksize: '1024' } })).ok);
    assert.ok(fs.readFileSync(path.join(root, 'backups', 'sw1.cfg')).equals(cfg));
    const again = await client(port, 'put', 'backups/sw1.cfg', { data: Buffer.from('x') });
    assert.strictEqual(again.error, 6, 'existing file is not overwritten');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'backups')), ['sw1.cfg'], 'no partial files left');
  });
});

test('tftp: requests outside the TFTP folder are refused', async () => {
  await withServer({ allowWrite: true }, async ({ port, log }) => {
    for (const name of ['../secret', 'a/../../x', 'C:\\Windows\\win.ini', '..\\x']) {
      const r = await client(port, 'get', name);
      assert.strictEqual(r.error, 2, name);
    }
    // A leading "/" means the TFTP folder (as with tftpd -s), never the real root.
    assert.strictEqual((await client(port, 'get', '/etc/passwd')).error, 1);
    assert.strictEqual((await client(port, 'put', '../evil', { data: Buffer.from('x') })).error, 2);
    assert.ok(log.some((l) => /outside the TFTP folder/.test(l)));
    assert.strictEqual((await client(port, 'get', 'missing.bin')).error, 1);
  });
  assert.strictEqual(resolveInRoot('/srv/tftp', 'ok/file.bin'), path.resolve('/srv/tftp/ok/file.bin'));
});
