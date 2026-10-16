// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Keyword highlighting: injects SGR color codes around matches in the plain-text
// segments of incoming terminal data, never inside escape sequences.

// Matches a complete escape sequence or a lone ESC at the end of a chunk.
const ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]|\x1b$/g;

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hexToSgr(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '31';
  return `38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}`;
}

/** Compile highlight rules into a single matcher. Returns null when there's nothing to do. */
export function compileHighlights(rules) {
  const active = (rules || []).filter((r) => r.enabled !== false && r.pattern);
  if (!active.length) return null;
  const compiled = [];
  for (const r of active) {
    try {
      compiled.push({
        re: new RegExp(r.regex ? r.pattern : escapeRegExp(r.pattern), r.caseSensitive ? 'g' : 'gi'),
        on: `\x1b[${r.bold ? '1;' : ''}${hexToSgr(r.color)}m`,
        off: `\x1b[${r.bold ? '22;' : ''}39m`,
      });
    } catch { /* invalid user regex: skip rule */ }
  }
  return compiled.length ? compiled : null;
}

function highlightText(text, compiled) {
  // Collect non-overlapping matches across all rules (earliest wins).
  const marks = [];
  for (const c of compiled) {
    c.re.lastIndex = 0;
    let m;
    while ((m = c.re.exec(text))) {
      if (!m[0].length) { c.re.lastIndex++; continue; }
      marks.push({ start: m.index, end: m.index + m[0].length, c });
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let pos = 0;
  for (const mk of marks) {
    if (mk.start < pos) continue;
    out += text.slice(pos, mk.start) + mk.c.on + text.slice(mk.start, mk.end) + mk.c.off;
    pos = mk.end;
  }
  return out + text.slice(pos);
}

/** Apply highlighting to a chunk of terminal output. */
export function applyHighlights(data, compiled) {
  if (!compiled || !data) return data;
  let out = '';
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(data))) {
    if (m.index > last) out += highlightText(data.slice(last, m.index), compiled);
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < data.length) out += highlightText(data.slice(last), compiled);
  return out;
}
