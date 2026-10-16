// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Bulk host import: a CSV with a header row, or a plain list of hosts (one per line, optionally
 * "name host" or "name,host"). Typical source: an inventory/IPAM export or a spreadsheet of devices.
 */

const PROTOCOL_ALIASES = { ssh: 'ssh2', ssh2: 'ssh2', telnet: 'telnet', rlogin: 'rlogin', raw: 'raw', serial: 'serial', vnc: 'vnc', rdp: 'rdp' };
const DEFAULT_PORTS = { ssh2: 22, telnet: 23, rlogin: 513, raw: 23, vnc: 5900, rdp: 3389 };
// Header names people actually use in inventory exports, mapped to session fields.
const HEADER_ALIASES = {
  name: ['name', 'session', 'label', 'device', 'devicename', 'device name'],
  host: ['host', 'address', 'ip', 'ipaddress', 'ip address', 'mgmt ip', 'management ip', 'fqdn'],
  port: ['port'],
  protocol: ['protocol', 'proto', 'type'],
  username: ['username', 'user', 'login'],
  folder: ['folder', 'group', 'site', 'location', 'path'],
  credential: ['credential', 'credentials', 'cred'],
  jump: ['jump', 'jumphost', 'jump host', 'bastion', 'proxyjump', 'via'],
  notes: ['notes', 'description', 'comment', 'comments', 'model', 'role'],
};
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9_.:-]+)$/i;

/** Split one CSV line (RFC 4180 quotes, comma / semicolon / tab separated). */
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function detectSeparator(line) {
  const counts = [',', ';', '\t'].map((c) => [c, splitCsvLine(line, c).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : null;
}

/** Map header cells to field names; returns null when the first row isn't a header. */
function mapHeader(cells) {
  const map = {};
  const keys = cells.map((c) => c.toLowerCase().replace(/[_-]+/g, ' ').trim());
  keys.forEach((key, i) => {
    const field = Object.keys(HEADER_ALIASES).find((f) => HEADER_ALIASES[f].includes(key) && !(f in map));
    if (field) map[field] = i;
  });
  // "hostname" is the address in some exports and the device name in others.
  const hn = keys.indexOf('hostname');
  if (hn >= 0) { if (!('host' in map)) map.host = hn; else if (!('name' in map)) map.name = hn; }
  return 'host' in map ? map : null;
}

/**
 * Parse hosts text into rows. Never throws on bad lines; they come back in `errors`.
 * @returns {{ rows: Array<{name, host, port, protocol, username, folder, credential, jump, notes}>, errors: string[] }}
 */
function parseHosts(text, defaults = {}) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  const errors = [];
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (first < 0) return { rows, errors };
  const sep = detectSeparator(lines[first]);
  const header = sep ? mapHeader(splitCsvLine(lines[first], sep)) : null;
  const defProto = PROTOCOL_ALIASES[String(defaults.protocol || 'ssh2').toLowerCase()] || 'ssh2';

  for (let i = header ? first + 1 : first; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let r = {};
    if (header) {
      const cells = splitCsvLine(line, sep);
      for (const [field, idx] of Object.entries(header)) r[field] = cells[idx] ?? '';
    } else {
      const cells = sep ? splitCsvLine(line, sep) : line.split(/\s+/);
      if (cells.length >= 2) { r.name = cells[0]; r.host = cells[1]; } else r.host = cells[0];
    }
    // Accept user@host:port in the host column.
    const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(String(r.host || '').trim());
    if (!m || !HOST_RE.test(m[2])) { errors.push(`Line ${i + 1}: "${line.slice(0, 60)}" has no valid host`); continue; }
    const protocol = PROTOCOL_ALIASES[String(r.protocol || '').toLowerCase()] || defProto;
    const port = Number(m[3] || r.port) || Number(defaults.port) || DEFAULT_PORTS[protocol] || 22;
    if (!(port > 0 && port < 65536)) { errors.push(`Line ${i + 1}: invalid port`); continue; }
    rows.push({
      name: String(r.name || m[2]).trim().slice(0, 200),
      host: m[2].replace(/^\[|\]$/g, ''),
      port,
      protocol,
      username: String(m[1] || r.username || defaults.username || '').trim(),
      folder: String(r.folder || '').trim().replace(/\\/g, '/'),
      credential: String(r.credential || '').trim(),
      jump: String(r.jump || '').trim(),
      notes: String(r.notes || '').trim(),
    });
  }
  return { rows, errors };
}

module.exports = { parseHosts, splitCsvLine };
