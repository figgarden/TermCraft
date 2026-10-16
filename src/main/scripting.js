// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { expandEscapes } = require('./util');

/**
 * Runs JavaScript automation scripts against the `tc` object model
 * (also available as `crt`, for compatibility with scripts written for other terminal emulators).
 * Calls that wait on the remote side or the UI return promises — use `await`
 * (scripts execute inside an async function, so top-level await works).
 */
class ScriptEngine {
  /** @param {{ manager, request(type, payload) => Promise, store }} deps */
  constructor(deps) {
    this.deps = deps;
    this.running = new Map(); // runId -> { cancelled }
    this.seq = 0;
  }

  _tabApi(tabId, run) {
    const { manager, request } = this.deps;
    const check = () => { if (run.cancelled) throw new Error('Script cancelled'); };
    const tab = {
      get Index() { return tabId; },
      async Caption() { return (await request('tabInfo', { tabId }))?.caption; },
      Activate() { return request('activateTab', { tabId }); },
      Screen: {
        Synchronous: true,
        IgnoreEscape: true,
        Send(text) { check(); return manager.write(tabId, String(text), true); },
        SendSpecial(name) {
          check();
          const map = { VT_BREAK: null, MENU_TAB_BREAK: null, VT_ENTER: '\r', VT_TAB: '\t', VT_ESCAPE: '\x1b' };
          if (map[name] === null) return manager.sendBreak(tabId);
          return manager.write(tabId, map[name] || '', true);
        },
        /** Send with backslash escapes (\r, \n, \t, \xHH) expanded. */
        SendKeys(text) { check(); return manager.write(tabId, expandEscapes(String(text)), true); },
        async WaitForString(str, timeoutSec = 0) {
          check();
          const r = await manager.waitFor(tabId, [String(str)], timeoutSec * 1000);
          return r.index === 0;
        },
        /** Returns the 1-based index of the matched string, or 0 on timeout. */
        async WaitForStrings(list, timeoutSec = 0) {
          check();
          const r = await manager.waitFor(tabId, list.map(String), timeoutSec * 1000);
          return r.index + 1;
        },
        /** Returns the text received before the matched string ('' on timeout). */
        async ReadString(strs, timeoutSec = 0) {
          check();
          const list = Array.isArray(strs) ? strs : [strs];
          const r = await manager.waitFor(tabId, list.map(String), timeoutSec * 1000);
          tab.Screen.MatchIndex = r.index + 1;
          return r.index >= 0 ? r.before : '';
        },
        MatchIndex: 0,
        /** Screen text. With no args returns all visible rows joined by \n. Rows/cols are 1-based. */
        async Get(row1, col1, row2, col2) {
          const lines = await request('screenText', { tabId });
          if (row1 == null) return lines.join('\n');
          const out = [];
          for (let r = row1; r <= (row2 ?? row1); r++) out.push((lines[r - 1] || '').slice(col1 - 1, col2 ?? undefined));
          return out.join('\n');
        },
        async CurrentRow() { return (await request('cursor', { tabId }))?.row; },
        async CurrentColumn() { return (await request('cursor', { tabId }))?.col; },
        async Clear() { return request('clearScreen', { tabId }); },
      },
      Session: {
        get Connected() { return manager.get(tabId)?.state === 'connected'; },
        get RemoteAddress() { return manager.get(tabId)?.session.host; },
        get Path() { return manager.get(tabId)?.session.name; },
        Disconnect() { manager.close(tabId); },
        Log(start = true, file) { return start ? manager.startLog(tabId, file) : manager.stopLog(tabId); },
        async Reconnect() { return request('reconnectTab', { tabId }); },
      },
    };
    return tab;
  }

  async run(file, tabId, args = []) {
    const code = fs.readFileSync(file, 'utf8');
    const runId = ++this.seq;
    const run = { cancelled: false };
    this.running.set(runId, run);
    const { request, manager, store } = this.deps;
    const self = this;
    const output = (msg) => { if (tabId) manager.info(tabId, `[script] ${msg}`, 36); };

    const crt = {
      ScriptFullName: file,
      Arguments: args,
      Version: '0.1.0',
      Screen: null,
      Session: null,
      Sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      GetScriptTab: () => self._tabApi(tabId, run),
      async GetActiveTab() { return self._tabApi(await request('activeTab', {}), run); },
      async GetTabCount() { return (await request('tabs', {})).length; },
      async GetTab(i) { const tabs = await request('tabs', {}); return tabs[i - 1] ? self._tabApi(tabs[i - 1].tabId, run) : null; },
      Dialog: {
        MessageBox: (message, title = 'TermCraft Script') => request('prompt', { kind: 'message', title, message: String(message) }),
        Prompt: (message, title = 'TermCraft Script', def = '', isPassword = false) =>
          request('prompt', { kind: isPassword ? 'password' : 'text', title, message: String(message), defaultValue: def }),
        FileOpenDialog: (title = 'Open') => request('openFile', { title }),
      },
      Session: null,
      /** Connect a saved session by name, or a "user@host:port" string; returns its tab. */
      async ConnectInTab(target) {
        const newTab = await request('connectSession', { target });
        if (!newTab) throw new Error(`Could not connect to ${target}`);
        return self._tabApi(newTab, run);
      },
      Clipboard: {
        get Text() { return require('electron').clipboard.readText(); },
        set Text(v) { require('electron').clipboard.writeText(String(v)); },
      },
      Quit() { run.cancelled = true; },
    };
    const scriptTab = this._tabApi(tabId, run);
    crt.Screen = scriptTab.Screen;
    crt.Session = { ...scriptTab.Session, Connect: crt.ConnectInTab };
    Object.defineProperty(crt.Session, 'Connected', { get: () => manager.get(tabId)?.state === 'connected' });

    const sandbox = {
      tc: crt,
      crt, // compatibility alias
      console: { log: (...a) => output(a.join(' ')), error: (...a) => output('ERROR: ' + a.join(' ')) },
      setTimeout, clearTimeout, setInterval, clearInterval,
      require: (m) => {
        // Allow a safe-ish set of builtin modules for file I/O and paths.
        if (['fs', 'path', 'os', 'child_process', 'net', 'crypto'].includes(m)) return require(m);
        throw new Error(`Module "${m}" is not available to scripts`);
      },
      __dirname: path.dirname(file),
      store: { sessions: () => store.getTree() },
    };
    try {
      const wrapped = `(async () => {\n${code}\n})()`;
      await vm.runInNewContext(wrapped, sandbox, { filename: file, timeout: undefined });
    } finally {
      this.running.delete(runId);
    }
  }

  cancelAll() { for (const r of this.running.values()) r.cancelled = true; }
}

module.exports = { ScriptEngine };
