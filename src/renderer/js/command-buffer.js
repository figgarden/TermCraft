// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// The Command Buffer: prepare commands before they reach a device.
//  - Command mode (SecureCRT style): a strip under the terminal; Enter sends, ↑/↓ recall history.
//  - Script mode (WinFIOL style): an editor beside the terminal; ⌘/Ctrl+Enter sends the current line
//    and moves to the next, or send a selection / the whole script, pausing for the device's prompt.
import { h, toast } from './dom.js';
import { icon } from './icons.js';

const PROMPT_RE = /[#>$%\]:]\s?$/;
const PACES = [['prompt', 'Wait for prompt'], ['0', 'No pause'], ['250', '0.25 s'], ['1000', '1 s'], ['3000', '3 s']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function storageGet(key, def = '') { try { return localStorage.getItem(key) ?? def; } catch { return def; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

export class CommandBuffer {
  constructor(app) {
    this.app = app;
    this.history = [];
    this.histIdx = -1;
    this.running = null; // { stop: boolean }
    this._build();
  }

  get settings() { return this.app.settings; }
  get mode() { return this.settings.bufferMode === 'script' ? 'script' : 'command'; }
  get position() { return this.settings.bufferPosition === 'side' ? 'side' : 'bottom'; }

  _build() {
    const seg = (options, value, onPick, label) => h('div.segmented.cb-seg', { role: 'radiogroup', 'aria-label': label },
      options.map(([v, text, ic]) => h('button', { type: 'button', role: 'radio', dataset: { v }, title: text, onclick: () => onPick(v) }, ic ? icon(ic, 14) : null, h('span', {}, text))));
    this.modeSeg = seg([['command', 'Command'], ['script', 'Script']], this.mode, (v) => this.setMode(v), 'Buffer mode');
    this.posSeg = seg([['bottom', 'Below'], ['side', 'Beside']], this.position, (v) => this.setPosition(v), 'Buffer position');
    this.target = h('select', { 'aria-label': 'Send to', title: 'Send to', onchange: () => this.target.classList.toggle('to-all', this.target.value === 'all') },
      h('option', { value: 'current' }, 'Current tab'), h('option', { value: 'visible' }, 'Visible tabs'), h('option', { value: 'all' }, 'All tabs'));
    this.pace = h('select', { 'aria-label': 'Between lines', title: 'Between lines', onchange: () => storageSet('termcraft.buffer.pace', this.pace.value) },
      PACES.map(([v, l]) => h('option', { value: v }, l)));
    this.pace.value = storageGet('termcraft.buffer.pace', 'prompt');

    this.editor = h('textarea.cb-editor', {
      spellcheck: false, wrap: 'off', 'aria-label': 'Command buffer',
      onkeydown: (e) => this._onKey(e),
      oninput: () => { this._saveSoon(); this._renderGutter(); },
      onscroll: () => { this.gutter.scrollTop = this.editor.scrollTop; },
      onclick: () => this._renderGutter(), onkeyup: () => this._renderGutter(),
    });
    this.editor.value = this.settings.bufferText || '';
    this.gutter = h('div.cb-gutter', { 'aria-hidden': 'true' });
    this.status = h('span.cb-status', { role: 'status' });
    this.stopBtn = h('button.small.danger', { hidden: true, onclick: () => this.stop() }, 'Stop');

    const scriptOnly = (...els) => els.map((el) => { el.classList.add('cb-script-only'); return el; });
    // Two rows: what and where (mode, target, pace, position), then actions (script mode).
    this.el = h('section.command-buffer', { 'aria-label': 'Command Buffer' },
      h('div.cb-head', {},
        h('strong.cb-title', {}, 'Buffer'),
        this.modeSeg,
        h('label.cb-field', {}, h('span', {}, 'to'), this.target),
        ...scriptOnly(h('label.cb-field', {}, h('span', {}, 'pace'), this.pace)),
        h('span.tb-flex'),
        this.posSeg,
        h('button.icon-btn', { title: 'Hide the buffer', 'aria-label': 'Hide the Command Buffer', onclick: () => this.app.dispatch('toggleCommandWindow') }, icon('close', 16))),
      ...scriptOnly(h('div.cb-actions', {},
        h('button.small', { title: 'Send the line at the cursor and move to the next (⌘/Ctrl+Enter)', onclick: () => this.sendLine() }, 'Send Line'),
        h('button.small', { title: 'Send the selected lines (⇧⌘/Ctrl+Shift+Enter)', onclick: () => this.sendSelection() }, 'Send Selection'),
        h('button.small.primary', { title: 'Send the whole buffer, line by line', onclick: () => this.sendAll() }, 'Send All'),
        this.stopBtn,
        this.status,
        h('span.tb-flex'),
        h('button.icon-btn', { title: 'Open a command file', 'aria-label': 'Open a command file', onclick: () => this.open() }, icon('folderOpen', 16)),
        h('button.icon-btn', { title: 'Save as a command file', 'aria-label': 'Save as a command file', onclick: () => this.save() }, icon('save', 16)))),
      h('div.cb-body', {}, this.gutter, this.editor));
    this.splitter = h('div.cb-splitter', { title: 'Drag to resize', role: 'separator' });
    this._initSplitter();
    this.apply();
  }

  /** Reflect mode/position settings in the DOM. */
  apply() {
    const { mode, position } = this;
    this.el.className = `command-buffer cb-${mode} cb-${position}`;
    this.splitter.className = `cb-splitter cb-splitter-${position}`;
    for (const [segEl, v] of [[this.modeSeg, mode], [this.posSeg, position]]) {
      for (const b of segEl.children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    }
    this.editor.placeholder = mode === 'command'
      ? 'Type a command and press Enter to send it. Shift+Enter adds a line. ↑/↓ recall earlier commands.'
      : 'Prepare commands here, one per line. ⌘/Ctrl+Enter sends the line at the cursor and moves to the next. Lines can wait for the device prompt.';
    const size = position === 'side' ? Number(this.settings.bufferWidth) || 0 : Number(this.settings.bufferHeight) || 0;
    this.el.style.width = position === 'side' ? (size ? `${size}px` : '50%') : '';
    this.el.style.height = position === 'bottom' ? (size ? `${size}px` : `max(76px, ${mode === 'script' ? 22 : 7}vh)`) : '';
    this._renderGutter();
  }

  async setMode(mode) { await this.app.saveSettings({ bufferMode: mode, ...(mode === 'script' && this.position === 'bottom' && !this.settings.bufferPositionChosen ? { bufferPosition: 'side' } : {}) }, true); this.app.placeBuffer(); this.apply(); this.app.fitAll(); this.editor.focus(); }
  async setPosition(pos) { await this.app.saveSettings({ bufferPosition: pos, bufferPositionChosen: true }, true); this.app.placeBuffer(); this.apply(); this.app.fitAll(); }

  _initSplitter() {
    let start; let startSize;
    const move = (e) => {
      if (this.position === 'side') {
        const w = Math.max(240, Math.min(window.innerWidth * 0.75, startSize - (e.clientX - start)));
        this.el.style.width = `${w}px`;
      } else {
        const hgt = Math.max(56, Math.min(window.innerHeight * 0.7, startSize - (e.clientY - start)));
        this.el.style.height = `${hgt}px`;
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing', 'resizing-v');
      const patch = this.position === 'side' ? { bufferWidth: this.el.offsetWidth } : { bufferHeight: this.el.offsetHeight };
      this.app.saveSettings(patch, true);
      this.app.fitAll();
    };
    this.splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      start = this.position === 'side' ? e.clientX : e.clientY;
      startSize = this.position === 'side' ? this.el.offsetWidth : this.el.offsetHeight;
      document.body.classList.add('resizing', this.position === 'side' ? 'resizing' : 'resizing-v');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    this.splitter.addEventListener('dblclick', () => { this.app.saveSettings(this.position === 'side' ? { bufferWidth: 0 } : { bufferHeight: 0 }, true).then(() => { this.apply(); this.app.fitAll(); }); });
  }

  _saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.app.saveSettings({ bufferText: this.editor.value.slice(0, 1e6) }, true), 800);
  }

  _renderGutter() {
    if (this.mode !== 'script') return;
    const lines = this.editor.value.split('\n').length;
    const cur = this._lineAt(this.editor.selectionStart).index;
    if (this.gutter.childElementCount !== lines || this.gutterCur !== cur || this.gutterSending !== this.sendingLine) {
      this.gutter.replaceChildren(...Array.from({ length: lines }, (_, i) => h('div', { class: `${i === cur ? 'cur' : ''}${i === this.sendingLine ? ' sending' : ''}` }, String(i + 1))));
      this.gutterCur = cur;
      this.gutterSending = this.sendingLine;
    }
    this.gutter.scrollTop = this.editor.scrollTop;
  }

  // ---- keyboard ----------------------------------------------------------------------------
  _onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && this.running) { e.preventDefault(); this.stop(); return; }
    if (this.mode === 'command') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendCommand(); return; }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !this.editor.value.includes('\n')) { e.preventDefault(); this._hist(e.key === 'ArrowUp' ? 1 : -1); }
      return;
    }
    if (e.key === 'Enter' && mod && e.shiftKey) { e.preventDefault(); this.sendSelection(); return; }
    if (e.key === 'Enter' && mod) { e.preventDefault(); this.sendLine(); return; }
    if (e.key === 'Tab' && !mod) { // indent with spaces instead of leaving the editor
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  }

  _hist(dir) {
    if (!this.history.length) return;
    this.histIdx = Math.max(-1, Math.min(this.history.length - 1, this.histIdx + dir));
    this.editor.value = this.histIdx < 0 ? '' : this.history[this.histIdx];
  }

  // ---- targets & sending ---------------------------------------------------------------------
  targets() {
    const mode = this.target.value;
    const terms = this.app.tabs.filter((t) => t.kind === 'terminal' && t.state === 'connected');
    if (mode === 'all') return terms;
    if (mode === 'visible') return this.app.layout === 'tabs' ? terms.filter((t) => t === this.app.active) : terms;
    return this.app.active?.kind === 'terminal' && this.app.active.state === 'connected' ? [this.app.active] : [];
  }

  /** Command mode: send the whole text (each line followed by Enter) and clear it. */
  sendCommand() {
    const text = this.editor.value;
    const targets = this.targets();
    if (!targets.length) return this._say('Connect a terminal first', true);
    if (text.trim()) { this.history.unshift(text); this.history = this.history.slice(0, 200); }
    this.histIdx = -1;
    for (const t of targets) t.send(text.replace(/\r?\n/g, '\r') + '\r');
    this.editor.value = '';
    this._saveSoon();
  }

  _lineAt(pos) {
    const v = this.editor.value;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos);
    if (end < 0) end = v.length;
    return { start, end, text: v.slice(start, end), index: v.slice(0, start).split('\n').length - 1 };
  }

  /** Send the line at the cursor and step to the next one (WinFIOL style). */
  async sendLine() {
    if (this.running) return;
    const line = this._lineAt(this.editor.selectionStart);
    const next = Math.min(this.editor.value.length, line.end + 1);
    this.editor.setSelectionRange(next, next);
    await this._run([{ text: line.text, index: line.index }]);
  }

  async sendSelection() {
    const { selectionStart: a, selectionEnd: b } = this.editor;
    if (a === b) return this.sendLine();
    const first = this._lineAt(a);
    const last = this._lineAt(Math.max(a, b - 1));
    await this._run(this._lines(first.start, last.end, first.index));
  }

  async sendAll() { await this._run(this._lines(0, this.editor.value.length, 0)); }

  _lines(from, to, firstIndex) {
    return this.editor.value.slice(from, to).split('\n').map((text, i) => ({ text, index: firstIndex + i }));
  }

  /** Send lines one at a time, pausing between them as chosen. */
  async _run(lines) {
    if (this.running) return;
    const targets = this.targets();
    if (!targets.length) return this._say('Connect a terminal first', true);
    const run = { stop: false };
    this.running = run;
    this.stopBtn.hidden = false;
    this.editor.classList.add('sending');
    const pace = this.pace.value;
    try {
      for (let i = 0; i < lines.length && !run.stop; i++) {
        this.sendingLine = lines[i].index;
        this._renderGutter();
        this._say(lines.length > 1 ? `Sending line ${i + 1} of ${lines.length}` : `Sent line ${lines[i].index + 1}`);
        for (const t of targets) { t.lastOutputAt = Date.now(); t.send(lines[i].text + '\r'); }
        if (i === lines.length - 1) break;
        if (pace === 'prompt') await Promise.all(targets.map((t) => this._waitPrompt(t, run)));
        else await sleep(Number(pace) || 0);
      }
      this._say(run.stop ? 'Stopped' : lines.length > 1 ? `Sent ${lines.length} lines` : this.status.textContent);
    } finally {
      this.running = null;
      this.sendingLine = null;
      this.stopBtn.hidden = true;
      this.editor.classList.remove('sending');
      this._renderGutter();
    }
  }

  /** Wait until the tab's output has been quiet briefly and its cursor line looks like a prompt. */
  async _waitPrompt(tab, run, timeoutMs = 60000) {
    const start = Date.now();
    await sleep(150);
    while (!run.stop && Date.now() - start < timeoutMs) {
      if (tab.state !== 'connected') return;
      const quiet = Date.now() - (tab.lastOutputAt || 0) > 350;
      if (quiet && PROMPT_RE.test(tab.cursorLine().trimEnd())) return;
      await sleep(80);
    }
  }

  stop() { if (this.running) { this.running.stop = true; this._say('Stopping…'); } }

  _say(msg, warn = false) {
    this.status.textContent = msg;
    this.status.classList.toggle('warn', warn);
    clearTimeout(this.sayTimer);
    if (!this.running) this.sayTimer = setTimeout(() => { if (!this.running) this.status.textContent = ''; }, 4000);
  }

  // ---- files ----------------------------------------------------------------------------------
  async open() {
    const f = await window.api.dialog.openFile({ title: 'Open command file', filters: [{ name: 'Command files', extensions: ['txt', 'cmd', 'mml', 'cfg', 'conf', 'sh'] }, { name: 'All files', extensions: ['*'] }] });
    if (!f) return;
    try {
      this.editor.value = await window.api.file.readText(f);
      this._saveSoon();
      this._renderGutter();
      toast(`Opened ${f.split(/[\\/]/).pop()}`);
    } catch (e) { toast(String(e.message || e), 'error'); }
  }

  async save() {
    const f = await window.api.file.saveOutput('commands', this.editor.value);
    if (f) toast(`Saved to ${f}`);
  }

  focus() { this.editor.focus(); }
}
