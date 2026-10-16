// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const crypto = require('crypto');
const os = require('os');
const path = require('path');

/**
 * Expand backslash escape sequences used in button bar strings,
 * logon actions and the command window: \r \n \t \e \b \\ \xHH \p (1s pause marker kept literal).
 */
function expandEscapes(str) {
  if (!str) return '';
  return str.replace(/\\(x[0-9a-fA-F]{2}|[rntebav\\0])/g, (m, c) => {
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { r: '\r', n: '\n', t: '\t', e: '\x1b', b: '\b', a: '\x07', v: '\v', '\\': '\\', 0: '\0' }[c];
  });
}

// CSI, OSC, DCS/SOS/PM/APC, and single-character escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * Substitute log-file name tokens:
 *  %H host  %S session name  %Y year  %M month  %D day  %h hour  %m minute  %s second  %t millis  %P port  %U user  %% percent
 */
function expandLogPath(template, session, now = new Date()) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_');
  let p = template.replace(/%([HSYMDhmstPU%])/g, (m, c) => {
    switch (c) {
      case 'H': return safe(session.host || session.serial?.path || 'local');
      case 'S': return safe(session.name || 'session');
      case 'Y': return String(now.getFullYear());
      case 'M': return pad(now.getMonth() + 1);
      case 'D': return pad(now.getDate());
      case 'h': return pad(now.getHours());
      case 'm': return pad(now.getMinutes());
      case 's': return pad(now.getSeconds());
      case 't': return pad(now.getMilliseconds(), 3);
      case 'P': return String(session.port || '');
      case 'U': return safe(session.username || '');
      case '%': return '%';
    }
    return m;
  });
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

function timestamp(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/** Parse the key type and SHA256 fingerprint of a raw SSH public key blob. */
function hostKeyInfo(keyBuf) {
  let type = 'unknown';
  try {
    const len = keyBuf.readUInt32BE(0);
    type = keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch { /* malformed key: keep unknown */ }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  const md5 = crypto.createHash('md5').update(keyBuf).digest('hex').match(/../g).join(':');
  return { type, fingerprint, md5 };
}

function newId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

const DEFAULT_PORTS = { ssh2: 22, telnet: 23, rlogin: 513, raw: 23, vnc: 5900, rdp: 3389 };

/**
 * Parse a quick-connect string: [protocol://][user@]host[:port]
 * e.g. "admin@10.0.0.1:2222", "telnet://router", "ssh://me@box".
 */
function parseConnectString(str) {
  const m = /^(?:(ssh2?|telnet|rlogin|raw|vnc|rdp):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/i.exec(str.trim());
  if (!m) return null;
  let protocol = (m[1] || 'ssh2').toLowerCase();
  if (protocol === 'ssh') protocol = 'ssh2';
  const host = m[3].replace(/^\[|\]$/g, '');
  return {
    protocol,
    username: m[2] || '',
    host,
    port: m[4] ? Number(m[4]) : DEFAULT_PORTS[protocol],
  };
}

module.exports = { expandEscapes, stripAnsi, expandLogPath, timestamp, hostKeyInfo, newId, parseConnectString, DEFAULT_PORTS, ANSI_RE };
