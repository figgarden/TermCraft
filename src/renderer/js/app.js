// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { h, $, contextMenu, confirmDialog, showDialog, toast, isDialogOpen, alertDialog } from './dom.js';
import { TerminalTab } from './terminal-tab.js';
import { SftpTab } from './sftp-tab.js';
import { ScpTab } from './scp-tab.js';
import { VncTab } from './vnc-tab.js';
import { RdpTab } from './rdp-tab.js';
import { BatchTab } from './batch-tab.js';
import { TftpTab } from './tftp-tab.js';
import { credentialsDialog, importHostsDialog, runCommandsDialog, sshKeysDialog, installKeyDialog, orderFilesDialog, errMsg } from './tools.js';
import { SessionManager } from './session-manager.js';
import { editSession, PROTOCOL_LABEL } from './session-editor.js';
import { quickConnect, globalOptions, knownHostsDialog, handlePrompt, scriptHelp, shortcutsHelp, aboutDialog, licenseDialog } from './dialogs.js';
import { compileHighlights } from './highlight.js';
import { ButtonBars } from './button-bars.js';
import { currentTheme, appearanceOf, cssVars } from './themes.js';
import { icon } from './icons.js';
import { CommandBuffer } from './command-buffer.js';
import * as rns from './reticulum.js';

const api = window.api;

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over !== undefined ? over : base;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over !== undefined ? over : base;
}

function expandEscapes(str) {
  return (str || '').replace(/\\(x[0-9a-fA-F]{2}|[rntebav\\0])/g, (m, c) => {
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { r: '\r', n: '\n', t: '\t', e: '\x1b', b: '\b', a: '\x07', v: '\v', '\\': '\\', 0: '\0' }[c];
  });
}

const DEFAULT_PORTS = { ssh2: 22, telnet: 23, rlogin: 513, raw: 23, vnc: 5900, rdp: 3389 };

// [value, toolbar label, tooltip]
const LAYOUTS = [
  ['tabs', 'Tabs', 'One session at a time, switch with tabs'],
  ['tile-h', 'Stacked', 'All sessions stacked one above another'],
  ['tile-v', 'Side by Side', 'All sessions side by side'],
  ['grid', 'Grid', 'All sessions in a grid'],
];

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

