// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { SearchAddon } from '../../../node_modules/@xterm/addon-search/lib/addon-search.mjs';
import { WebLinksAddon } from '../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { Unicode11Addon } from '../../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { h, contextMenu } from './dom.js';
import { getScheme } from './schemes.js';
import { applyHighlights } from './highlight.js';

let seq = 0;

/** Build a key-combo string like "Ctrl+Shift+F5" from a KeyboardEvent. */
export function comboOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) parts.push(k);
  return parts.join('+');
}

export class TerminalTab {
  /**
   * @param {object} app      the App controller
   * @param {object} session  sanitized stored session (has id) or ad-hoc session object
   */
  constructor(app, session) {
    this.app = app;
    this.kind = 'terminal';
    this.id = `t${++seq}-${Date.now().toString(36)}`;
    this.session = session;
    this.cfg = app.effectiveSession(session);
    this.title = session.name || session.host || 'Session';
    this.remoteTitle = '';
    this.state = 'idle';
    this.status = {};
    this.logging = false;
    this.activity = false;
    this.reconnectTimer = null;
    this.lastSize = '';

    this.el = h('div.pane', { dataset: { tab: this.id } });
    this.termEl = h('div.term-host');
    this.banner = h('div.pane-banner', { hidden: true });
    this.findBar = this._buildFindBar();
    this.titleEl = h('div.pane-title', {}, this.title);
    this.el.append(this.titleEl, this.findBar, this.termEl, this.banner);
    this.el.addEventListener('mousedown', () => app.activate(this));

    this._createTerminal();
  }

  get ref() { return this.session.id || this.session; }
  get displayTitle() { return (this.cfg.terminal.useRemoteTitle && this.remoteTitle) || this.title; }

