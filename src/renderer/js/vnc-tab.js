// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Embedded VNC viewer (noVNC, MPL-2.0) connected through TermCraft's local WebSocket bridge.
import RFB from '../../../node_modules/@novnc/novnc/core/rfb.js';
import { h, toast } from './dom.js';
import { handlePrompt } from './dialogs.js';

let seq = 0;
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export class VncTab {
  constructor(app, session) {
    this.app = app;
    this.kind = 'vnc';
    this.id = `vnc${++seq}-${Date.now().toString(36)}`;
    this.session = session;
    this.cfg = app.effectiveSession(session);
    this.state = 'idle';
    this.status = {};
    this.rfb = null;
    this.desktopName = '';
    this._title = '';

    const v = this.cfg.vnc || {};
    this.scaleSel = h('select', { 'aria-label': 'Scaling', title: 'Scaling', onchange: () => this._applyView() },
      h('option', { value: 'fit' }, 'Fit to window'),
      h('option', { value: 'remote' }, 'Resize remote desktop'),
      h('option', { value: 'none' }, 'Actual size'));
    this.scaleSel.value = v.scale || 'fit';
    this.viewOnly = h('input', { type: 'checkbox', checked: !!v.viewOnly, onchange: () => this._applyView() });
    this.screen = h('div.vnc-screen');
    this.banner = h('div.pane-banner', { hidden: true });
    this.el = h('div.pane.vnc-pane', { dataset: { tab: this.id } },
      h('div.pane-title', {}, this.displayTitle),
      h('div.vnc-toolbar', {},
        this.scaleSel,
        h('label.check', {}, this.viewOnly, 'View only'),
        h('button.small', { title: 'Send Ctrl+Alt+Del to the remote computer', onclick: () => this.rfb?.sendCtrlAltDel() }, 'Ctrl+Alt+Del'),
        h('button.small', { title: 'Paste your clipboard text into the remote computer', onclick: () => this.sendClipboard() }, 'Send Clipboard'),
        h('span.tb-flex'),
        this.info = h('span.vnc-info', {}, ''),
        h('button.small', { onclick: () => (this.state === 'connected' ? this.disconnect() : this.connect()) }, 'Reconnect')),
      this.screen,
      this.banner);
    this.el.addEventListener('mousedown', () => app.activate(this, false));
    this.offStatus = window.api.remote.onStatus((id, st) => { if (id === this.id && st.error) this._showBanner(st.error); });
  }

  get displayTitle() { return this._title || `${this.desktopName || this.session.name || this.session.host}`; }
  set title(v) { this._title = v; }
  get title() { return this.displayTitle; }

  async connect() {
    this._teardown();
    this.banner.hidden = true;
    this.state = 'connecting';
    this.app.renderTabs();
    this.app.updateStatus();
    let info;
    try {
      info = await window.api.remote.vncOpen(this.id, this.session.id || this.session);
    } catch (e) {
      return this._fail(errMsg(e));
    }
    this.target = info;
    this.status = { via: info.via };
    this.info.textContent = `${info.host}:${info.port}${info.via ? ` via ${info.via}` : ''}`;
    const v = this.cfg.vnc || {};
    const creds = {};
    if (info.password) creds.password = info.password;
    if (info.username) creds.username = info.username;
    this.pendingSave = null;
    try {
      this.rfb = new RFB(this.screen, info.url, { credentials: creds, wsProtocols: ['binary'], shared: v.shared !== false });
    } catch (e) {
      return this._fail(errMsg(e));
    }
    const rfb = this.rfb;
    rfb.qualityLevel = Number(v.quality ?? 6);
    rfb.compressionLevel = Number(v.compression ?? 2);
    this._applyView();
    rfb.addEventListener('connect', () => this._onConnect());
    rfb.addEventListener('disconnect', (e) => this._onDisconnect(e.detail?.clean));
    rfb.addEventListener('credentialsrequired', (e) => this._askCredentials(e.detail?.types || ['password']));
    rfb.addEventListener('securityfailure', (e) => {
      this.pendingSave = null;
      this._showBanner(`Authentication failed${e.detail?.reason ? `: ${e.detail.reason}` : ''}`);
    });
    rfb.addEventListener('clipboard', (e) => { if (e.detail?.text) window.api.clipboard.write(e.detail.text); });
    rfb.addEventListener('desktopname', (e) => { this.desktopName = e.detail?.name || ''; this.app.renderTabs(); });
  }

  async _askCredentials(types) {
    const prompts = [];
    if (types.includes('username')) prompts.push({ prompt: 'Username', echo: true });
    if (types.includes('password')) prompts.push({ prompt: 'Password', echo: false });
    if (types.includes('target')) prompts.push({ prompt: 'Target', echo: true });
    const res = await handlePrompt(this.app, {
      kind: 'kbdint', tabId: this.id, title: `VNC login — ${this.target?.host}`,
      prompts, offerSave: types.includes('password'),
    });
    if (!res) { this.disconnect(); return; }
    const answers = Array.isArray(res) ? res : res.answers;
    const creds = {};
    prompts.forEach((p, i) => { creds[p.prompt.toLowerCase()] = answers[i]; });
    // Only save once the server accepts the login.
    this.pendingSave = res.save ? { username: creds.username, password: creds.password } : null;
    this.rfb.sendCredentials(creds);
  }

  async _onConnect() {
    this.state = 'connected';
    this.connectedAt = Date.now();
    this.banner.hidden = true;
    this.app.renderTabs();
    this.app.updateStatus();
    this.rfb.focus();
    if (this.pendingSave) {
      const creds = this.pendingSave;
      this.pendingSave = null;
      try {
        const saved = await window.api.store.saveCredentials(this.session.id || this.session, creds);
        this.session = saved;
        await this.app.reloadTree();
        toast(`Login saved for "${saved.name}" — you won't be asked again`);
      } catch (e) { toast(`Could not save login: ${errMsg(e)}`, 'error'); }
    }
  }

  _onDisconnect(clean) {
    const was = this.state;
    this.state = 'disconnected';
    this.connectedAt = null;
    this.app.renderTabs();
    this.app.updateStatus();
    if (!this.banner.hidden) return; // keep a more specific error already shown
    this._showBanner(was === 'connected' ? (clean ? 'Disconnected' : 'Connection lost') : 'Could not connect to the VNC server');
  }

  _fail(msg) {
    this.state = 'failed';
    this.app.renderTabs();
    this.app.updateStatus();
    this._showBanner(msg);
  }

  _showBanner(msg) {
    this.banner.replaceChildren(h('span', {}, msg),
      h('button.small', { onclick: () => this.connect() }, 'Reconnect'),
      h('button.small', { onclick: () => this.app.editTabSession(this) }, 'Session Options…'),
      h('button.small', { onclick: () => this.app.closeTab(this) }, 'Close tab'));
    this.banner.hidden = false;
  }

  _applyView() {
    if (!this.rfb) return;
    const mode = this.scaleSel.value;
    this.rfb.scaleViewport = mode === 'fit';
    this.rfb.resizeSession = mode === 'remote';
    this.rfb.clipViewport = false;
    this.rfb.viewOnly = this.viewOnly.checked;
    this.screen.classList.toggle('actual-size', mode === 'none');
  }

  async sendClipboard() {
    if (!this.rfb || this.state !== 'connected') return;
    const text = await window.api.clipboard.read();
    if (text) { this.rfb.clipboardPasteFrom(text); toast('Clipboard sent to the remote computer'); }
  }

  _teardown() {
    try { this.rfb?.disconnect(); } catch { /* already closed */ }
    this.rfb = null;
    window.api.remote.vncClose(this.id);
  }

  disconnect() {
    this._teardown();
    this._onDisconnect(true);
  }

  focus() { this.rfb?.focus(); }
  fitNow() {}

  applySettings() {
    this.cfg = this.app.effectiveSession(this.session);
    this.app.renderTabs();
  }

  dispose() {
    this.offStatus();
    this._teardown();
    this.el.remove();
  }
}
