// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// Tests for the page's own logic (src/renderer). The backend's tests are in src-tauri (cargo test).
const test = require('node:test');
const assert = require('node:assert');

test('highlight: colors text but never inside escape sequences', async () => {
  const { compileHighlights, applyHighlights } = await import('../src/renderer/js/highlight.js');
  const c = compileHighlights([{ pattern: 'error', color: '#ff0000', bold: false }]);
  const out = applyHighlights('\x1b]0;error title\x07an error\x1b[31m', c);
  assert.strictEqual(out, '\x1b]0;error title\x07an \x1b[38;2;255;0;0merror\x1b[39m\x1b[31m');
  assert.strictEqual(compileHighlights([{ pattern: '(', regex: true }]), null); // bad regex skipped
});

test('button bars: send string escapes, \\p pauses and ${prompt:} variables', async () => {
  const { prepareSendString } = await import('../src/renderer/js/button-bars.js');
  assert.deepStrictEqual(await prepareSendString('show ver\\r'), ['show ver\r']);
  assert.deepStrictEqual(await prepareSendString('conf t\\r\\pint ${prompt:Port}\\r\\pdesc ${prompt:Port}\\r', async () => 'Gi0/1'),
    ['conf t\r', 'int Gi0/1\r', 'desc Gi0/1\r']);
  const asked = [];
  await prepareSendString('${prompt:A} ${prompt:B} ${prompt:A}', async (t, label) => { asked.push(label); return 'x'; });
  assert.deepStrictEqual(asked, ['A:', 'B:'], 'each distinct prompt asked once');
  assert.strictEqual(await prepareSendString('x ${prompt:Y}', async () => null), null, 'cancel aborts');
});
