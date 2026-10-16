// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Run every end-to-end suite in test/smoke/ against the real app (each in a throwaway profile)
 * and fail if any check fails or a suite errors.  Usage: npm run test:e2e
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const electron = require('electron'); // path to the Electron binary when required from Node
const suites = fs.readdirSync(path.join(root, 'test', 'smoke')).filter((f) => f.endsWith('-smoke.js')).sort();
let failed = 0;

// On Linux CI, Chromium's sandbox needs privileges the runner doesn't grant (tests only).
const extraArgs = process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [];

function runSuite(suite) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-e2e-'));
  const res = spawnSync(electron, ['.', `--user-data-dir=${path.join(profile, 'ud')}`, ...extraArgs], {
    cwd: root,
    env: { ...process.env, TERMCRAFT_SMOKE: path.join('test', 'smoke', suite), TERMCRAFT_SHOTS: path.join(profile, 'shots') },
    encoding: 'utf8',
    timeout: 300000,
  });
  fs.rmSync(profile, { recursive: true, force: true });
  const out = `${res.stdout}\n${res.stderr}`;
  const pass = (out.match(/\[smoke\] PASS/g) || []).length;
  const fails = out.split('\n').filter((l) => /\[smoke\] (FAIL|Error|\[)/.test(l));
  if (res.error) fails.push(`suite did not finish: ${res.error.message}`);
  if (!pass && !fails.length) fails.push(`suite produced no results (exit ${res.status}): ${out.trim().split('\n').slice(-3).join(' | ')}`);
  return { pass, fails };
}

const flaky = [];
for (const suite of suites) {
  const name = suite.replace('-smoke.js', '');
  let r = runSuite(suite);
  // A suite that fails once is run again; if it then passes it is reported as flaky, not hidden.
  if (r.fails.length) {
    const second = runSuite(suite);
    if (!second.fails.length) { flaky.push(`${name} (first run: ${r.fails[0].trim()})`); r = second; }
  }
  console.log(`${r.fails.length ? '✖' : '✔'} ${name}: ${r.pass} passed${r.fails.length ? `, ${r.fails.length} failed` : ''}`);
  for (const f of r.fails) console.log(`    ${f.trim()}`);
  failed += r.fails.length;
}
if (flaky.length) console.log(`\n⚠ Flaky (failed once, passed on retry):\n  ${flaky.join('\n  ')}`);
console.log(failed ? `\n${failed} end-to-end check(s) failed` : '\nAll end-to-end suites passed');
process.exit(failed ? 1 : 0);
