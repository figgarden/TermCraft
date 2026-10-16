// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { h, contextMenu, confirmDialog, promptDialog, toast } from './dom.js';

let seq = 0;
let transferSeq = 0;

const fmtSize = (n) => {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '');
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

class FilePane {
  constructor(tab, side) {
    this.tab = tab;
    this.side = side; // 'local' | 'remote'
    this.path = '';
    this.entries = [];
    this.selected = new Set();
    this.sort = { key: 'name', dir: 1 };
    this.pathInput = h('input.path', {
      'aria-label': `${side} path`,
      onkeydown: (e) => { if (e.key === 'Enter') this.load(this.pathInput.value); },
    });
    this.body = h('tbody');
    this.el = h('div.file-pane', { dataset: { side } },
      h('div.file-pane-head', {},
        h('strong', {}, side === 'local' ? 'Local' : 'Remote'),
        h('button.icon-btn', { title: 'Up one level', 'aria-label': 'Up one level', onclick: () => this.up() }, '⬆'),
        h('button.icon-btn', { title: 'Home', 'aria-label': 'Home', onclick: () => this.load(side === 'local' ? '' : this.tab.home) }, '⌂'),
        h('button.icon-btn', { title: 'Refresh', 'aria-label': 'Refresh', onclick: () => this.load(this.path) }, '⟳'),
        h('button.icon-btn', { title: 'New folder', 'aria-label': 'New folder', onclick: () => this.mkdir() }, '＋'),
        this.pathInput),
      h('div.file-table-wrap', {
        tabindex: 0,
        ondragover: (e) => { e.preventDefault(); this.el.classList.add('drop'); },
        ondragleave: () => this.el.classList.remove('drop'),
        ondrop: (e) => this.onDrop(e),
        onkeydown: (e) => this.onKey(e),
      },
      h('table.file-table', {},
        h('thead', {}, h('tr', {},
          ['name', 'size', 'mtime', 'mode'].map((k) => h('th', { onclick: () => this.setSort(k) },
            { name: 'Name', size: 'Size', mtime: 'Modified', mode: 'Permissions' }[k])))),
        this.body)));
  }

  join(name) {
    if (this.side === 'remote') return (this.path.endsWith('/') ? this.path : this.path + '/') + name;
    const sep = this.sep || '/';
    return (this.path.endsWith(sep) ? this.path : this.path + sep) + name;
  }

  async load(dir) {
    try {
      const res = this.side === 'local'
        ? await window.api.sftp.listLocal(dir)
        : await window.api.sftp.listRemote(this.tab.id, dir || '.');
      this.path = res.path;
      this.sep = res.sep;
      this.parent = res.parent;
      this.entries = res.entries.filter((e) => this.tab.showHidden || !e.name.startsWith('.'));
      this.selected.clear();
      this.pathInput.value = this.path;
      this.render();
    } catch (e) {
      toast(`${this.side}: ${errMsg(e)}`, 'error');
    }
  }

  up() {
    if (this.side === 'local') return this.load(this.parent || this.path);
    const p = this.path.replace(/\/+$/, '');
    this.load(p.slice(0, p.lastIndexOf('/')) || '/');
  }

  setSort(key) {
    this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
    this.render();
  }

