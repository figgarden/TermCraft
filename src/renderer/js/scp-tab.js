// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// SCP Transfer Manager tab: queue uploads/downloads over SCP, directly or through a jump host.
import { h, showDialog, field, toast, contextMenu } from './dom.js';

let seq = 0;
let jobSeq = 0;

const fmtSize = (n) => {
  if (n == null || Number.isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtEta = (s) => {
  if (!Number.isFinite(s) || s < 0) return '';
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

export class ScpTab {
  constructor(app, session = null) {
    this.app = app;
    this.kind = 'scp';
    this.id = `scp${++seq}-${Date.now().toString(36)}`;
    this._session = session;
    this.state = 'idle';
    this.status = {};
    this.jobs = [];
    this.info = null;
    this._build();
    this.offProgress = window.api.scp.onProgress((p) => this._onProgress(p));
    this.offClosed = window.api.scp.onClosed((id) => { if (id === this.id) this._setState('disconnected'); });
    this.offLog = window.api.scp.onLog((id, msg) => { if (id === this.id) this.statusText.textContent = msg; });
    this.ticker = setInterval(() => this._renderQueue(), 1000);
  }

  get session() { return this._session; }
  set session(s) { this._session = s; if (s?.name) this.hostInput.value = s.name; this.app.renderTabs(); }
  get title() { return this._customTitle || `SCP: ${this._session?.name || this.hostInput?.value || 'Transfers'}`; }
  set title(v) { this._customTitle = v; } // "Rename Tab"

  get displayTitle() { return this.title; }
  get cfg() { return this.app.effectiveSession(this._session || { protocol: 'ssh2' }); }

  // ---- UI ----------------------------------------------------------------
  _build() {
    const sshSessions = () => this.app.tree.sessions.filter((s) => s.protocol === 'ssh2');
    this.hostList = h('datalist', { id: `${this.id}-hosts` });
    this.hostInput = h('input', {
      type: 'text', list: this.hostList.id, placeholder: 'Saved session or user@host[:port]', 'aria-label': 'Host',
      value: this._session?.name || '',
      onkeydown: (e) => { if (e.key === 'Enter') this.connect(); },
    });
    this.jumpSel = h('select', { 'aria-label': 'Jump host', onchange: () => { this.jumpInput.hidden = this.jumpSel.value !== '__other'; if (!this.jumpInput.hidden) this.jumpInput.focus(); } });
    this.jumpInput = h('input', { type: 'text', placeholder: 'user@jumphost[:port]', 'aria-label': 'Other jump host', hidden: true });
    this.refreshLists = () => {
      this.hostList.replaceChildren(...sshSessions().map((s) => h('option', { value: s.name }, `${s.username ? s.username + '@' : ''}${s.host}:${s.port}`)));
      const cur = this.jumpSel.value;
      this.jumpSel.replaceChildren(
        h('option', { value: '' }, "Session's own setting"),
        h('option', { value: '__none' }, 'Direct — no jump host'),
        h('optgroup', { label: 'Through saved session' }, sshSessions().map((s) => h('option', { value: s.id }, s.name))),
        h('option', { value: '__other' }, 'Other jump host…'));
      this.jumpSel.value = cur || '';
    };
    this.refreshLists();
    this.connectBtn = h('button.primary', { onclick: () => (this.state === 'connected' ? this.disconnect() : this.connect()) }, 'Connect');
    this.statusText = h('span.scp-status', {}, 'Not connected');

    this.remoteInput = h('input', { type: 'text', placeholder: '~ (home)', 'aria-label': 'Remote folder', onchange: () => this._rememberRemote() });
    const sep = this.app.platform === 'win32' ? '\\' : '/';
    this.localInput = h('input', { type: 'text', value: storageGet('termcraft.scp.local') || `${this.app.info.home}${sep}Downloads`, 'aria-label': 'Local folder', onchange: () => storageSet('termcraft.scp.local', this.localInput.value) });
    this.preserve = h('input', { type: 'checkbox', checked: storageGet('termcraft.scp.preserve') !== '0', onchange: () => storageSet('termcraft.scp.preserve', this.preserve.checked ? '1' : '0') });
    this.parallel = h('select', { 'aria-label': 'Parallel transfers', onchange: () => { storageSet('termcraft.scp.parallel', this.parallel.value); this._pump(); } },
      ['1', '2', '3', '4'].map((n) => h('option', { value: n }, n)));
    this.parallel.value = storageGet('termcraft.scp.parallel') || '2';

    this.queueBody = h('tbody');
    this.summary = h('span.scp-summary');
    this.dropZone = h('div.scp-queue', {
      ondragover: (e) => { e.preventDefault(); this.dropZone.classList.add('drop'); },
      ondragleave: () => this.dropZone.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        this.dropZone.classList.remove('drop');
        const paths = [...e.dataTransfer.files].map((f) => window.api.file.pathFor(f)).filter(Boolean);
        if (paths.length) this.queueUploads(paths);
      },
    },
    h('table.scp-table', {},
      h('thead', {}, h('tr', {}, ['', 'Name', 'Destination', 'Size', 'Progress', 'Speed', 'Time left', 'Status', ''].map((c) => h('th', {}, c)))),
      this.queueBody),
    this.emptyHint = h('div.scp-empty', {}, 'Drop files or folders here to upload them to the remote folder, or use the buttons above.'));

    this.el = h('div.pane.scp-pane', { dataset: { tab: this.id } },
      h('div.pane-title', {}, this.title),
      h('div.scp-head', {},
        h('div.scp-row', {},
          field('Host', h('div', {}, this.hostInput, this.hostList)),
          field('Jump host', h('div.row', {}, this.jumpSel, this.jumpInput)),
          h('div.scp-connect', {}, this.connectBtn)),
        h('div.scp-row.scp-statusline', {}, h('span.dot'), this.statusText),
        h('div.scp-row', {},
          field('Remote folder', this.remoteInput),
          field('Local folder', h('div.row', {}, this.localInput, h('button.small', { onclick: async () => { const d = await window.api.dialog.openDir({ title: 'Local folder' }); if (d) { this.localInput.value = d; storageSet('termcraft.scp.local', d); } } }, 'Browse…')))),
        h('div.scp-row.scp-actions', {},
          h('button', { onclick: () => this.pickUpload(false) }, '↑ Upload Files…'),
          h('button', { onclick: () => this.pickUpload(true) }, '↑ Upload Folder…'),
          h('button', { onclick: () => this.pickDownload() }, '↓ Download…'),
          h('span.tb-flex'),
          h('label.check', {}, this.preserve, 'Preserve times & permissions'),
          h('label.check', {}, 'Parallel', this.parallel))),
      this.dropZone,
      h('div.scp-foot', {},
        this.summary,
        h('span.tb-flex'),
        h('button.small', { onclick: () => this.retryFailed() }, 'Retry Failed'),
        h('button.small', { onclick: () => this.clearFinished() }, 'Clear Finished')));
    this.el.addEventListener('mousedown', () => this.app.activate(this, false));
    this._renderQueue();
  }

  _setState(state, info) {
    this.state = state;
    if (info) this.info = info;
    this.connectBtn.textContent = state === 'connected' ? 'Disconnect' : state === 'connecting' ? 'Connecting…' : 'Connect';
    this.connectBtn.disabled = state === 'connecting';
    this.connectBtn.className = state === 'connected' ? '' : 'primary';
    this.el.querySelector('.scp-statusline').className = `scp-row scp-statusline st-${state}`;
    if (state === 'connected') {
      const i = this.info;
      this.statusText.textContent = `Connected to ${i.username}@${i.host}:${i.port}${i.via ? ` via jump host ${i.via}` : ' (direct)'}${i.home ? ` — home ${i.home}` : ''}`;
      this.connectedAt = this.connectedAt || Date.now();
      this.username = i.username;
    } else if (state === 'disconnected') {
      this.statusText.textContent = 'Disconnected';
      this.connectedAt = null;
      for (const j of this.jobs) if (j.state === 'active') { j.state = 'failed'; j.error = 'Connection closed'; }
    }
    this.app.renderTabs();
    if (this.app.active === this) this.app.updateStatus();
    this._renderQueue();
  }

  // ---- connection -------------------------------------------------------------
  _target() {
    const text = this.hostInput.value.trim();
    const saved = this.app.tree.sessions.find((s) => s.protocol === 'ssh2' && (s.name === text || s.id === text));
    if (saved) return { ref: saved.id, session: saved };
    if (this._session?.id && this._session.name === text) return { ref: this._session.id, session: this._session };
    // An unsaved session handed to this tab (e.g. from a terminal tab): keep its real host/port.
    if (this._session && !this._session.id && this._session.name === text) return { ref: this._session, session: this._session };
    const m = /^(?:ssh2?:\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(text);
    if (!m) return null;
    const host = m[2].replace(/^\[|\]$/g, '');
    const session = { name: text, protocol: 'ssh2', host, port: Number(m[3]) || 22, username: m[1] || '' };
    return { ref: session, session };
  }

  _jump() {
    const v = this.jumpSel.value;
    if (!v) return { mode: 'default' };
    if (v === '__none') return { mode: 'none' };
    if (v === '__other') return { mode: 'adhoc', target: this.jumpInput.value.trim() };
    return { mode: 'session', id: v };
  }

  async connect() {
    const t = this._target();
    if (!t) { this.hostInput.focus(); return toast('Enter a saved session name or user@host[:port]', 'warn'); }
    const jump = this._jump();
    if (jump.mode === 'adhoc' && !jump.target) { this.jumpInput.focus(); return toast('Enter the jump host as user@host[:port]', 'warn'); }
    this._session = t.session;
    this._setState('connecting');
    this.statusText.textContent = `Connecting to ${t.session.host}${jump.mode === 'none' ? ' (direct)' : ''}…`;
    try {
      const info = await window.api.scp.open(this.id, t.ref, jump);
      const remembered = storageGet(`termcraft.scp.remote.${info.host}`);
      if (!this.remoteInput.value) this.remoteInput.value = remembered || info.home || '~';
      this._setState('connected', info);
      this._pump();
    } catch (e) {
      this._setState('failed');
      this.statusText.textContent = `Connection failed: ${errMsg(e)}`;
    }
  }

  disconnect() {
    window.api.scp.close(this.id);
    for (const j of this.jobs) if (j.state === 'active') window.api.scp.cancel(j.id);
    this._setState('disconnected');
  }

  _rememberRemote() {
    if (this.info?.host) storageSet(`termcraft.scp.remote.${this.info.host}`, this.remoteInput.value);
  }

  // ---- queueing ----------------------------------------------------------------
  async pickUpload(folders) {
    const paths = await window.api.dialog.openPaths({
      title: folders ? 'Upload folders' : 'Upload files',
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections', 'showHiddenFiles'],
    });
    if (paths.length) this.queueUploads(paths);
  }

  queueUploads(paths) {
    const remote = this.remoteInput.value.trim() || '~';
    for (const p of paths) this._add({ dir: 'up', name: baseName(p), src: p, dest: remote });
  }

  async pickDownload() {
    const area = h('textarea', { rows: 5, placeholder: '/var/log/syslog\n~/backups/config.tar.gz\n/etc/nginx/*.conf', 'aria-label': 'Remote paths', autofocus: true });
    const dest = h('input', { type: 'text', value: this.localInput.value, 'aria-label': 'Save to' });
    const base = (this.remoteInput.value.trim() || '').replace(/\/+$/, '');
    const ok = await showDialog({
      title: 'Download via SCP',
      width: 560,
      body: h('div.form', {},
        field('Remote files or folders (one per line)', area, `Relative paths start in the remote folder${base ? ` (${base})` : ''}. Folders download recursively; wildcards like *.log work.`),
        field('Save to local folder', dest)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Download', value: true, primary: true, validate: () => (area.value.trim() ? null : 'Enter at least one remote path') }],
    });
    if (!ok) return;
    for (let p of area.value.split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (!p.startsWith('/') && !p.startsWith('~') && base && base !== '~') p = `${base}/${p}`;
      else if (!p.startsWith('/') && !p.startsWith('~') && base === '~') p = `~/${p}`;
      this._add({ dir: 'down', name: baseName(p), src: p, dest: dest.value.trim() });
    }
  }

  _add(job) {
    this.jobs.push({ id: `j${++jobSeq}`, state: 'queued', done: 0, total: null, samples: [], ...job });
    this._renderQueue();
    if (this.state !== 'connected' && this.state !== 'connecting') this.connect();
    else this._pump();
  }

  _pump() {
    if (this.state !== 'connected') return;
    const limit = Number(this.parallel.value) || 2;
    while (this.jobs.filter((j) => j.state === 'active').length < limit) {
      const next = this.jobs.find((j) => j.state === 'queued');
      if (!next) break;
      this._start(next);
    }
    this._renderQueue();
  }

  async _start(job) {
    job.state = 'active';
    job.started = Date.now();
    job.done = 0;
    job.samples = [];
    job.error = '';
    const opts = { preserve: this.preserve.checked };
    try {
      if (job.dir === 'up') await window.api.scp.upload(this.id, job.id, [job.src], job.dest, opts);
      else await window.api.scp.download(this.id, job.id, job.src, job.dest, opts);
      job.state = 'done';
      job.finished = Date.now();
      if (job.total == null) job.total = job.done;
    } catch (e) {
      job.state = errMsg(e) === 'Cancelled' ? 'cancelled' : 'failed';
      job.error = errMsg(e);
    }
    this._renderQueue();
    this._pump();
    if (!this.jobs.some((j) => j.state === 'active' || j.state === 'queued') && Date.now() - (this.lastDoneToast || 0) > 3000) {
      this.lastDoneToast = Date.now();
      const failed = this.jobs.filter((j) => j.state === 'failed').length;
      toast(failed ? `SCP: transfers finished, ${failed} failed` : 'SCP: all transfers complete', failed ? 'warn' : 'info');
    }
  }

  _onProgress(p) {
    const job = this.jobs.find((j) => j.id === p.jobId);
    if (!job) return;
    job.done = p.done;
    job.total = p.total;
    job.file = p.file;
    const now = Date.now();
    job.samples.push([now, p.done]);
    while (job.samples.length > 2 && now - job.samples[0][0] > 3000) job.samples.shift();
    this._renderQueue();
  }

  cancel(job) {
    if (job.state === 'active') window.api.scp.cancel(job.id);
    else if (job.state === 'queued') { job.state = 'cancelled'; this._renderQueue(); }
  }

  retry(job) {
    Object.assign(job, { state: 'queued', done: 0, total: null, error: '', samples: [] });
    if (this.state !== 'connected') this.connect(); else this._pump();
  }

  retryFailed() { for (const j of this.jobs) if (j.state === 'failed' || j.state === 'cancelled') this.retry(j); }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.state === 'active' || j.state === 'queued');
    this._renderQueue();
  }

  _speed(job) {
    const s = job.samples;
    if (s.length < 2) return 0;
    const [t0, b0] = s[0];
    const [t1, b1] = s[s.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }

  _renderQueue() {
    const rows = this.jobs.map((j) => {
      const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.state === 'done' ? 100 : 0;
      const speed = j.state === 'active' ? this._speed(j) : j.state === 'done' && j.finished > j.started ? (j.done * 1000) / (j.finished - j.started) : 0;
      const eta = j.state === 'active' && speed > 0 && j.total ? (j.total - j.done) / speed : NaN;
      const statusText = { queued: 'Queued', active: j.file && j.file !== j.name ? `› ${j.file}` : 'Transferring', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[j.state];
      return h('tr', { class: `job-${j.state}`, title: j.error || '', oncontextmenu: (e) => { e.preventDefault(); this._jobMenu(e, j); } },
        h('td.dir', { title: j.dir === 'up' ? 'Upload' : 'Download' }, j.dir === 'up' ? '↑' : '↓'),
        h('td.name', { title: j.src }, j.name),
        h('td.dest', { title: j.dest }, j.dest),
        h('td.num', {}, j.total != null ? fmtSize(j.total) : ''),
        h('td.prog', {}, h('progress', { max: 100, value: pct }), h('span', {}, `${pct}%`)),
        h('td.num', {}, speed ? `${fmtSize(speed)}/s` : ''),
        h('td.num', {}, fmtEta(eta)),
        h('td.status', {}, statusText, j.error ? h('div.err', {}, j.error) : null),
        h('td.actions', {},
          j.state === 'active' || j.state === 'queued' ? h('button.icon-btn', { title: 'Cancel', 'aria-label': 'Cancel transfer', onclick: () => this.cancel(j) }, '✕') : null,
          j.state === 'failed' || j.state === 'cancelled' ? h('button.icon-btn', { title: 'Retry', 'aria-label': 'Retry transfer', onclick: () => this.retry(j) }, '⟳') : null,
          j.state === 'done' && j.dir === 'down' ? h('button.icon-btn', { title: 'Show in folder', 'aria-label': 'Open local folder', onclick: () => window.api.app.openPath(j.dest) }, '📂') : null));
    });
    this.queueBody.replaceChildren(...rows);
    this.emptyHint.hidden = this.jobs.length > 0;
    const count = (s) => this.jobs.filter((j) => j.state === s).length;
    const parts = [['queued', 'queued'], ['active', 'active'], ['done', 'done'], ['failed', 'failed']].filter(([s]) => count(s)).map(([s, l]) => `${count(s)} ${l}`);
    this.summary.textContent = parts.join(' · ') || 'No transfers';
    this.el.querySelector('.pane-title').textContent = `${this.title} — ${this.state}`;
  }

  _jobMenu(e, j) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Cancel', disabled: !(j.state === 'active' || j.state === 'queued'), action: () => this.cancel(j) },
      { label: 'Retry', disabled: !(j.state === 'failed' || j.state === 'cancelled' || j.state === 'done'), action: () => this.retry(j) },
      { label: 'Show Local Folder', action: () => window.api.app.openPath(j.dir === 'down' ? j.dest : j.src.replace(/[\\/][^\\/]+$/, '')) },
      '-',
      { label: 'Remove from List', disabled: j.state === 'active', action: () => { this.jobs = this.jobs.filter((x) => x !== j); this._renderQueue(); } },
    ]);
  }

  // ---- tab interface ---------------------------------------------------------------
  focus() { (this.state === 'connected' ? this.remoteInput : this.hostInput).focus(); }
  fitNow() {}
  applySettings() { this.refreshLists(); }

  dispose() {
    clearInterval(this.ticker);
    this.offProgress();
    this.offClosed();
    this.offLog();
    for (const j of this.jobs) if (j.state === 'active') window.api.scp.cancel(j.id);
    window.api.scp.close(this.id);
    this.el.remove();
  }
}