class App {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.broadcast = false;
    this.fontDelta = 0;
    this.highlights = null;
    this.keymap = new Map();
  }

  async init() {
    [this.settings, this.tree, this.info] = await Promise.all([api.store.settings(), api.store.tree(), api.app.info()]);
    this.platform = this.info.platform;
    document.documentElement.dataset.platform = this.platform;
    this.layout = this.settings.layout || 'tabs';
    // Older versions stored one theme; move it to Light / Dark / Auto once.
    if (!this.settings.appearance) this.settings = await api.store.saveSettings(appearanceOf(this.settings));
    this._compile();
    // xterm measures the font when a terminal opens: load the bundled one first.
    await Promise.all(['400', '700'].map((w) => document.fonts.load(`${w} 14px "JetBrains Mono"`).catch(() => {})));
    this._buildUi();
    this.applyTheme();

    api.conn.onData((tabId, data) => this.tabById(tabId)?.write(data));
    api.conn.onState((tabId, st) => this.tabById(tabId)?.onState(st));
    api.conn.onStatus((tabId, st) => {
      const t = this.tabById(tabId);
      if (t) { t.status = { ...t.status, ...st }; if (t === this.active) this.updateStatus(); }
    });
    api.conn.onLog((tabId, st) => {
      const t = this.tabById(tabId);
      if (!t) return;
      t.logging = st.logging;
      t.logPath = st.path;
      if (st.logging) toast(`Logging to ${st.path}`);
      this.renderTabs();
      this.updateStatus();
    });
    api.conn.onSessionSaved(async (tabId, { session, forTab }) => {
      // Point the tab at the saved session so reconnects and clones reuse the login.
      const t = this.tabById(tabId);
      if (t && forTab) t.session = session;
      await this.reloadTree();
      toast(`Login saved for "${session.name}" — you won't be asked again`);
    });
    api.xfer.onProgress((tabId, p) => this.tabById(tabId)?.onXfer?.(p));
    api.onMenu((action, arg) => this.dispatch(action, arg));
    // On macOS ⌘E opens the Command Buffer; Ctrl+Shift+E (the Windows/Linux shortcut) works too.
    if (this.platform === 'darwin') {
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === 'KeyE') {
          e.preventDefault();
          e.stopPropagation();
          this.dispatch('toggleCommandWindow');
        }
      }, true);
    }
    api.onRequest((type, payload) => this.onRequest(type, payload));

    // The OS switched light/dark (Auto mode): re-apply, keeping any preview that Settings is showing.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme(this.previewPatch));
    setInterval(() => this.updateStatus(), 1000);
    this.renderTabs();
    this.updateStatus();
    if (!this.tabs.length) this._showWelcome();
    this._checkKeychain();
  }

  /** With saved logins, confirm keychain access now (macOS asks here) and explain if it was denied. */
  async _checkKeychain() {
    const status = await api.app.keychainStatus().catch(() => 'none');
    if (status !== 'denied') return;
    const where = { darwin: 'macOS Keychain', win32: 'Windows credential store' }[this.platform] || 'system keyring';
    await showDialog({
      title: 'Saved Logins Are Locked', width: 520,
      body: h('div.form', {},
        h('p', {}, `TermCraft couldn't access the ${where}, so it can't use or save your logins. You'll be asked for passwords when you connect.`),
        h('p.hint', {}, this.platform === 'darwin'
          ? 'To fix this: quit and reopen TermCraft, and when macOS asks about "TermCraft Safe Storage", enter your Mac password and choose "Always Allow". If you are not asked, open Keychain Access, find "TermCraft Safe Storage" and add TermCraft under Access Control.'
          : 'Make sure the system keyring is unlocked, then restart TermCraft.')),
      buttons: [{ label: 'OK', value: true, primary: true }],
    });
  }

  _compile() {
    if (this.quickInput) this.quickInput.placeholder = rns.enabled(this) ? 'Enter host or destination hash — user@host[:port] or <hash>' : 'Enter host — user@host[:port]';
    this.highlights = compileHighlights(this.settings.highlights);
    this.keymap = new Map((this.settings.keymap || []).filter((k) => k.key).map((k) => [k.key, k]));
  }

  tabById(id) { return this.tabs.find((t) => t.id === id); }

  effectiveSession(session) {
    return deepMerge(this.settings.defaultSession, JSON.parse(JSON.stringify(session || {})));
  }

  // ---- UI construction -----------------------------------------------------
  _buildUi() {
    const tb = (label, title, action, extra = {}) =>
      h('button.tb', { title, 'aria-label': title, onclick: () => this.dispatch(action), ...extra }, label);
    this.quickInput = h('input.quick-host', {
      placeholder: rns.enabled(this) ? 'Enter host or destination hash — user@host[:port] or <hash>' : 'Enter host — user@host[:port]', 'aria-label': 'Quick connect host',
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        // A Reticulum destination hash connects with rnsh (when Reticulum is on).
        const hash = rns.enabled(this) && rns.normalizeHash(e.target.value);
        if (hash) { this.openSession({ name: `rnsh ${rns.shortHash(hash)}`, protocol: 'rnsh', host: hash, port: 0 }); e.target.value = ''; return; }
        const m = /^(?:(ssh2?|telnet|rlogin|raw|vnc|rdp):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/i.exec(e.target.value.trim());
        if (!m) return toast('Use user@host[:port] or telnet://host', 'error');
        const protocol = (m[1] || 'ssh2').toLowerCase().replace(/^ssh$/, 'ssh2');
        const host = m[3].replace(/^\[|\]$/g, '');
        this.openSession({ name: `${m[2] ? m[2] + '@' : ''}${host}`, protocol, host, username: m[2] || '', port: Number(m[4]) || DEFAULT_PORTS[protocol] });
        e.target.value = '';
      },
    });
    this.broadcastBtn = tb(icon('broadcast'), 'Send keystrokes to all tabs', 'toggleBroadcast', { class: 'tb-broadcast' });
    this.logBtn = tb(icon('record'), 'Log session', 'toggleLog');
    const bufKey = this.platform === 'darwin' ? '⌘E' : 'Ctrl+Shift+E';
    this.bufferBtn = tb(icon('buffer'), `Command Buffer (${bufKey})`, 'toggleCommandWindow');
    // Session layout switch: tabs, or tile every session on screen at once.
    this.layoutSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Session layout' },
      LAYOUTS.map(([value, label, title]) => h('button', {
        role: 'radio', title, dataset: { layout: value },
        onclick: () => this.setLayout(value),
      }, label)));

    const toolbar = h('header.toolbar', {},
      tb(icon('sidebar'), 'Toggle Session Manager', 'toggleSessionManager'),
      tb(icon('bolt'), 'Quick Connect', 'quickConnect'),
      h('span.tb-sep'),
      tb(icon('rotate'), 'Reconnect', 'reconnect'),
      tb(icon('unplug'), 'Disconnect', 'disconnect'),
      tb(icon('copy'), 'Clone session', 'cloneTab'),
      h('span.tb-sep'),
      tb(icon('terminal'), 'New local shell', 'localShell'),
      tb(icon('transfer'), 'SFTP tab', 'sftpTab'),
      tb(icon('folderSync'), 'SCP Transfer Manager', 'scpTab'),
      h('span.tb-sep'),
      tb(icon('search'), 'Find', 'find'),
      this.logBtn,
      tb(icon('play'), 'Run script', 'runScript'),
      this.bufferBtn,
      this.broadcastBtn,
      h('span.tb-sep'),
      this.layoutSeg,
      tb(icon('expand'), 'Maximize terminal area (hide all panels)', 'focusMode'),
      h('span.tb-flex'),
      this.quickInput,
      tb(icon('sliders'), 'Session options', 'sessionOptions'),
      tb(icon('gear'), 'Settings', 'globalOptions'));

    this.smEl = h('aside.session-manager', { 'aria-label': 'Session Manager' });
    this.splitter = h('div.splitter', { title: 'Drag to resize' });
    this.tabbar = h('div.tabbar', { role: 'tablist', ondblclick: (e) => { if (e.target === this.tabbar) this.dispatch('quickConnect'); } });
    this.workspace = h('main.workspace', { class: `layout-${this.layout}` });
    this.buttonBar = h('div.button-bar', { 'aria-label': 'Button bar' });
    this.buttons = new ButtonBars(this, this.buttonBar);
    this.buffer = new CommandBuffer(this);
    this.statusBar = h('footer.status-bar', { role: 'status' });

    // Collapsed Session Manager: a slim rail at the left edge.
    this.smRail = h('button.sm-rail', {
      title: 'Show Session Manager', 'aria-label': 'Show Session Manager',
      onclick: () => this.dispatch('toggleSessionManager'),
    }, icon('chevronsRight', 16), h('span.sm-rail-label', {}, 'Sessions'));
    this.exitFocusBtn = h('button.exit-focus', {
      title: 'Restore panels', onclick: () => this.dispatch('focusMode'),
    }, '⤡ Restore panels');

    this.workRow = h('div.work-row', {}, this.workspace);
    this.center = h('div.center', {}, this.tabbar, this.workRow, this.buttonBar);
    const center = this.center;
    document.body.append(toolbar, h('div.body', {}, this.smRail, this.smEl, this.splitter, center), this.statusBar, this.exitFocusBtn);

    this.sm = new SessionManager(this, this.smEl);
    this.sm.render();
    this.placeBuffer();
    this._initSplitter();
    this.renderButtonBar();
    this.applyVisibility();
    this._syncLayoutUi();
  }

  _initSplitter() {
    let startX, startW;
    try { const w = Number(localStorage.getItem('termcraft.smWidth')); if (w) this.smEl.style.width = w + 'px'; } catch { /* storage unavailable */ }
    const move = (e) => { this.smEl.style.width = Math.max(160, Math.min(600, startW + e.clientX - startX)) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      try { localStorage.setItem('termcraft.smWidth', parseInt(this.smEl.style.width, 10)); } catch { /* storage unavailable */ }
      this.fitAll();
    };
    this.splitter.addEventListener('mousedown', (e) => {
      startX = e.clientX; startW = this.smEl.offsetWidth;
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  _showWelcome() {
    const m = this.platform === 'darwin' ? '⌘' : 'Ctrl+Shift+';
    this.welcome = h('div.welcome', {},
      h('img.welcome-logo', { src: 'assets/logo.svg', alt: '', width: 148, height: 148 }),
      h('h1', {}, 'TermCraft'),
      h('p.welcome-tag', {}, '> a craft for the command line_'),
      h('p', {}, 'SSH2 · Telnet · Rlogin · Serial · Raw TCP · Local Shell'),
      h('div.welcome-actions', {},
        h('button.primary', { onclick: () => this.dispatch('quickConnect') }, `Quick Connect  ${m}Q`),
        h('button', { onclick: () => this.sm.newSession('') }, 'New Session…'),
        h('button', { onclick: () => this.dispatch('localShell') }, `Local Shell  ${m}L`),
        h('button', { onclick: () => this.dispatch('importSshConfig') }, 'Import ~/.ssh/config')),
      h('p.hint', {}, 'Double-click a session in the Session Manager to connect. Type user@host in the toolbar box for a fast SSH connection.'));
    this.workspace.append(this.welcome);
  }

  /** The Command Buffer sits below the terminals or beside them (half and half). */
  placeBuffer() {
    const { el, splitter } = this.buffer;
    if (this.buffer.position === 'side') {
      this.workRow.append(splitter, el);
    } else {
      this.center.insertBefore(el, this.buttonBar);
      this.center.insertBefore(splitter, el);
    }
  }

  // ---- button bar ------------------------------------------------------------
  renderButtonBar() { this.buttons.render(); }

  /** Shared by the button bar and the keyboard map. */
  runKeyAction(tab, b) { return this.buttons.run(b, tab); }

  // ---- tabs ------------------------------------------------------------------
  openSession(session) {
    const Tab = { vnc: VncTab, rdp: RdpTab }[session.protocol] || TerminalTab;
    const tab = new Tab(this, session);
    this.addTab(tab);
    return tab.connect().then(() => tab);
  }

  /** SCP Transfer Manager, pre-filled with a session when one is given. */
  openScp(session = null) {
    if (session && session.protocol && session.protocol !== 'ssh2') session = null;
    const tab = new ScpTab(this, session);
    this.addTab(tab);
    if (session) tab.connect();
    return tab;
  }

  /** Run commands on many sessions in the background; results open in their own tab. */
  openBatch(opts) {
    const tab = new BatchTab(this, opts);
    this.addTab(tab);
    tab.connect();
    return tab;
  }

  runCommands(opts) { return runCommandsDialog(this, opts); }

  openTftp() {
    const existing = this.tabs.find((t) => t.kind === 'tftp');
    if (existing) return this.activate(existing);
    this.addTab(new TftpTab(this));
  }

  /** Tab color: the session's own, else the nearest folder color. */
  sessionColor(session) {
    const own = session?.terminal?.tabColor;
    if (own) return own;
    const stored = session?.id && this.tree.sessions.find((x) => x.id === session.id);
    for (let id = (stored || session)?.parent; id;) {
      const f = this.tree.folders.find((x) => x.id === id);
      if (!f) break;
      if (f.color) return f.color;
      id = f.parent;
    }
    return '';
  }

  async fileTransfer(kind) {
    const t = this.active;
    if (t?.kind !== 'terminal' || t.state !== 'connected') return toast('Connect a terminal tab first (usually the serial console)', 'warn');
    const [dir, protocol] = { xmodemSend: ['send', 'xmodem'], xmodemSend1k: ['send', 'xmodem-1k'], ymodemSend: ['send', 'ymodem'], zmodemSend: ['send', 'zmodem'], xmodemReceive: ['receive', 'xmodem'], ymodemReceive: ['receive', 'ymodem'], zmodemReceive: ['receive', 'zmodem'] }[kind];
    try { await api.xfer[dir](t.id, protocol); } catch (e) { if (!/failed|Cancel/.test(errMsg(e))) toast(errMsg(e), 'error'); }
  }

  openSftp(session) {
    if (session.protocol && session.protocol !== 'ssh2') return toast('SFTP needs an SSH2 session', 'error');
    const tab = new SftpTab(this, session);
    this.addTab(tab);
    tab.connect();
    return tab;
  }

  async connectTarget(target) {
    const s = this.tree.sessions.find((x) => x.name === target || x.id === target);
    if (s) return this.openSession(s);
    const hash = rns.enabled(this) && rns.normalizeHash(target);
    if (hash) return this.openSession({ name: `rnsh ${rns.shortHash(hash)}`, protocol: 'rnsh', host: hash, port: 0 });
    const m = /^(?:(ssh2?|telnet|rlogin|raw|vnc|rdp):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/i.exec(String(target).trim());
    if (!m) { toast(`No session named "${target}"`, 'error'); return null; }
    const protocol = (m[1] || 'ssh2').toLowerCase().replace(/^ssh$/, 'ssh2');
    return this.openSession({ name: target, protocol, host: m[3], username: m[2] || '', port: Number(m[4]) || DEFAULT_PORTS[protocol] });
  }

  addTab(tab) {
    this.welcome?.remove();
    this.welcome = null;
    this.tabs.push(tab);
    this.workspace.append(tab.el);
    this.activate(tab);
    this._layoutGrid();
  }

  activate(tab, focus = true) {
    if (!tab) return;
    const changed = this.active !== tab;
    this.active = tab;
    tab.activity = false;
    for (const t of this.tabs) t.el.classList.toggle('active', t === tab);
    this.buttons.onTabActivated(tab);
    if (changed) {
      this.renderTabs();
      requestAnimationFrame(() => { tab.fitNow(); if (focus && !isDialogOpen()) tab.focus(); });
      api.app.setMenuState({ logging: !!tab.logging, broadcast: this.broadcast });
    } else if (focus && !isDialogOpen()) {
      tab.focus();
    }
    this.updateStatus();
  }

  async closeTab(tab, force = false) {
    if (!tab) return;
    if (!force && tab.state === 'connected' && this.settings.confirmCloseConnected) {
      if (!await confirmDialog('Close Tab', `"${tab.displayTitle}" is connected. Disconnect and close it?`, 'Close')) return;
    }
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.dispose();
    if (this.active === tab) {
      this.active = null;
      this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    }
    if (!this.tabs.length) this._showWelcome();
    this._layoutGrid();
    this.renderTabs();
    this.updateStatus();
  }

  renderTabs() {
    this.tabbar.replaceChildren(...this.tabs.map((t, i) => {
      const el = h('div.tab', {
        role: 'tab', 'aria-selected': String(t === this.active), tabindex: -1,
        class: `${t === this.active ? 'active' : ''} st-${t.state}${t.activity ? ' activity' : ''}`,
        title: `${t.displayTitle} (${t.state})${t.logging ? '\nLogging: ' + t.logPath : ''}`,
        draggable: true,
        onmousedown: (e) => { if (e.button === 0) this.activate(t); },
        onauxclick: (e) => { if (e.button === 1) this.closeTab(t); },
        oncontextmenu: (e) => { e.preventDefault(); this._tabMenu(e, t); },
        ondragstart: (e) => e.dataTransfer.setData('text/x-termcraft-tab', String(i)),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          const from = Number(e.dataTransfer.getData('text/x-termcraft-tab'));
          if (Number.isNaN(from) || from === i) return;
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(i, 0, moved);
          for (const x of this.tabs) this.workspace.append(x.el);
          this.renderTabs();
          this.fitAll();
        },
      },
      h('span.dot', { 'aria-hidden': 'true' }),
      ['sftp', 'scp', 'vnc', 'rdp', 'tftp'].includes(t.kind) ? h('span.tab-kind', {}, t.kind.toUpperCase()) : null,
      t.logging ? h('span.tab-log', { title: 'Logging' }, '●') : null,
      h('span.tab-title', {}, t.displayTitle),
      h('button.tab-close', { title: 'Close tab', 'aria-label': `Close ${t.displayTitle}`, onmousedown: (e) => e.stopPropagation(), onclick: () => this.closeTab(t) }, '✕'));
      return el;
    }));
    for (const t of this.tabs) {
      t.el.querySelector('.pane-title').textContent = `${t.displayTitle} — ${t.state}`;
      const color = ['terminal', 'sftp', 'scp', 'vnc', 'rdp'].includes(t.kind) ? this.sessionColor(t.session) : '';
      t.el.style.setProperty('--tab-color', color || 'transparent');
      t.el.classList.toggle('colored', !!color);
      const tabEl = this.tabbar.children[this.tabs.indexOf(t)];
      if (tabEl && color) { tabEl.style.setProperty('--tab-color', color); tabEl.classList.add('colored'); }
      // The active tab blends into its own terminal, even when a session uses other colors.
      const bg = t.term?.options.theme?.background;
      if (tabEl && bg) { tabEl.style.setProperty('--term-bg', bg); tabEl.style.setProperty('--fg-tab', t.term.options.theme.foreground); }
    }
    document.title = this.active ? `${this.active.displayTitle} — TermCraft` : 'TermCraft';
    this.logBtn.classList.toggle('on', !!this.active?.logging);
  }

  _tabMenu(e, t) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Reconnect', action: () => t.connect() },
      { label: 'Disconnect', action: () => t.disconnect(), disabled: t.state !== 'connected' },
      ['batch', 'tftp'].includes(t.kind) ? null : { label: 'Clone Session', action: () => this.cloneTab(t) },
      t.kind === 'terminal' ? { label: 'Connect SFTP Tab', action: () => this.openSftp(t.session), disabled: t.cfg.protocol !== 'ssh2' } : null,
      t.kind === 'terminal' ? { label: 'SCP Transfer Manager', action: () => this.openScp(t.session), disabled: t.cfg.protocol !== 'ssh2' } : null,
      '-',
      { label: 'Rename Tab…', action: async () => { const { promptDialog } = await import('./dom.js'); const n = await promptDialog('Rename Tab', 'Tab name:', t.title); if (n) { t.title = n; this.renderTabs(); } } },
      t.kind === 'terminal' ? { label: t.logging ? 'Stop Logging' : 'Start Logging', action: () => this.toggleLog(t) } : null,
      ['terminal', 'vnc', 'rdp'].includes(t.kind) ? { label: 'Session Options…', action: () => this.editTabSession(t) } : null,
      '-',
      { label: 'Close', action: () => this.closeTab(t) },
      { label: 'Close Other Tabs', action: async () => { for (const x of this.tabs.filter((x) => x !== t)) await this.closeTab(x); } },
    ]);
  }

  cloneTab(t = this.active) {
    if (!t || t.kind === 'batch' || t.kind === 'tftp') return;
    if (t.kind === 'scp') this.openScp(t.session);
    else if (t.kind === 'sftp') this.openSftp(t.session);
    else this.openSession(t.session);
  }

  async editTabSession(t = this.active) {
    if (!t || !['terminal', 'vnc', 'rdp'].includes(t.kind)) return;
    const stored = t.session.id && this.tree.sessions.find((s) => s.id === t.session.id);
    const saved = await editSession(this, stored || t.session);
    if (!saved) return;
    if (!stored) t.session = saved;
    this.refreshTabsForSession(saved.id);
  }

  refreshTabsForSession(id) {
    const s = this.tree.sessions.find((x) => x.id === id);
    if (!s) return;
    for (const t of this.tabs) if (t.session.id === id) { t.session = s; t.applySettings(); }
    this.buttons.onTabActivated(this.active);
    this.renderTabs();
  }

  setLayout(mode) {
    if (!LAYOUTS.some(([v]) => v === mode)) mode = 'tabs';
    this.layout = mode;
    this._syncLayoutUi();
    this.workspace.className = `workspace layout-${mode}`;
    this._layoutGrid();
    this.saveSettings({ layout: mode }, true);
    this.fitAll();
    this.active?.focus();
  }

  _syncLayoutUi() {
    for (const b of this.layoutSeg.children) {
      const on = b.dataset.layout === this.layout;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    api.app.setMenuState({ layout: this.layout });
  }

  /** Hide every panel so terminals use the whole window; toggle again to restore. */
  toggleFocusMode() {
    this.focusMode = !this.focusMode;
    document.body.classList.toggle('focus-mode', this.focusMode);
    api.app.setMenuState({ focusMode: this.focusMode });
    this.fitAll();
    this.active?.focus();
  }

  _layoutGrid() {
    if (this.layout !== 'grid') { this.workspace.style.gridTemplateColumns = ''; return; }
    const cols = Math.ceil(Math.sqrt(this.tabs.length || 1));
    this.workspace.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  }

  fitAll() { requestAnimationFrame(() => { for (const t of this.tabs) t.fitNow(); }); }

  broadcastInput(data) {
    for (const t of this.tabs) if (t.kind === 'terminal') t.send(data);
  }

  // ---- clipboard ----------------------------------------------------------
  async paste(tab = this.active, { singleLine = false, text } = {}) {
    if (!tab || tab.kind !== 'terminal') return;
    text = text ?? await api.clipboard.read();
    if (!text) return;
    if (singleLine) text = text.replace(/\r?\n/g, ' ');
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && this.settings.confirmMultilinePaste) {
      const preview = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… (${lines.length - 12} more lines)` : '');
      const ok = await showDialog({
        title: 'Paste Multiple Lines', width: 600,
        body: h('div', {}, h('p', {}, `You are about to paste ${lines.length} lines into "${tab.displayTitle}".`), h('pre.code', {}, preview)),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Paste', value: true, primary: true }],
      });
      if (!ok) return;
    }
    const delay = Number(this.settings.pasteLineDelay) || 0;
    if (delay > 0 && lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        tab.send(lines[i] + (i < lines.length - 1 ? '\r' : ''));
        if (i < lines.length - 1) await new Promise((r) => setTimeout(r, delay));
      }
    } else {
      tab.term.paste(text);
    }
    tab.focus();
  }

  // ---- logging / scripts ------------------------------------------------------
  async toggleLog(t = this.active, chooseFile = false) {
    if (!t || t.kind !== 'terminal') return;
    if (t.state !== 'connected') return toast('Connect first to start logging', 'warn');
    await api.conn.log(t.id, chooseFile ? true : !t.logging, chooseFile);
  }

  async runScript(file) {
    const tab = this.active?.kind === 'terminal' ? this.active : null;
    const r = await api.script.run(file || null, tab?.id || null);
    if (r && !r.ok && !/Script cancelled/.test(r.error)) await alertDialog('Script Error', r.error);
  }

  async sendAsciiFile() {
    const tab = this.active;
    if (tab?.kind !== 'terminal') return;
    const f = await api.dialog.openFile({ title: 'Send ASCII File' });
    if (!f) return;
    const text = await api.file.readText(f);
    this.paste(tab, { text: text.replace(/\r?\n/g, '\n') });
  }

  // ---- settings ---------------------------------------------------------------
  async saveSettings(patch, quiet = false) {
    this.settings = await api.store.saveSettings(patch);
    this.view = this.settings;
    if (quiet) return;
    this._compile();
    this.renderButtonBar();
    this.applyVisibility();
    this.applyTheme();
    for (const t of this.tabs) t.applySettings();
  }

  async reloadTree() {
    this.tree = await api.store.tree();
    this.sm.render();
    for (const t of this.tabs) if (t.kind === 'scp') t.refreshLists();
  }

  /**
   * Apply the theme for the current appearance (Light / Dark / Auto) to the window and to every
   * terminal that matches the theme. `preview` (a settings-like object) shows a choice live.
   */
  applyTheme(preview = null) {
    this.previewPatch = preview;
    const s = preview ? { ...this.settings, ...preview } : this.settings;
    const t = currentTheme(s, matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(cssVars(t))) root.style.setProperty(k, v);
    root.style.setProperty('--term-pad', `${{ compact: 4, comfortable: 12, spacious: 20 }[s.terminalPadding] ?? 12}px`);
    root.dataset.theme = t.dark ? 'dark' : 'light';
    // Native parts follow the theme; in Auto they follow the OS, so its light/dark setting stays visible to us.
    api.app.setChrome?.({ source: appearanceOf(s).appearance === 'auto' ? 'system' : t.dark ? 'dark' : 'light', bg: t.ui.panel });
    const changed = this.theme !== t || !!preview || !!this.view?.__preview;
    this.theme = t;
    this.view = preview ? { ...s, __preview: true } : this.settings; // what terminals render with
    if (changed) {
      for (const tab of this.tabs) tab.applySettings?.();
      this.renderTabs(); // tabs take their background from their (now recolored) terminal
    }
  }

  applyVisibility() {
    const s = this.settings;
    this.smEl.hidden = !s.showSessionManager;
    this.splitter.hidden = !s.showSessionManager;
    this.smRail.hidden = !!s.showSessionManager;
    this.buttonBar.hidden = !s.showButtonBar;
    this.buffer.el.hidden = !s.showCommandWindow;
    this.bufferBtn.classList.toggle('on', !!s.showCommandWindow);
    this.buffer.splitter.hidden = !s.showCommandWindow;
    this.statusBar.hidden = !s.showStatusBar;
    this.fitAll();
  }

  toggleSetting(key) {
    this.saveSettings({ [key]: !this.settings[key] }).then(() => {
      if (key === 'showCommandWindow' && this.settings.showCommandWindow) this.buffer.focus();
      if (key === 'showSessionManager' && this.settings.showSessionManager) this.sm.filterInput.focus();
    });
  }

  updateStatus() {
    const t = this.active;
    if (!t) { this.statusBar.replaceChildren(h('span', {}, 'Ready')); return; }
    if (t.kind === 'batch' || t.kind === 'tftp') {
      this.statusBar.replaceChildren(h('span.st', { class: `st-${t.state}` }, t.kind === 'tftp' ? (t.state === 'connected' ? 'TFTP server running' : 'TFTP server stopped') : (t.state === 'connecting' ? 'Running commands' : 'Commands finished')));
      return;
    }
    const cfg = t.cfg || this.effectiveSession(t.session);
    const parts = [];
    parts.push(h('span.st', { class: `st-${t.state}` }, t.state[0].toUpperCase() + t.state.slice(1)));
    parts.push(h('span', {}, t.kind === 'sftp' || t.kind === 'scp' ? t.kind.toUpperCase() : PROTOCOL_LABEL[cfg.protocol] || cfg.protocol));
    if (t.status?.via) parts.push(h('span', {}, `via ${t.status.via}`));
    const target = t.kind === 'scp' ? (t.info ? `${t.info.username}@${t.info.host}:${t.info.port}${t.info.via ? ` via ${t.info.via}` : ''}` : 'not connected')
      : cfg.protocol === 'serial' ? `${cfg.serial?.path} ${cfg.serial?.baudRate} ${cfg.serial?.dataBits}${(cfg.serial?.parity || 'n')[0].toUpperCase()}${cfg.serial?.stopBits}`
      : cfg.protocol === 'local' ? (t.status.shell || 'local shell')
      : cfg.protocol === 'rnsh' ? `<${cfg.host}>`
      : cfg.protocol === 'rntool' ? (t.status.shell || 'Reticulum')
        : `${t.username || cfg.username ? (t.username || cfg.username) + '@' : ''}${cfg.host}:${cfg.port}`;
    parts.push(h('span', {}, target));
    if (t.status.cipher) parts.push(h('span', { title: `KEX ${t.status.kex}\nHost key ${t.status.hostKey}\nMAC ${t.status.mac}\nCompression ${t.status.compress}` }, t.status.cipher));
    if (t.kind === 'terminal') {
      parts.push(h('span', {}, `${t.term.cols}×${t.term.rows}`));
      parts.push(h('span', {}, cfg.terminal.termType));
    }
    if (t.logging) parts.push(h('span.st-log', { title: t.logPath }, '● Logging'));
    if (this.broadcast) parts.push(h('span.st-bcast', {}, '⇶ Broadcast'));
    parts.push(h('span.tb-flex'));
    if (t.connectedAt && t.state === 'connected') parts.push(h('span', {}, fmtDuration(Date.now() - t.connectedAt)));
    this.statusBar.replaceChildren(...parts);
  }

  // ---- menu / toolbar actions ------------------------------------------------
  async dispatch(action, arg) {
    const t = this.active;
    const term = t?.kind === 'terminal' ? t : null;
    // Edit actions apply to focused form fields when one has focus.
    const field = document.activeElement;
    const inField = field && /^(INPUT|TEXTAREA)$/.test(field.tagName) && !field.classList.contains('xterm-helper-textarea');
    if (action.startsWith('layout:')) return this.setLayout(action.slice(7));
    switch (action) {
      case 'quickConnect': return quickConnect(this);
      case 'connectDialog':
        if (!this.settings.showSessionManager) await this.saveSettings({ showSessionManager: true });
        return this.sm.filterInput.focus();
      case 'localShell': return this.openSession({ name: 'Local Shell', protocol: 'local' });
      case 'sftpTab': {
        if (t && t.kind === 'terminal' && t.cfg.protocol === 'ssh2') return this.openSftp(t.session);
        const sel = this.sm.selected?.kind === 'session' && this.tree.sessions.find((s) => s.id === this.sm.selected.id);
        if (sel?.protocol === 'ssh2') return this.openSftp(sel);
        return toast('Select an SSH2 session or tab first', 'warn');
      }
      case 'scpTab': {
        if (t?.kind === 'terminal' && t.cfg.protocol === 'ssh2') return this.openScp(t.session);
        const sel = this.sm.selected?.kind === 'session' && this.tree.sessions.find((s) => s.id === this.sm.selected.id);
        return this.openScp(sel?.protocol === 'ssh2' ? sel : null);
      }
      case 'cloneTab': return this.cloneTab();
      case 'reconnect': return t?.connect();
      case 'reconnectAll': return this.tabs.forEach((x) => x.state !== 'connected' && x.connect());
      case 'disconnect': return t?.disconnect();
      case 'disconnectAll': return this.tabs.forEach((x) => x.disconnect());
      case 'closeTab': return this.closeTab(t);
      case 'toggleLog': return this.toggleLog();
      case 'logAs': return this.toggleLog(t, true);
      case 'copy':
        if (inField) return document.execCommand('copy');
        return term?.copy();
      case 'paste':
        if (inField) return document.execCommand('insertText', false, await api.clipboard.read());
        return this.paste();
      case 'copyPaste': term?.copy(); return this.paste();
      case 'pasteSingle': return this.paste(t, { singleLine: true });
      case 'selectAll':
        if (inField) return field.select();
        return term?.term.selectAll();
      case 'find': return term?.showFind();
      case 'clearScrollback': return term?.term.clear();
      case 'clearScreen': return term?.term.write('\x1b[H\x1b[2J');
      case 'clearAll': term?.term.write('\x1b[H\x1b[2J'); return term?.term.clear();
      case 'resetTerminal': return term?.term.reset();
      case 'sendBreak': return term && api.conn.sendBreak(term.id);
      case 'toggleSessionManager': return this.toggleSetting('showSessionManager');
      case 'toggleButtonBar': return this.toggleSetting('showButtonBar');
      case 'toggleCommandWindow': return this.toggleSetting('showCommandWindow');
      case 'toggleStatusBar': return this.toggleSetting('showStatusBar');
      case 'focusMode': return this.toggleFocusMode();
      case 'fontBigger': this.fontDelta++; return this.tabs.forEach((x) => x.applySettings());
      case 'fontSmaller': this.fontDelta--; return this.tabs.forEach((x) => x.applySettings());
      case 'fontReset': this.fontDelta = 0; return this.tabs.forEach((x) => x.applySettings());
      case 'sessionOptions': return this.editTabSession();
      case 'globalOptions': return globalOptions(this);
      case 'editButtons': return globalOptions(this, 'Button Bars');
      case 'editHighlights': return globalOptions(this, 'Keyword Highlighting');
      case 'editKeymap': return globalOptions(this, 'Keyboard Map');
      case 'toggleBroadcast':
        this.broadcast = !this.broadcast;
        this.broadcastBtn.classList.toggle('on', this.broadcast);
        document.body.classList.toggle('broadcasting', this.broadcast);
        api.app.setMenuState({ broadcast: this.broadcast });
        toast(this.broadcast ? 'Keystrokes now go to ALL tabs' : 'Broadcast off', this.broadcast ? 'warn' : 'info');
        return this.updateStatus();
      case 'sendAscii': return this.sendAsciiFile();
      case 'xmodemSend': case 'xmodemSend1k': case 'ymodemSend': case 'zmodemSend': case 'xmodemReceive': case 'ymodemReceive': case 'zmodemReceive': return this.fileTransfer(action);
      case 'saveOutput': return term?.saveOutput();
      case 'tftpServer': return this.openTftp();
      case 'runCommands': return this.runCommands(this.sm.selected?.kind === 'folder' ? { folderId: this.sm.selected.id } : { sessionIds: [this.sm.selected?.kind === 'session' ? this.sm.selected.id : t?.session?.id].filter(Boolean) });
      case 'manageCredentials': return credentialsDialog(this);
      case 'importHosts': return importHostsDialog(this, this.sm.currentFolder());
      case 'sshKeys': return sshKeysDialog(this);
      case 'installKey': {
        const s = (t?.kind === 'terminal' && t.cfg.protocol === 'ssh2' && t.session) || (this.sm.selected?.kind === 'session' && this.tree.sessions.find((x) => x.id === this.sm.selected.id));
        if (s?.protocol !== 'ssh2') return toast('Select an SSH2 session or tab first', 'warn');
        return installKeyDialog(this, s);
      }
      case 'runScript': return this.runScript(arg);
      case 'cancelScripts': return api.script.cancel();
      case 'openExamples': return api.app.openPath(await api.script.examplesDir());
      case 'knownHosts': return knownHostsDialog();
      case 'importSshConfig': {
        try {
          const n = await api.store.importSshConfig();
          await this.reloadTree();
          return toast(n ? `Imported ${n} hosts into "SSH Config"` : 'No hosts found in ~/.ssh/config');
        } catch (e) { return toast(`Import failed: ${e.message}`, 'error'); }
      }
      case 'importSessions': {
        const r = await api.store.importSessions();
        if (r == null) return;
        await this.reloadTree();
        toast(`Imported ${r.count} sessions`);
        if (r.cleared) toast(`For safety, logon scripts and local shell commands were removed from ${r.cleared} imported session(s). Review them in Session Options.`, 'warn', 8000);
        return;
      }
      case 'exportSessions': {
        const withSecrets = await showDialog({
          title: 'Export Sessions', body: h('p', {}, 'Include saved passwords and passphrases in plain text? Only do this if the file will be stored securely.'),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Include Passwords', value: 'yes', danger: true }, { label: 'Without Passwords', value: 'no', primary: true }],
        });
        if (!withSecrets) return;
        const f = await api.store.exportSessions(withSecrets === 'yes');
        if (f) toast(`Exported to ${f}`);
        return;
      }
      case 'openLogFolder': return api.app.openPath('~/TermCraft Logs');
      // Reticulum (Tools → Reticulum and the Transfer menu, when turned on in Settings).
      case 'rnsConnect': return rns.rnshConnect(this);
      case 'rnsExec': return rns.rnsExec(this);
      case 'rnsProbe': return rns.rnsProbe(this);
      case 'rnsPath': return rns.rnsPath(this);
      case 'rnsPaths': return rns.rnsPaths(this);
      case 'rnsStatus': return rns.rnsStatus(this);
      case 'rnsIdentity': return rns.rnsIdentity(this);
      case 'rnsSend': return rns.rnsSend(this);
      case 'rnsFetch': return rns.rnsFetch(this);
      case 'nextTab': case 'prevTab': {
        if (!this.tabs.length) return;
        const i = this.tabs.indexOf(t);
        return this.activate(this.tabs[(i + (action === 'nextTab' ? 1 : -1) + this.tabs.length) % this.tabs.length]);
      }
      case 'scriptHelp': return scriptHelp();
      case 'shortcuts': return shortcutsHelp(this.platform);
      case 'about': return aboutDialog();
      case 'license': return licenseDialog();
      default: console.warn('Unknown action', action);
    }
  }

  // ---- requests from main (prompts, scripts) ----------------------------------
  async onRequest(type, p) {
    switch (type) {
      case 'prompt': return handlePrompt(this, p);
      case 'orderFiles': return orderFilesDialog(this, p);
      case 'confirmClose': {
        const n = this.tabs.filter((t) => t.state === 'connected').length;
        if (!n || !this.settings.confirmCloseConnected) return true;
        return confirmDialog('Quit TermCraft', `${n} session${n > 1 ? 's are' : ' is'} still connected. Disconnect and quit?`, 'Quit');
      }
      case 'tabs': return this.tabs.filter((t) => t.kind === 'terminal').map((t) => ({ tabId: t.id, caption: t.displayTitle }));
      case 'activeTab': return this.active?.id || null;
      case 'tabInfo': { const t = this.tabById(p.tabId); return t ? { caption: t.displayTitle, state: t.state } : null; }
      case 'activateTab': return this.activate(this.tabById(p.tabId));
      case 'screenText': return this.tabById(p.tabId)?.screenLines() || [];
      case 'cursor': {
        const t = this.tabById(p.tabId);
        if (!t) return null;
        const b = t.term.buffer.active;
        return { row: b.cursorY + 1, col: b.cursorX + 1 };
      }
      case 'clearScreen': return this.tabById(p.tabId)?.term.write('\x1b[H\x1b[2J');
      case 'reconnectTab': return this.tabById(p.tabId)?.connect();
      case 'connectSession': {
        const tab = await this.connectTarget(p.target);
        return tab?.state === 'connected' ? tab.id : null;
      }
      case 'openFile': return api.dialog.openFile({ title: p.title });
      default: return null;
    }
  }
}

const app = new App();
window.termcraft = app;
app.init().catch((e) => {
  console.error(e);
  document.body.append(h('pre.fatal', {}, `TermCraft failed to start:\n${e.stack || e}`));
});