  render() {
    const { key, dir } = this.sort;
    const rows = [...this.entries].sort((a, b) => (b.isDir - a.isDir) || (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
    this.body.replaceChildren(...rows.map((e) => {
      const tr = h('tr', {
        class: this.selected.has(e.name) ? 'sel' : '',
        draggable: true,
        onclick: (ev) => this.select(e.name, ev),
        ondblclick: () => this.open(e),
        oncontextmenu: (ev) => { ev.preventDefault(); if (!this.selected.has(e.name)) this.select(e.name, {}); this.menu(ev); },
        ondragstart: (ev) => {
          if (!this.selected.has(e.name)) this.select(e.name, {});
          ev.dataTransfer.setData('application/x-termcraft-files', JSON.stringify({ side: this.side, tab: this.tab.id, names: [...this.selected] }));
        },
      },
      h('td', {}, h('span.ficon', {}, e.isDir ? '📁' : e.isLink ? '🔗' : '📄'), e.name),
      h('td.num', {}, e.isDir ? '' : fmtSize(e.size)),
      h('td', {}, fmtDate(e.mtime)),
      h('td.mono', {}, e.mode));
      return tr;
    }));
  }

  select(name, ev) {
    if (ev.metaKey || ev.ctrlKey) this.selected.has(name) ? this.selected.delete(name) : this.selected.add(name);
    else this.selected = new Set([name]);
    this.render();
  }

  open(e) {
    if (e.isDir) this.load(this.join(e.name));
    else this.tab.transfer(this.side, [e.name]);
  }

  onKey(e) {
    if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) this.remove();
    if (e.key === 'Backspace' && !e.metaKey) this.up();
    if (e.key === 'F2') this.rename();
    if (e.key === 'F5') this.load(this.path);
  }

  menu(ev) {
    const other = this.side === 'local' ? 'Upload' : 'Download';
    contextMenu(ev.clientX, ev.clientY, [
      { label: other, action: () => this.tab.transfer(this.side, [...this.selected]) },
      '-',
      { label: 'Rename…', hint: 'F2', action: () => this.rename(), disabled: this.selected.size !== 1 },
      { label: 'Delete', hint: 'Del', action: () => this.remove() },
      { label: 'New Folder…', action: () => this.mkdir() },
      this.side === 'remote' ? { label: 'Change Permissions…', action: () => this.chmod(), disabled: this.selected.size !== 1 } : null,
      '-',
      { label: 'Refresh', hint: 'F5', action: () => this.load(this.path) },
      { label: this.tab.showHidden ? 'Hide Hidden Files' : 'Show Hidden Files', action: () => { this.tab.showHidden = !this.tab.showHidden; this.tab.refresh(); } },
    ]);
  }

  async op(op, a, b) {
    try {
      if (this.side === 'local') await window.api.sftp.localOp(op, a, b);
      else await window.api.sftp.remoteOp(this.tab.id, op, a, b);
      await this.load(this.path);
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  async mkdir() {
    const name = await promptDialog('New Folder', 'Folder name:');
    if (name) this.op('mkdir', this.join(name));
  }

  async rename() {
    const [name] = this.selected;
    if (!name) return;
    const next = await promptDialog('Rename', `Rename "${name}" to:`, name);
    if (next && next !== name) this.op('rename', this.join(name), this.join(next));
  }

  async remove() {
    const names = [...this.selected];
    if (!names.length) return;
    const ok = await confirmDialog('Delete', `Permanently delete ${names.length === 1 ? `"${names[0]}"` : `${names.length} items`} (${this.side})?\nFolders are deleted recursively.`, 'Delete', true);
    if (!ok) return;
    for (const n of names) {
      try {
        if (this.side === 'local') await window.api.sftp.localOp('delete', this.join(n));
        else await window.api.sftp.remoteOp(this.tab.id, 'delete', this.join(n));
      } catch (e) { toast(errMsg(e), 'error'); }
    }
    this.load(this.path);
  }

  async chmod() {
    const [name] = this.selected;
    const e = this.entries.find((x) => x.name === name);
    const oct = e ? [1, 4, 7].map((i) => e.mode.slice(i, i + 3).split('').reduce((n, c, j) => n + (c !== '-' ? [4, 2, 1][j] : 0), 0)).join('') : '644';
    const mode = await promptDialog('Change Permissions', `Octal mode for "${name}":`, oct);
    if (mode && /^[0-7]{3,4}$/.test(mode)) this.op('chmod', this.join(name), mode);
  }

  onDrop(e) {
    e.preventDefault();
    this.el.classList.remove('drop');
    const internal = e.dataTransfer.getData('application/x-termcraft-files');
    if (internal) {
      const { side, tab, names } = JSON.parse(internal);
      if (tab === this.tab.id && side !== this.side) this.tab.transfer(side, names);
      return;
    }
    if (this.side === 'remote' && e.dataTransfer.files.length) {
      const paths = [...e.dataTransfer.files].map((f) => window.api.file.pathFor(f)).filter(Boolean);
      this.tab.uploadPaths(paths);
    }
  }
}

export class SftpTab {
  constructor(app, session) {
    this.app = app;
    this.kind = 'sftp';
    this.id = `sftp${++seq}-${Date.now().toString(36)}`;
    this.session = session;
    this.title = `SFTP: ${session.name || session.host}`;
    this.state = 'connecting';
    this.showHidden = false;
    this.local = new FilePane(this, 'local');
    this.remote = new FilePane(this, 'remote');
    this.queue = h('div.transfer-queue');
    this.el = h('div.pane.sftp-pane', { dataset: { tab: this.id } },
      h('div.pane-title', {}, this.title),
      h('div.sftp-panes', {},
        this.local.el,
        h('div.sftp-mid', {},
          h('button', { title: 'Upload selected', onclick: () => this.transfer('local', [...this.local.selected]) }, 'Upload →'),
          h('button', { title: 'Download selected', onclick: () => this.transfer('remote', [...this.remote.selected]) }, '← Download')),
        this.remote.el),
      this.queue);
    this.el.addEventListener('mousedown', () => app.activate(this, false));
    this.offProgress = window.api.sftp.onProgress((p) => this.onProgress(p));
    this.offClosed = window.api.sftp.onClosed((id) => { if (id === this.id) { this.state = 'disconnected'; app.renderTabs(); toast('SFTP session closed', 'warn'); } });
    this.transfers = new Map();
  }

  get displayTitle() { return this.title; }

  async connect() {
    this.state = 'connecting';
    this.app.renderTabs();
    try {
      const info = await window.api.sftp.open(this.id, this.session.id || this.session);
      this.home = info.home;
      this.state = 'connected';
      this.connectedAt = Date.now();
      this.username = info.username;
      await Promise.all([this.local.load(''), this.remote.load(info.home)]);
    } catch (e) {
      this.state = 'failed';
      toast(`SFTP: ${errMsg(e)}`, 'error', 6000);
    }
    this.app.renderTabs();
    if (this.app.active === this) this.app.updateStatus();
  }

  refresh() { this.local.load(this.local.path); this.remote.load(this.remote.path); }

  transfer(fromSide, names) {
    if (!names.length) return;
    if (fromSide === 'local') this.uploadPaths(names.map((n) => this.local.join(n)));
    else for (const n of names) this._run('download', this.remote.join(n), this.local.path);
  }

  uploadPaths(paths) {
    for (const p of paths) this._run('upload', p, this.remote.path);
  }

  async _run(kind, src, destDir) {
    const transferId = ++transferSeq;
    const name = src.split(/[\\/]/).pop();
    const bar = h('progress', { max: 100, value: 0 });
    const label = h('span.t-label', {}, `${kind === 'upload' ? '↑' : '↓'} ${name}`);
    const pct = h('span.t-pct', {}, 'queued');
    const row = h('div.transfer', {}, label, bar, pct);
    this.queue.prepend(row);
    this.transfers.set(transferId, { bar, pct, label, name });
    try {
      if (kind === 'upload') await window.api.sftp.upload(this.id, transferId, src, destDir);
      else await window.api.sftp.download(this.id, transferId, src, destDir);
      bar.value = 100;
      pct.textContent = 'done';
      row.classList.add('done');
      (kind === 'upload' ? this.remote : this.local).load(destDir);
      setTimeout(() => row.remove(), 8000);
    } catch (e) {
      pct.textContent = 'failed';
      row.classList.add('failed');
      row.title = errMsg(e);
      toast(`${name}: ${errMsg(e)}`, 'error');
    }
    this.transfers.delete(transferId);
  }

  onProgress({ transferId, file, done, total }) {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const p = total ? Math.round((done / total) * 100) : 100;
    t.bar.value = p;
    t.pct.textContent = `${p}% ${fmtSize(done)}`;
    if (file !== t.name) t.label.textContent = `${t.name} › ${file}`;
  }

  focus() { this.remote.el.querySelector('.file-table-wrap').focus(); }
  fitNow() {}
  applySettings() {}
  disconnect() { window.api.sftp.close(this.id); this.state = 'disconnected'; this.app.renderTabs(); }

  dispose() {
    this.offProgress();
    this.offClosed();
    window.api.sftp.close(this.id);
    this.el.remove();
  }
}