  _createTerminal() {
    const settings = this.app.settings;
    const t = this.cfg.terminal;
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: t.fontFamily || settings.fontFamily,
      fontSize: t.fontSize || settings.fontSize,
      scrollback: Number(t.scrollback) || 10000,
      cursorStyle: t.cursorStyle || 'block',
      cursorBlink: t.cursorBlink !== false,
      theme: getScheme(t.colorScheme, this.app.theme),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
      // OSC 8 hyperlinks come from the remote side: only http(s), only on Cmd/Ctrl+click.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (e, uri) => { if ((e.ctrlKey || e.metaKey) && /^https?:\/\//i.test(uri)) window.api.app.openExternal(uri); },
      },
    });
    this.term = term;
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    term.loadAddon(this.fit);
    term.loadAddon(this.search);
    term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) window.api.app.openExternal(uri); }));
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
    term.open(this.termEl);
    this.el.style.background = term.options.theme.background; // fill the padding around the terminal

    term.onData((data) => this._onInput(data));
    term.onBinary((data) => this._onInput(data));
    term.onTitleChange((title) => { this.remoteTitle = title; this.app.renderTabs(); });
    term.onBell(() => { if (this.app.active !== this) { this.activity = true; this.app.renderTabs(); } });
    term.onSelectionChange(() => {
      if (this.app.settings.copyOnSelect && term.hasSelection()) window.api.clipboard.write(term.getSelection());
    });
    term.textarea?.addEventListener('focus', () => this.app.activate(this, false));

    term.attachCustomKeyEventHandler((e) => this._onKey(e));
    this.termEl.addEventListener('contextmenu', (e) => this._onContextMenu(e));

    this.resizeObs = new ResizeObserver(() => this.fitNow());
    this.resizeObs.observe(this.termEl);
  }

  _onKey(e) {
    if (e.type !== 'keydown') return true;
    const combo = comboOf(e);
    const mapping = this.app.keymap.get(combo);
    if (mapping != null) {
      e.preventDefault();
      this.app.runKeyAction(this, mapping);
      return false;
    }
    // Reconnect on Enter when disconnected.
    if (e.key === 'Enter' && (this.state === 'disconnected' || this.state === 'failed')) {
      this.connect();
      return false;
    }
    // Let platform copy/paste shortcuts through to the menu instead of the terminal.
    const isMac = this.app.platform === 'darwin';
    if (isMac && e.metaKey) return false;
    if (!isMac && e.ctrlKey && e.shiftKey && e.key === 'Enter') return false; // maximize terminal area
    if (!isMac && e.ctrlKey && e.shiftKey && ['C', 'V', 'F', 'T', 'W', 'D', 'K', 'Q', 'O', 'L', 'P', 'U', 'S', 'B', 'E', 'M', 'R', 'J', 'A'].includes(e.key.toUpperCase())) return false;
    return true;
  }

  _onInput(data) {
    if (this.cfg.terminal.backspace === 'bs') data = data.replace(/\x7f/g, '\b');
    if (this.app.broadcast) this.app.broadcastInput(data, this);
    else this.send(data);
  }

  /** Send raw data to this tab's connection. */
  send(data) {
    if (this.state === 'connected') window.api.conn.write(this.id, data);
  }

  _onContextMenu(e) {
    e.preventDefault();
    if (this.app.settings.rightClickPaste && !e.shiftKey) {
      if (this.term.hasSelection() && !this.app.settings.copyOnSelect) {
        window.api.clipboard.write(this.term.getSelection());
        this.term.clearSelection();
      } else {
        this.app.paste(this);
      }
      return;
    }
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', action: () => this.copy(), disabled: !this.term.hasSelection() },
      { label: 'Paste', action: () => this.app.paste(this) },
      { label: 'Copy and Paste', action: () => { this.copy(); this.app.paste(this); }, disabled: !this.term.hasSelection() },
      { label: 'Select All', action: () => this.term.selectAll() },
      '-',
      { label: 'Find…', action: () => this.showFind() },
      { label: 'Clear Scrollback', action: () => this.term.clear() },
      '-',
      { label: 'Reconnect', action: () => this.connect() },
      { label: 'Disconnect', action: () => this.disconnect(), disabled: this.state !== 'connected' },
      { label: 'Session Options…', action: () => this.app.editTabSession(this) },
    ]);
  }

  copy() {
    if (this.term.hasSelection()) window.api.clipboard.write(this.term.getSelection());
  }

  fitNow() {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    try { this.fit.fit(); } catch { return; }
    const size = `${this.term.cols}x${this.term.rows}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      window.api.conn.resize(this.id, this.term.cols, this.term.rows);
      if (this.app.active === this) this.app.updateStatus();
    }
  }

  focus() { this.term.focus(); }

  async connect() {
    clearTimeout(this.reconnectTimer);
    this.banner.hidden = true;
    this.fitNow();
    try {
      await window.api.conn.open(this.id, this.ref, this.term.cols, this.term.rows);
    } catch (err) {
      this.write(`\r\n\x1b[31m[TermCraft] ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
      this.onState({ state: 'failed', error: err.message });
    }
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    window.api.conn.close(this.id);
  }

  write(data) {
    this.term.write(applyHighlights(data, this.app.highlights));
    if (this.app.active !== this && this.app.settings.tabActivityIndicator && !this.activity) {
      this.activity = true;
      this.app.renderTabs();
    }
  }

  onState(st) {
    this.state = st.state;
    if (st.connectedAt) this.connectedAt = st.connectedAt;
    if (st.username) this.username = st.username;
    if (st.state === 'connecting') this.term.write(`\x1b[90m[TermCraft] Connecting to ${st.target}...\x1b[0m\r\n`);
    if (st.state === 'connected') { this.banner.hidden = true; this.fitNow(); }
    if (st.state === 'disconnected' || st.state === 'failed') {
      this.connectedAt = null;
      this.logging = false;
      this._showBanner(st.reconnect);
    }
    this.app.renderTabs();
    if (this.app.active === this) this.app.updateStatus();
  }

  _showBanner(reconnectDelay) {
    const msg = reconnectDelay ? `Disconnected — reconnecting in ${reconnectDelay}s…` : 'Disconnected — press Enter to reconnect';
    this.banner.replaceChildren(...[
      h('span', {}, msg),
      h('button.small', { onclick: () => this.connect() }, 'Reconnect'),
      reconnectDelay ? h('button.small', { onclick: () => { clearTimeout(this.reconnectTimer); this._showBanner(0); } }, 'Cancel') : null,
      h('button.small', { onclick: () => this.app.closeTab(this) }, 'Close tab'),
    ].filter(Boolean)); // replaceChildren() would render null as the text "null"
    this.banner.hidden = false;
    if (reconnectDelay) this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelay * 1000);
  }

  // ---- find bar ----
  _buildFindBar() {
    this.findInput = h('input', { type: 'search', placeholder: 'Find in scrollback', 'aria-label': 'Find in scrollback' });
    this.findCase = h('input', { type: 'checkbox', 'aria-label': 'Match case' });
    this.findRegex = h('input', { type: 'checkbox', 'aria-label': 'Regular expression' });
    const opts = () => ({
      caseSensitive: this.findCase.checked, regex: this.findRegex.checked,
      decorations: { matchBackground: '#665c00', activeMatchBackground: '#d19a00', matchOverviewRuler: '#d19a00', activeMatchColorOverviewRuler: '#ff0000' },
    });
    const next = () => this.search.findNext(this.findInput.value, opts());
    const prev = () => this.search.findPrevious(this.findInput.value, opts());
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); (e.shiftKey ? prev : next)(); }
      if (e.key === 'Escape') { e.preventDefault(); this.hideFind(); }
    });
    this.findInput.addEventListener('input', next);
    return h('div.find-bar', { hidden: true },
      this.findInput,
      h('label.check', {}, this.findCase, 'Aa'),
      h('label.check', {}, this.findRegex, '.*'),
      h('button.icon-btn', { title: 'Previous (Shift+Enter)', 'aria-label': 'Previous match', onclick: prev }, '↑'),
      h('button.icon-btn', { title: 'Next (Enter)', 'aria-label': 'Next match', onclick: next }, '↓'),
      h('button.icon-btn', { title: 'Close (Esc)', 'aria-label': 'Close find', onclick: () => this.hideFind() }, '✕'));
  }

  showFind() {
    this.findBar.hidden = false;
    const sel = this.term.getSelection();
    if (sel && !sel.includes('\n')) this.findInput.value = sel;
    this.findInput.focus();
    this.findInput.select();
  }

  hideFind() {
    this.findBar.hidden = true;
    this.search.clearDecorations();
    this.focus();
  }

  /** Visible screen text as an array of lines (for scripts). */
  screenLines() {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < this.term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    return lines;
  }

  applySettings() {
    this.cfg = this.app.effectiveSession(this.session);
    const t = this.cfg.terminal;
    const s = this.app.settings;
    this.term.options.theme = getScheme(t.colorScheme, this.app.theme);
    this.el.style.background = this.term.options.theme.background;
    this.term.options.fontFamily = t.fontFamily || s.fontFamily;
    this.term.options.fontSize = (t.fontSize || s.fontSize) + (this.app.fontDelta || 0);
    this.term.options.cursorStyle = t.cursorStyle || 'block';
    this.term.options.cursorBlink = t.cursorBlink !== false;
    this.term.options.scrollback = Number(t.scrollback) || 10000;
    this.title = this.session.name || this.session.host || this.title;
    this.titleEl.textContent = this.title;
    this.fitNow();
  }

  dispose() {
    clearTimeout(this.reconnectTimer);
    this.resizeObs.disconnect();
    window.api.conn.close(this.id);
    this.term.dispose();
    this.el.remove();
  }
}
