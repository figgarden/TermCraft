// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// RDP session tab: opens the optional SSH tunnel and launches the system's RDP client.
import { h } from './dom.js';

let seq = 0;
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export class RdpTab {
  constructor(app, session) {
    this.app = app;
    this.kind = 'rdp';
    this.id = `rdp${++seq}-${Date.now().toString(36)}`;
    this.session = session;
    this.cfg = app.effectiveSession(session);
    this.state = 'idle';
    this.status = {};
    this._title = '';
    this.card = h('div.rdp-card');
    this.el = h('div.pane.rdp-pane', { dataset: { tab: this.id } }, h('div.pane-title', {}, this.displayTitle), this.card);
    this.el.addEventListener('mousedown', () => app.activate(this, false));
    this.offStatus = window.api.remote.onStatus((id, st) => {
      if (id !== this.id) return;
      if (st.exited) { this.state = 'disconnected'; this.message = st.error ? `The RDP client exited: ${st.error}` : 'The RDP client was closed.'; }
      else if (st.error) { this.message = st.error; }
      this._render();
      this.app.renderTabs();
      this.app.updateStatus();
    });
    this._render();
  }

  get displayTitle() { return this._title || this.session.name || this.session.host; }
  set title(v) { this._title = v; }
  get title() { return this.displayTitle; }

  async connect() {
    this.state = 'connecting';
    this.message = '';
    this._render();
    this.app.renderTabs();
    try {
      this.info = await window.api.remote.rdpLaunch(this.id, this.session.id || this.session);
      this.state = 'connected';
      this.connectedAt = Date.now();
      this.status = { via: this.info.via };
    } catch (e) {
      this.state = 'failed';
      this.message = errMsg(e);
    }
    this._render();
    this.app.renderTabs();
    this.app.updateStatus();
  }

  disconnect() {
    window.api.remote.rdpClose(this.id);
    this.state = 'disconnected';
    this.connectedAt = null;
    this.message = this.info?.via ? 'Tunnel closed.' : '';
    this._render();
    this.app.renderTabs();
    this.app.updateStatus();
  }

  _render() {
    const i = this.info;
    const cfg = this.cfg;
    const rows = [
      ['Computer', `${cfg.host}:${cfg.port}`],
      ['User', `${cfg.rdp?.domain ? cfg.rdp.domain + '\\' : ''}${cfg.username || '(asked by the client)'}`],
      ['Route', i?.via ? `SSH tunnel through ${i.via} (local port ${i.localPort})` : cfg.tunnel?.sshSessionId ? 'SSH tunnel' : 'Direct'],
      ['Client', i?.client || '—'],
    ];
    const stateText = { idle: 'Ready', connecting: 'Launching…', connected: 'Launched', disconnected: 'Closed', failed: 'Could not launch' }[this.state];
    // replaceChildren() would render null as the text "null", so drop the empty optional lines.
    this.card.replaceChildren(...[
      h('div.rdp-head', {}, h('span.rdp-badge', {}, 'RDP'), h('h2', {}, this.displayTitle), h('span.st', { class: `st-${this.state}` }, stateText)),
      h('table.kv', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
      i?.note && this.state === 'connected' ? h('p.hint', {}, i.note) : null,
      this.message ? h('p', { class: this.state === 'failed' ? 'error' : 'hint' }, this.message) : null,
      i?.via && this.state === 'connected' ? h('p.hint', {}, 'Keep this tab open while you use the remote desktop — closing it closes the SSH tunnel.') : null,
      h('div.row', {},
        h('button.primary', { onclick: () => this.connect() }, this.state === 'connected' ? 'Launch Again' : 'Launch'),
        this.state === 'connected' && i?.via ? h('button', { onclick: () => this.disconnect() }, 'Close Tunnel') : null,
        h('button', { onclick: () => this.app.editTabSession(this) }, 'Session Options…')),
    ].filter(Boolean));
  }

  focus() { this.card.querySelector('button')?.focus(); }
  fitNow() {}

  applySettings() {
    this.cfg = this.app.effectiveSession(this.session);
    this._render();
  }

  dispose() {
    this.offStatus();
    window.api.remote.rdpClose(this.id);
    this.el.remove();
  }
}
