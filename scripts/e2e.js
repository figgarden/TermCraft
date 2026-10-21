// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Run every end-to-end suite in test/smoke/ against the real app (a debug build, each run in a
 * throwaway profile) and fail if any check fails or a suite errors.  Usage: npm run test:e2e
 *
 * The app is started with TERMCRAFT_CONTROL=1, which (in debug builds only) opens a localhost
 * test-control channel. Each suite gets `win` (evaluate code in the page, resize the window) and
 * `deps` ({ store, control }) — see makeWin() below.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'termcraft.exe' : 'termcraft');
// `--script path/to/file.js` runs one driver (e.g. scripts/screenshots.js); otherwise suite name prefixes.
const scriptArg = process.argv.indexOf('--script');
const only = scriptArg >= 0 ? [] : process.argv.slice(2);
const suites = scriptArg >= 0 ? [path.resolve(process.argv[scriptArg + 1])]
  : fs.readdirSync(path.join(root, 'test', 'smoke')).filter((f) => f.endsWith('-smoke.js')).sort()
    .filter((f) => !only.length || only.some((o) => f.startsWith(o))).map((f) => path.join(root, 'test', 'smoke', f));

/** A 1×1 PNG (screenshots are for people; checks never depend on them). */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** Start the app; resolves to { proc, rq(op) } once its test-control channel is up. */
function launch(profile, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, [`--user-data-dir=${profile}`], { env: { ...process.env, ...env, TERMCRAFT_CONTROL: '1' } });
    let out = '';
    const lines = [];
    proc.stdout.on('data', (d) => { out += d; lines.push(...String(d).split('\n')); });
    proc.stderr.on('data', (d) => { lines.push(...String(d).split('\n')); if (process.env.E2E_APP_LOG) fs.appendFileSync(process.env.E2E_APP_LOG, d); });
    proc.on('exit', (code) => reject(new Error(`app exited (${code}) before the control channel opened: ${lines.slice(-5).join(' | ')}`)));
    const timer = setInterval(() => {
      const m = /\[control\] (\d+) (\w+)/.exec(out);
      if (!m) return;
      clearInterval(timer);
      proc.removeAllListeners('exit');
      const sock = net.connect(Number(m[1]), '127.0.0.1');
      let buf = '';
      let seq = 0;
      const waits = new Map();
      sock.on('data', (x) => {
        buf += x;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          const w = waits.get(msg.id);
          waits.delete(msg.id);
          if (w) (msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result));
        }
      });
      // A reset or broken pipe (the app quit or crashed mid-request) is reported as 'close' below.
      sock.on('error', () => {});
      sock.on('close', () => { for (const w of waits.values()) w.reject(new Error('app closed')); waits.clear(); });
      const rq = (o) => new Promise((res, rej) => {
        if (sock.destroyed || sock.readyState !== 'open') { rej(new Error('app closed')); return; }
        const id = ++seq;
        waits.set(id, { resolve: res, reject: rej });
        sock.write(`${JSON.stringify({ ...o, id, token: m[2] })}\n`);
      });
      resolve({ proc, rq, lines, sock });
    }, 50);
    setTimeout(() => reject(new Error('app did not start within 60 s')), 60000);
  });
}

/** What a suite gets: a stand-in for Electron's BrowserWindow, the store, and test controls. */
function makeWin(rq, dataDir) {
  const ipc = (channel, ...args) => rq({ op: 'ipc', channel, args: args.map((a) => (a === undefined ? null : a)) });
  const win = {
    setSize: (width, height) => rq({ op: 'setSize', width, height }).catch(() => {}),
    webContents: {
      executeJavaScript: (code) => rq({ op: 'eval', code }),
      capturePage: async () => {
        // A real screenshot where the platform allows it (macOS), else a blank image.
        const file = path.join(os.tmpdir(), `termcraft-shot-${process.pid}-${Date.now()}.png`);
        const ok = await rq({ op: 'capture', path: file }).catch(() => false);
        const data = ok && fs.existsSync(file) ? fs.readFileSync(file) : BLANK_PNG;
        fs.rmSync(file, { force: true });
        const img = { toPNG: () => data, resize: () => img };
        return img;
      },
      getURL: () => rq({ op: 'url' }),
    },
  };
  const store = {
    saveSession: (s) => ipc('store:saveSession', s),
    getTree: () => ipc('store:tree'),
    getSettings: () => ipc('store:settings'),
    saveSettings: (p) => ipc('store:saveSettings', p),
    saveCredential: (c) => ipc('cred:save', c),
    saveFolder: (f) => ipc('store:saveFolder', f),
    files: { sessions: path.join(dataDir, 'sessions.json'), settings: path.join(dataDir, 'settings.json') },
  };
  const control = {
    /** Answers for the next native file dialogs: a path, a list of paths, or null (cancel). */
    mockDialogs: (answers) => rq({ op: 'mockDialogs', answers }),
    /** Answers for the next native confirmation boxes: 'once' | 'always' | 'cancel'. */
    mockBoxes: (answers) => rq({ op: 'mockBoxes', answers }),
    boxCalls: () => rq({ op: 'boxCalls' }),
    /** Record links and folders the app would open instead of opening them. */
    mockShell: () => rq({ op: 'mockShell' }),
    externalOpened: () => rq({ op: 'externalOpened' }),
    windowCount: () => rq({ op: 'windowCount' }),
    ipc,
  };
  return { win, deps: { store, control } };
}

