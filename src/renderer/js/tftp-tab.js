// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// TFTP server tab: serve IOS images / receive config backups from network devices.
import { h, field, toast } from './dom.js';
import { errMsg } from './tools.js';

const fmtSize = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
function storageGet(key, def = '') { try { return localStorage.getItem(key) ?? def; } catch { return def; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

export class TftpTab {
  constructor(app) {
    this.app = app;
    this.kind = 'tftp';
    this.id = `tftp-${Date.now().toString(36)}`;
    this.session = {};
    this.status = {};
    this.state = 'disconnected';
    this.transfers = new Map();
    this.root = h('input', { type: 'text', readOnly: true, 'aria-label': 'TFTP folder' });
    this.port = h('input', { type: 'number', min: 1, max: 65535, value: storageGet('termcraft.tftp.port', '69'), 'aria-label': 'Port' });
    this.iface = h('select', { 'aria-label': 'Listen on' });
    this.allowWrite = h('input', { type: 'checkbox', checked: storageGet('termcraft.tftp.write') === '1' });
    this.allowOverwrite = h('input', { type: 'checkbox', checked: storageGet('termcraft.tftp.overwrite') === '1' });
    this.btn = h('button.primary', { onclick: () => (this.state === 'connected' ? this.stop() : this.start()) }, 'Start Server');
    this.hint = h('div.tftp-hint');
    this.body = h('tbody');
    this.log = h('div.tftp-log');
    this.el = h('div.pane.scp-pane', { dataset: { tab: this.id } },
      h('div.pane-title', {}, 'TFTP Server'),
      h('div.scp-head', {},
        h('div.scp-row', {},
          field('Folder', h('div.row', {}, this.root,
            h('button.small', { onclick: async () => { const d = await window.api.dialog.openDir({ title: 'TFTP folder' }); if (d) { this.root.value = d; if (this.state === 'connected') this.start(); } } }, 'Browse…'),
            h('button.small', { title: 'Open the folder', onclick: () => window.api.app.openPath(this.root.value) }, 'Open'))),
          field('Listen on', this.iface), field('Port', this.port),
          h('div.scp-connect', {}, this.btn)),
        h('div.scp-row', {},
          h('label.check', {}, this.allowWrite, 'Allow uploads (device → this computer, e.g. config backups)'),
          h('label.check', {}, this.allowOverwrite, 'Allow replacing existing files')),
        h('div.scp-row.scp-statusline', {}, h('span.dot'), this.statusText = h('span', {}, 'Stopped')),
        this.hint),
      h('div.scp-queue', {}, h('table.scp-table', {},
        h('thead', {}, h('tr', {}, ['', 'File', 'Device', 'Size', 'Progress', 'Status'].map((c) => h('th', {}, c)))), this.body)),
      this.log);
    this.el.addEventListener('mousedown', () => app.activate(this, false));
    this.offT = window.api.tftp.onTransfer((t) => { this.transfers.set(t.id, t); this._render(); });
    this.offL = window.api.tftp.onLog((m) => this._log(m));
    for (const el of [this.allowWrite, this.allowOverwrite]) el.addEventListener('change', () => {
      storageSet('termcraft.tftp.write', this.allowWrite.checked ? '1' : '0');
      storageSet('termcraft.tftp.overwrite', this.allowOverwrite.checked ? '1' : '0');
      if (this.state === 'connected') this.start();
    });
    this._init();
  }

  get title() { return 'TFTP Server'; }
  set title(v) {}
  get displayTitle() { return this.title; }
  get cfg() { return { protocol: 'tftp', terminal: {} }; }

  async _init() {
    const st = await window.api.tftp.status();
    this.addresses = st.addresses;
    // A custom folder is shared on the network, so it is picked again each time TermCraft starts.
    this.root.value = st.root || st.defaultRoot;
    this.iface.replaceChildren(h('option', { value: '0.0.0.0' }, 'All network interfaces'),
      ...st.addresses.map((a) => h('option', { value: a.address }, `${a.address} (${a.name})`)),
      h('option', { value: '127.0.0.1' }, 'This computer only (127.0.0.1)'));
    this.iface.value = st.host || storageGet('termcraft.tftp.iface', '0.0.0.0');
    if (!this.iface.value) this.iface.value = '0.0.0.0';
    this._setRunning(st);
  }

  async start() {
    storageSet('termcraft.tftp.port', this.port.value);
    storageSet('termcraft.tftp.iface', this.iface.value);
    try {
      const st = await window.api.tftp.start({ root: this.root.value, port: Number(this.port.value), host: this.iface.value, allowWrite: this.allowWrite.checked, allowOverwrite: this.allowOverwrite.checked });
      this._setRunning(st);
      this._log(`Started on ${st.host}:${st.port}, serving ${st.root}${st.allowWrite ? ' (uploads allowed)' : ' (downloads only)'}`);
    } catch (e) {
      toast(errMsg(e), 'error', 8000);
      this._log(`Could not start: ${errMsg(e)}`);
    }
  }

  async stop() {
    this._setRunning(await window.api.tftp.stop());
    this._log('Stopped');
  }

  _setRunning(st) {
    this.state = st.running ? 'connected' : 'disconnected';
    this.btn.textContent = st.running ? 'Stop Server' : 'Start Server';
    this.btn.className = st.running ? 'danger' : 'primary';
    this.el.querySelector('.scp-statusline').className = `scp-row scp-statusline st-${this.state}`;
    this.statusText.textContent = st.running ? `Running on ${st.host === '0.0.0.0' ? 'all interfaces' : st.host}, UDP port ${st.port}` : 'Stopped';
    const ips = st.running ? (st.host === '0.0.0.0' ? (this.addresses || []).map((a) => a.address) : [st.host]) : [];
    const port = st.running && st.port !== 69 ? `:${st.port}` : '';
    this.hint.replaceChildren(...(ips.length ? [
      h('span.hint', {}, 'On the device, for example:'),
      h('code', {}, `copy tftp://${ips[0]}${port}/<file> flash:`),
      st.allowWrite ? h('code', {}, `copy running-config tftp://${ips[0]}${port}/<device>.cfg`) : null,
      ips.length > 1 ? h('span.hint', {}, `This computer: ${ips.join(', ')}`) : null,
    ].filter(Boolean) : [h('span.hint', {}, 'The server only runs while this tab is open. Port 69 may need administrator rights on Linux; devices can also use another port.')]));
    this.app.renderTabs();
    this.app.updateStatus();
  }

  _render() {
    const list = [...this.transfers.values()].sort((a, b) => b.id - a.id).slice(0, 200);
    this.body.replaceChildren(...list.map((t) => h('tr', { class: `job-${t.state === 'progress' || t.state === 'started' ? 'running' : t.state}` },
      h('td.dir', { title: t.dir === 'send' ? 'Device downloading from here' : 'Device uploading to here' }, t.dir === 'send' ? '↓' : '↑'),
      h('td.name', {}, t.name), h('td', {}, t.peer),
      h('td.num', {}, t.size ? fmtSize(t.size) : fmtSize(t.bytes)),
      h('td.prog', {}, t.size ? h('progress', { max: t.size, value: t.bytes }) : null, t.size ? `${Math.floor((t.bytes / t.size) * 100)}%` : fmtSize(t.bytes)),
      h('td.status', {}, t.state === 'failed' ? h('span.err', {}, t.error || 'Failed') : t.state === 'done' ? 'Done' : 'Transferring'))));
  }

  _log(msg) {
    this.log.append(h('div', {}, `${new Date().toLocaleTimeString()}  ${msg}`));
    while (this.log.childElementCount > 200) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  connect() { return this.start(); }
  disconnect() { return this.stop(); }
  focus() {}
  fitNow() {}
  applySettings() {}

  dispose() {
    window.api.tftp.stop();
    this.offT();
    this.offL();
    this.el.remove();
  }
}
