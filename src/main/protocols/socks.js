// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Minimal SOCKS4/4a/5 (CONNECT only, no auth) request parser used for
 * dynamic port forwarding. Returns null while more bytes are needed.
 */

/** Parse a SOCKS5 greeting. Returns { consumed } or null if incomplete. */
function parseSocks5Greeting(buf) {
  if (buf.length < 2) return null;
  const n = buf[1];
  if (buf.length < 2 + n) return null;
  const methods = [...buf.subarray(2, 2 + n)];
  return { consumed: 2 + n, noAuth: methods.includes(0) };
}

/** Parse a SOCKS5 request. Returns { host, port, cmd, consumed } or null if incomplete. */
function parseSocks5Request(buf) {
  if (buf.length < 4) return null;
  const cmd = buf[1];
  const atyp = buf[3];
  let host, off;
  if (atyp === 1) {
    if (buf.length < 10) return null;
    host = [...buf.subarray(4, 8)].join('.');
    off = 8;
  } else if (atyp === 3) {
    if (buf.length < 5) return null;
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    host = buf.subarray(5, 5 + len).toString('ascii');
    off = 5 + len;
  } else if (atyp === 4) {
    if (buf.length < 22) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
    host = parts.join(':');
    off = 20;
  } else {
    throw new Error('Unsupported SOCKS5 address type ' + atyp);
  }
  return { cmd, host, port: buf.readUInt16BE(off), consumed: off + 2 };
}

/** Parse a SOCKS4/4a CONNECT request. */
function parseSocks4Request(buf) {
  if (buf.length < 9) return null;
  const cmd = buf[1];
  const port = buf.readUInt16BE(2);
  const ip = [...buf.subarray(4, 8)];
  const userEnd = buf.indexOf(0, 8);
  if (userEnd < 0) return null;
  let host = ip.join('.');
  let consumed = userEnd + 1;
  if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
    const hostEnd = buf.indexOf(0, consumed);
    if (hostEnd < 0) return null;
    host = buf.subarray(consumed, hostEnd).toString('ascii');
    consumed = hostEnd + 1;
  }
  return { cmd, host, port, consumed };
}

const SOCKS5_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS5_FAIL = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS4_OK = Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]);
const SOCKS4_FAIL = Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]);

/**
 * Drive a SOCKS handshake on a socket. Calls connect(host, port, cb(err, stream))
 * and pipes the socket to the returned stream on success.
 */
function handleSocksConnection(socket, connect, onError = () => {}) {
  let buf = Buffer.alloc(0);
  let stage = 'init';
  let version = 0;

  const fail = (reply, err) => {
    try { socket.end(reply); } catch { /* socket already gone */ }
    if (err) onError(err);
  };

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      if (stage === 'init') {
        version = buf[0];
        if (version === 4) stage = 'req4';
        else if (version === 5) stage = 'greet5';
        else return fail(null, new Error('Not a SOCKS request'));
      }
      if (stage === 'greet5') {
        const g = parseSocks5Greeting(buf);
        if (!g) return;
        buf = buf.subarray(g.consumed);
        if (!g.noAuth) return fail(Buffer.from([5, 0xff]));
        socket.write(Buffer.from([5, 0]));
        stage = 'req5';
      }
      const req = stage === 'req5' ? parseSocks5Request(buf) : stage === 'req4' ? parseSocks4Request(buf) : null;
      if (!req) return;
      buf = buf.subarray(req.consumed);
      socket.removeListener('data', onData);
      socket.pause();
      if (req.cmd !== 1) return fail(version === 5 ? Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]) : SOCKS4_FAIL);
      stage = 'connecting';
      connect(req.host, req.port, (err, stream) => {
        if (err) return fail(version === 5 ? SOCKS5_FAIL : SOCKS4_FAIL, err);
        socket.write(version === 5 ? SOCKS5_OK : SOCKS4_OK);
        if (buf.length) stream.write(buf);
        socket.pipe(stream).pipe(socket);
        socket.resume();
        const done = () => { socket.destroy(); stream.destroy?.(); };
        socket.on('error', done);
        stream.on('error', done);
        stream.on('close', done);
      });
    } catch (err) {
      fail(null, err);
    }
  };
  socket.on('data', onData);
  socket.on('error', () => {});
}

module.exports = { parseSocks5Greeting, parseSocks5Request, parseSocks4Request, handleSocksConnection };
