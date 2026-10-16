// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Launcher, launchArgv } = require('../src/main/launcher');

function fakeSpawn(calls, fail) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail ? child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })) : child.emit('spawn')));
    return child;
  };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-')), 'approved_commands.json');

test('launcher: shell metacharacters are plain arguments, never a shell', async () => {
  const calls = [];
  const l = new Launcher(tmpFile(), { confirm: async () => 'once', spawn: fakeSpawn(calls) });
  assert.strictEqual(await l.run('ping -c 1 host; touch /tmp/pwned && $(id) `id` | cat'), true);
  assert.strictEqual(calls[0].cmd, 'ping');
  assert.deepStrictEqual(calls[0].args, ['-c', '1', 'host;', 'touch', '/tmp/pwned', '&&', '$(id)', '`id`', '|', 'cat']);
  assert.strictEqual(calls[0].opts.shell, false);
  assert.deepStrictEqual(launchArgv('open -a "Visual Studio Code"'), ['open', '-a', 'Visual Studio Code']);
});

test('launcher: each command needs approval; "Always Allow" persists, "Run Once" and Cancel do not', async () => {
  const file = tmpFile();
  const calls = [];
  const asked = [];
  let answer = false;
  const l = new Launcher(file, { confirm: async (argv) => { asked.push(argv); return answer; }, spawn: fakeSpawn(calls) });
  assert.strictEqual(await l.run('gedit'), false, 'cancel does not run');
  assert.strictEqual(calls.length, 0);
  answer = 'once';
  await l.run('gedit');
  await l.run('gedit');
  assert.strictEqual(asked.length, 3, 'run once asks every time');
  answer = 'always';
  await l.run('gedit');
  await l.run('gedit');
  assert.strictEqual(asked.length, 4, 'always allow is remembered');
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['gedit']);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  // A fresh launcher (next app start) remembers it, but a changed command asks again.
  const l2 = new Launcher(file, { confirm: async (argv) => { asked.push(argv); return 'once'; }, spawn: fakeSpawn(calls) });
  await l2.run('gedit');
  assert.strictEqual(asked.length, 4);
  await l2.run('gedit; rm -rf ~');
  assert.strictEqual(asked.length, 5);
});

test('launcher: bad commands are refused with a readable error', async () => {
  const l = new Launcher(tmpFile(), { confirm: async () => 'once', spawn: fakeSpawn([], true) });
  await assert.rejects(l.run('no-such-program'), /Program not found: no-such-program/);
  await assert.rejects(l.run('   '), /empty/);
  await assert.rejects(l.run('a\nb'), /line break/);
  await assert.rejects(l.run('say "unclosed'), /Unbalanced quote/);
  const win = new Launcher(tmpFile(), { confirm: async () => 'once', spawn: fakeSpawn([]), platform: 'win32' });
  await assert.rejects(win.run('C:\\tools\\build.bat --x'), /cmd \/c/);
});

test('launcher: a tampered approvals file cannot pollute or inject', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"__proto__":{"x":1}}');
  const l = new Launcher(file, { confirm: async () => false });
  assert.strictEqual(l.approved.size, 0);
  assert.strictEqual({}.x, undefined);
});
