// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Security helpers for the main process. TermCraft runs untrusted remote content (terminal output,
 * server-supplied file names, imported session files), so the main process treats everything it
 * receives from the renderer or from servers as untrusted input.
 */
const path = require('path');

/** Keys that must never be merged/assigned from untrusted JSON (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON.parse that drops prototype-polluting keys. */
function safeJsonParse(text) {
  return JSON.parse(text, (k, v) => (UNSAFE_KEYS.has(k) ? undefined : v));
}

/** Only http(s) URLs may be handed to the OS browser. */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false; // exact, no leading junk
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A remote-supplied file name must be one plain path component (no traversal, no separators). */
function isSafeFileName(name) {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..'
    && !/[/\\\0]/.test(name) && !/^[A-Za-z]:/.test(name);
}

/**
 * Split a command template into argv without a shell, honouring "double" and 'single' quotes,
 * then substitute {tokens} inside individual arguments. Values can never break out of their
 * argument, so a hostile host or user name cannot inject shell syntax.
 */
function buildArgv(template, values) {
  const args = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of String(template)) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) { args.push(cur); cur = ''; any = false; }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('Unbalanced quote in command');
  if (cur || any) args.push(cur);
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)));
}

/**
 * Paths the user has explicitly chosen (file dialogs) or browsed (SFTP local pane). Renderer
 * requests that touch the local file system are only honoured for these, so a compromised
 * renderer cannot read or delete arbitrary files.
 */
class ApprovedPaths {
  constructor() {
    this.files = new Set();
    this.dirs = new Set();
    this.chosen = new Set(); // folders picked in a native folder dialog
  }

  approveFile(p) { if (p) this.files.add(path.resolve(p)); }
  approveDir(p) { if (p) this.dirs.add(path.resolve(p)); }

  /** A folder the user picked in a native dialog (not one the page merely browsed). */
  chooseDir(p) { if (p) { this.approveDir(p); this.chosen.add(path.resolve(p)); } }

  isChosenDir(p) { return typeof p === 'string' && !!p && this.chosen.has(path.resolve(p)); }

  isApprovedFile(p) { return typeof p === 'string' && this.files.has(path.resolve(p)); }

  /** True when `p` is a browsed directory or directly inside one. */
  isInApprovedDir(p) {
    if (typeof p !== 'string' || !p) return false;
    const abs = path.resolve(p);
    return this.dirs.has(abs) || this.dirs.has(path.dirname(abs));
  }
}

module.exports = { UNSAFE_KEYS, safeJsonParse, isSafeExternalUrl, isSafeFileName, buildArgv, ApprovedPaths };
