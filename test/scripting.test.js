// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScriptEngine } = require('../src/main/scripting');

test('scripting: crt API drives a tab', async () => {
  const sent = [];
  const manager = {
    write: (id, d) => { sent.push(d); return true; },
    waitFor: async (id, pats) => ({ index: pats.length - 1, before: 'output-before' }),
    get: () => ({ state: 'connected', session: { host: 'h', name: 'n' } }),
    info: () => {},
  };
  const requests = [];
  const engine = new ScriptEngine({ manager, store: {}, request: async (type, p) => { requests.push([type, p]); return type === 'screenText' ? ['line1', 'line2'] : 'answer'; } });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-script-')), 's.js');
  fs.writeFileSync(file, `
    crt.Screen.Send("cmd\\r");
    const idx = await crt.Screen.WaitForStrings(["a", "b"], 1);
    const text = await crt.Screen.ReadString("$", 1);
    const name = await crt.Dialog.Prompt("Name?");
    const screen = await crt.Screen.Get(2, 1, 2, 4);
    crt.Screen.SendKeys(idx + text + name + screen + (crt.Session.Connected ? "Y" : "N") + "\\\\r");
  `);
  await engine.run(file, 'tab1');
  assert.deepStrictEqual(sent, ['cmd\r', '2output-beforeanswerlineY\r']);
  assert.strictEqual(requests[0][0], 'prompt');
});

test('scripting: `tc` is the automation object (`crt` kept as an alias)', async () => {
  const sent = [];
  const manager = { write: (id, d) => { sent.push(d); return true; }, get: () => ({ state: 'connected', session: {} }), info: () => {} };
  const engine = new ScriptEngine({ manager, store: {}, request: async () => null });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-script-')), 's.js');
  fs.writeFileSync(file, 'tc.Screen.Send("a"); crt.Screen.Send(tc === crt ? "same" : "different");');
  await engine.run(file, 'tab1');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.deepStrictEqual(sent, ['a', 'same']);
});
