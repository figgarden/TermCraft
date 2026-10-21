// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// The scripting API (`tc`, alias `crt`) built on the backend's native calls. Evaluated before
// each script; `__native(name, argsJson)` returns a JSON result or throws.
(function (G) {
  const N = (name, ...args) => JSON.parse(__native(name, JSON.stringify(args)));
  const ctx = N('context');
  const scriptTab = ctx.tabId;

  // ---- timers (run by the backend's event loop) ----
  let timerSeq = 0;
  const timers = new Map();
  G.setTimeout = (fn, ms = 0, ...a) => { const id = ++timerSeq; timers.set(id, { fn, a, at: Date.now() + Number(ms || 0), every: 0 }); return id; };
  G.setInterval = (fn, ms = 0, ...a) => { const id = ++timerSeq; const every = Math.max(1, Number(ms || 0)); timers.set(id, { fn, a, at: Date.now() + every, every }); return id; };
  G.clearTimeout = G.clearInterval = (id) => { timers.delete(id); };
  G.__nextTimer = () => { let next = -1; for (const t of timers.values()) if (next < 0 || t.at < next) next = t.at; return next < 0 ? -1 : Math.max(0, next - Date.now()); };
  G.__runTimers = () => {
    const now = Date.now();
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      if (t.every) t.at = now + t.every; else timers.delete(id);
      t.fn(...t.a);
    }
  };

  const check = () => { if (N('quit')) throw new Error('Script cancelled'); };
  const request = (type, payload) => N('request', type, payload);

  function tabApi(tabId) {
    const screen = {
      Synchronous: true,
      IgnoreEscape: true,
      MatchIndex: 0,
      Send(text) { check(); return N('send', tabId, String(text)); },
      SendSpecial(name) {
        check();
        const map = { VT_BREAK: null, MENU_TAB_BREAK: null, VT_ENTER: '\r', VT_TAB: '\t', VT_ESCAPE: '\x1b' };
        if (map[name] === null) return N('sendBreak', tabId);
        return N('send', tabId, map[name] || '');
      },
      /** Send with backslash escapes (\r, \n, \t, \xHH) expanded. */
      SendKeys(text) { check(); return N('send', tabId, N('expandEscapes', String(text))); },
      WaitForString(str, timeoutSec = 0) { check(); return N('waitFor', tabId, [String(str)], timeoutSec * 1000)[0] === 0; },
      /** Returns the 1-based index of the matched string, or 0 on timeout. */
      WaitForStrings(list, timeoutSec = 0) { check(); return N('waitFor', tabId, list.map(String), timeoutSec * 1000)[0] + 1; },
      /** Returns the text received before the matched string ('' on timeout). */
      ReadString(strs, timeoutSec = 0) {
        check();
        const list = Array.isArray(strs) ? strs : [strs];
        const [index, before] = N('waitFor', tabId, list.map(String), timeoutSec * 1000);
        screen.MatchIndex = index + 1;
        return index >= 0 ? before : '';
      },
      /** Screen text. With no args returns all visible rows joined by \n. Rows/cols are 1-based. */
      Get(row1, col1, row2, col2) {
        const lines = request('screenText', { tabId }) || [];
        if (row1 == null) return lines.join('\n');
        const out = [];
        for (let r = row1; r <= (row2 ?? row1); r++) out.push((lines[r - 1] || '').slice(col1 - 1, col2 ?? undefined));
        return out.join('\n');
      },
      CurrentRow() { return (request('cursor', { tabId }) || {}).row; },
      CurrentColumn() { return (request('cursor', { tabId }) || {}).col; },
      Clear() { return request('clearScreen', { tabId }); },
    };
    const session = {
      get Connected() { return N('state', tabId) === 'connected'; },
      get RemoteAddress() { return (N('session', tabId) || {}).host; },
      get Path() { return (N('session', tabId) || {}).name; },
      Disconnect() { N('disconnect', tabId); },
      Log(start = true, file) { return N('log', tabId, !!start, file ?? null); },
      Reconnect() { return request('reconnectTab', { tabId }); },
    };
    return {
      get Index() { return tabId; },
      Caption() { return (request('tabInfo', { tabId }) || {}).caption; },
      Activate() { return request('activateTab', { tabId }); },
      Screen: screen,
      Session: session,
    };
  }

  const scriptApi = tabApi(scriptTab);
  const tc = {
    ScriptFullName: ctx.file,
    Arguments: ctx.args,
    Version: ctx.version,
    Screen: scriptApi.Screen,
    Sleep: (ms) => { N('sleep', Number(ms) || 0); },
    GetScriptTab: () => tabApi(scriptTab),
    GetActiveTab() { return tabApi(request('activeTab', {})); },
    GetTabCount() { return (request('tabs', {}) || []).length; },
    GetTab(i) { const tabs = request('tabs', {}) || []; return tabs[i - 1] ? tabApi(tabs[i - 1].tabId) : null; },
    Dialog: {
      MessageBox: (message, title = 'TermCraft Script') => request('prompt', { kind: 'message', title, message: String(message) }),
      Prompt: (message, title = 'TermCraft Script', def = '', isPassword = false) =>
        request('prompt', { kind: isPassword ? 'password' : 'text', title, message: String(message), defaultValue: def }),
      FileOpenDialog: (title = 'Open') => request('openFile', { title }),
    },
    /** Connect a saved session by name, or a "user@host:port" string; returns its tab. */
    ConnectInTab(target) {
      const newTab = request('connectSession', { target });
      if (!newTab) throw new Error(`Could not connect to ${target}`);
      return tabApi(newTab);
    },
    Clipboard: {
      get Text() { return N('clipboardGet'); },
      set Text(v) { N('clipboardSet', String(v)); },
    },
    Quit() { N('setQuit'); },
  };
  tc.Session = Object.create(null);
  for (const k of ['Disconnect', 'Log', 'Reconnect']) tc.Session[k] = scriptApi.Session[k];
  Object.defineProperty(tc.Session, 'Connected', { get: () => N('state', scriptTab) === 'connected', enumerable: true });
  Object.defineProperty(tc.Session, 'RemoteAddress', { get: () => (N('session', scriptTab) || {}).host, enumerable: true });
  Object.defineProperty(tc.Session, 'Path', { get: () => (N('session', scriptTab) || {}).name, enumerable: true });
  tc.Session.Connect = tc.ConnectInTab;

  G.tc = tc;
  G.crt = tc; // compatibility alias
  const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  G.console = { log: (...a) => N('output', fmt(a)), info: (...a) => N('output', fmt(a)), warn: (...a) => N('output', fmt(a)), error: (...a) => N('output', 'ERROR: ' + fmt(a)) };
  G.__dirname = ctx.dirname;
  G.store = { sessions: () => N('storeTree') };

  // ---- a subset of Node's modules ----
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  const isAbs = (p) => (ctx.platform === 'win32' ? /^([A-Za-z]:)?[\\/]/.test(p) : p.startsWith('/'));
  const normalize = (p) => {
    const abs = isAbs(p);
    const prefix = ctx.platform === 'win32' ? (/^[A-Za-z]:/.exec(p) || [''])[0] : '';
    const parts = [];
    for (const s of p.slice(prefix.length).split(/[\\/]+/)) {
      if (!s || s === '.') continue;
      if (s === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); } else parts.push(s);
    }
    return prefix + (abs ? sep : '') + parts.join(sep) || (abs ? sep : '.');
  };
  const path = {
    sep,
    delimiter: ctx.platform === 'win32' ? ';' : ':',
    isAbsolute: isAbs,
    normalize,
    join: (...a) => normalize(a.filter((x) => x !== '').join(sep)),
    resolve: (...a) => { let p = ''; for (const x of a) p = isAbs(x) ? x : (p ? p + sep + x : x); return normalize(isAbs(p) ? p : ctx.cwd + sep + p); },
    dirname: (p) => { const n = p.replace(/[\\/]+$/, ''); const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\')); return i < 0 ? '.' : i === 0 ? n[0] : n.slice(0, i); },
    basename: (p, ext) => { const b = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  };
  path.posix = path;
  const text = (d) => (typeof d === 'string' ? d : d == null ? '' : String(d));
  const fs = {
    readFileSync: (f) => N('fs.read', String(f)),
    writeFileSync: (f, d) => { N('fs.write', String(f), text(d), false); },
    appendFileSync: (f, d) => { N('fs.write', String(f), text(d), true); },
    existsSync: (f) => N('fs.exists', String(f)),
    mkdirSync: (f, o) => { N('fs.mkdir', String(f), !!(o && o.recursive)); },
    readdirSync: (f) => N('fs.readdir', String(f)),
    unlinkSync: (f) => { N('fs.rm', String(f), false); },
    rmSync: (f, o) => { N('fs.rm', String(f), !!(o && o.recursive)); },
    renameSync: (a, b) => { N('fs.rename', String(a), String(b)); },
    statSync: (f) => { const s = N('fs.stat', String(f)); return { ...s, mtime: new Date(s.mtimeMs), isDirectory: () => s.dir, isFile: () => s.file }; },
  };
  fs.promises = Object.fromEntries(['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'unlink', 'rm', 'rename', 'stat']
    .map((k) => [k, async (...a) => fs[`${k}Sync`](...a)]));
  for (const k of ['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'unlink', 'rm', 'rename', 'stat']) {
    fs[k] = (...a) => { const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null; let r, e = null; try { r = fs[`${k}Sync`](...a); } catch (x) { e = x; } if (cb) setTimeout(() => cb(e, r)); };
  }
  const os = {
    homedir: () => ctx.home, hostname: () => ctx.hostname, platform: () => ctx.platform, tmpdir: () => ctx.tmpdir,
    EOL: ctx.platform === 'win32' ? '\r\n' : '\n', userInfo: () => ({ username: ctx.username, homedir: ctx.home }),
    type: () => ({ darwin: 'Darwin', win32: 'Windows_NT', linux: 'Linux' }[ctx.platform]),
  };
  const childProcess = {
    execSync: (cmd, o) => N('cp.exec', String(cmd), (o && o.cwd) || null),
    execFileSync: (file, args = [], o) => N('cp.execFile', String(file), (args || []).map(String), (o && o.cwd) || null),
    spawnSync: (file, args = [], o) => N('cp.spawn', String(file), (args || []).map(String), (o && o.cwd) || null),
  };
  const bytes = (hex) => ({ hex, toString(enc = 'hex') { return enc === 'base64' ? N('crypto.b64', hex) : hex; }, get length() { return hex.length / 2; } });
  const crypto = {
    randomBytes: (n) => bytes(N('crypto.random', Number(n) || 0)),
    randomUUID: () => N('crypto.uuid'),
    createHash: (alg) => {
      let data = '';
      const h = { update(d) { data += text(d); return h; }, digest(enc = 'hex') { const hex = N('crypto.hash', String(alg), data); return enc === 'base64' ? N('crypto.b64', hex) : hex; } };
      return h;
    },
  };
  const modules = { fs, path, os, child_process: childProcess, crypto };
  G.require = (m) => {
    const name = String(m).replace(/^node:/, '');
    if (name in modules) return modules[name];
    throw new Error(`Module "${m}" is not available to scripts`);
  };
})(globalThis);