async function runSuite(suite) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-e2e-'));
  const shots = path.join(profile, 'shots');
  const log = [];
  const realLog = console.log;
  const record = (line) => { log.push(line); if (process.env.E2E_VERBOSE) realLog(`    ${line}`); };
  let app;
  try {
    app = await launch(path.join(profile, 'ud'), { TERMCRAFT_SHOTS: shots });
    process.env.TERMCRAFT_SHOTS = shots;
    const { win, deps } = makeWin(app.rq, path.join(profile, 'ud', 'data'));
    console.log = (...a) => record(a.join(' '));
    // Suites start after the page has loaded and connected its listeners.
    for (let i = 0; i < 100; i++) {
      if (await app.rq({ op: 'eval', code: 'typeof window.termcraft === "object" && !!window.termcraft.tabs' }).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    delete require.cache[require.resolve(suite)];
    await require(suite)(win, deps);
  } catch (e) {
    record(`[smoke] Error ${e.stack || e.message}`);
  } finally {
    console.log = realLog;
    if (app) {
      const exitedEarly = app.proc.exitCode !== null || app.proc.signalCode !== null;
      await app.rq({ op: 'quit' }).catch(() => {});
      if (!exitedEarly) {
        await new Promise((r) => { const t = setTimeout(() => { app.proc.kill(); r(); }, 5000); app.proc.once('exit', () => { clearTimeout(t); r(); }); });
      } else {
        record(`[smoke] Error the app exited during the suite (${app.proc.exitCode ?? app.proc.signalCode}): ${app.lines.filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 600)}`);
      }
      app.sock.destroy();
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
  const pass = log.filter((l) => /\[smoke\] PASS/.test(l)).length;
  const fails = log.filter((l) => /\[smoke\] (FAIL|Error)/.test(l));
  if (!pass && !fails.length) fails.push('suite produced no results');
  // GTK prints a warning per menu item each time the menu is rebuilt; they hide the useful lines.
  const tail = fails.length && process.env.CI ? [...log, ...(app?.lines || [])].filter((l) => l.trim() && !/Gtk-WARNING|^\s*\(0x[0-9a-f]+\) for Gtk/.test(l)).slice(-25).map((l) => `      | ${l.slice(0, 400)}`) : [];
  return { pass, fails, tail };
}

(async () => {
  if (!fs.existsSync(exe) || process.env.E2E_BUILD !== '0') {
    const b = spawnSync('cargo', ['build'], { cwd: path.join(root, 'src-tauri'), stdio: 'inherit' });
    if (b.status !== 0) process.exit(1);
  }
  let failed = 0;
  const flaky = [];
  for (const suite of suites) {
    const name = path.basename(suite).replace('-smoke.js', '');
    let r = await runSuite(suite);
    // A suite that fails once is run again; if it then passes it is reported as flaky, not hidden.
    if (r.fails.length) {
      const second = await runSuite(suite);
      if (!second.fails.length) { flaky.push(`${name} (first run: ${r.fails[0].trim()})`); r = second; }
    }
    console.log(`${r.fails.length ? '✖' : '✔'} ${name}: ${r.pass} passed${r.fails.length ? `, ${r.fails.length} failed` : ''}`);
    for (const f of r.fails) console.log(`    ${f.trim()}`);
    if (r.tail.length) console.log(`    output tail:\n${r.tail.join('\n')}`);
    failed += r.fails.length;
  }
  if (flaky.length) console.log(`\n⚠ Flaky (failed once, passed on retry):\n  ${flaky.join('\n  ')}`);
  console.log(failed ? `\n${failed} end-to-end check(s) failed` : '\nAll end-to-end suites passed');
  process.exit(failed ? 1 : 0);
})();
