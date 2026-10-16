// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Results of "Run Commands on Sessions": one row per session, with output files.
import { h, showDialog, toast } from './dom.js';
import { errMsg } from './tools.js';

let seq = 0;
const STATE_LABEL = { queued: 'Queued', connecting: 'Connecting…', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

export class BatchTab {
  constructor(app, opts) {
    this.app = app;
    this.kind = 'batch';
    this.id = `batch${++seq}-${Date.now().toString(36)}`;
    this.opts = opts;
    this.session = {};
    this.status = {};
    this.state = 'connecting';
    this.rows = new Map(opts.sessionIds.map((id) => {
      const s = app.tree.sessions.find((x) => x.id === id) || { name: id };
      return [id, { id, name: s.name, target: s.protocol === 'serial' ? s.serial?.path : s.host, state: 'queued' }];
    }));
    this.body = h('tbody');
    this.summary = h('span');
    this.cancelBtn = h('button.small', { onclick: () => window.api.batch.cancel(this.id) }, 'Cancel');
    this.folderBtn = h('button.small', { disabled: true, onclick: () => window.api.app.openPath(this.outputDir) }, 'Open Output Folder');
    this.el = h('div.pane.scp-pane', { dataset: { tab: this.id } },
      h('div.pane-title', {}, this.title),
      h('div.scp-head', {},
        h('div.scp-row', {}, h('strong', {}, `${opts.commands.length} command${opts.commands.length === 1 ? '' : 's'} on ${this.rows.size} session${this.rows.size === 1 ? '' : 's'}`)),
        h('pre.batch-cmds', {}, opts.commands.join('\n'))),
      h('div.scp-queue', {}, h('table.scp-table', {},
        h('thead', {}, h('tr', {}, ['Session', 'Host', 'Status', 'Detail', 'Time', ''].map((c) => h('th', {}, c)))), this.body)),
      h('div.scp-foot', {}, this.summary, h('span.tb-flex'), this.cancelBtn, this.folderBtn,
        h('button.small', { onclick: () => this.app.runCommands({ sessionIds: opts.sessionIds }) }, 'Run Again…')));
    this.el.addEventListener('mousedown', () => app.activate(this, false));
    this.offUpdate = window.api.batch.onUpdate((runId, st) => { if (runId === this.id) this._update(st); });
    this.offDone = window.api.batch.onDone((runId, sum) => { if (runId === this.id) this._done(sum); });
    this._render();
  }

  get title() { return this._title || 'Commands'; }
  set title(v) { this._title = v; }
  get displayTitle() { return this.title; }
  get cfg() { return { protocol: 'batch', terminal: {} }; }

  async connect() {
    if (this.started) return; // a finished run is re-run with "Run Again…", never by Reconnect
    this.started = true;
    try {
      const sum = await window.api.batch.start(this.id, this.opts);
      this._done(sum);
    } catch (e) {
      this.state = 'failed';
      toast(errMsg(e), 'error');
      this._render();
    }
  }

  _update(st) {
    const r = this.rows.get(st.sessionId);
    if (!r) return;
    Object.assign(r, st);
    if (st.file && !this.outputDir) { this.outputDir = st.file.replace(/[\\/][^\\/]+$/, ''); this.folderBtn.disabled = false; }
    this._render();
  }

  _done(sum) {
    if (this.state !== 'connecting') return;
    this.state = 'disconnected';
    this.outputDir = sum.outputDir;
    this.folderBtn.disabled = false;
    this.cancelBtn.disabled = true;
    toast(`Commands finished: ${sum.ok} succeeded${sum.failed ? `, ${sum.failed} failed` : ''}`, sum.failed ? 'warn' : 'info');
    this._render();
    this.app.renderTabs();
  }

  _render() {
    const rows = [...this.rows.values()];
    this.body.replaceChildren(...rows.map((r) => h('tr', { class: `job-${r.state}` },
      h('td.name', {}, r.name), h('td', {}, r.target || ''),
      h('td.status', {}, STATE_LABEL[r.state] || r.state),
      h('td.status', { title: r.error || r.step || '' }, r.error ? h('span.err', {}, r.error) : r.step || ''),
      h('td.num', {}, r.ms ? `${(r.ms / 1000).toFixed(1)} s` : ''),
      h('td.row-actions', {}, r.preview ? h('button.small', { onclick: () => this._view(r) }, 'View') : null))));
    const count = (s) => rows.filter((r) => r.state === s).length;
    this.summary.textContent = `${count('done')} done · ${count('failed')} failed · ${rows.length - count('done') - count('failed') - count('cancelled')} remaining${this.outputDir ? ` · ${this.outputDir}` : ''}`;
  }

  _view(r) {
    showDialog({
      title: `Output — ${r.name}`, width: 900,
      body: h('div.form', {}, h('pre.code.batch-output', {}, r.preview), r.file ? h('p.hint', {}, `Saved to ${r.file}`) : null),
      buttons: [{ label: 'Copy', value: false }, { label: 'Close', value: true, primary: true }],
    }).then((v) => { if (v === false) { window.api.clipboard.write(r.preview); toast('Copied'); } });
  }

  focus() {}
  fitNow() {}
  applySettings() {}
  disconnect() { window.api.batch.cancel(this.id); }

  dispose() {
    window.api.batch.cancel(this.id);
    this.offUpdate();
    this.offDone();
    this.el.remove();
  }
}
