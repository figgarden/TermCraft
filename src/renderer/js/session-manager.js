// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { h, contextMenu, confirmDialog, promptDialog, toast } from './dom.js';
import { editSession, PROTOCOL_LABEL } from './session-editor.js';
import { icon } from './icons.js';
import { folderColorDialog, importHostsDialog, installKeyDialog, COMMAND_PROTOCOLS } from './tools.js';

// Short text labels (not symbols): they look the same on every system and font.
const ICON = { ssh2: 'SSH', telnet: 'TEL', rlogin: 'RLG', serial: 'COM', raw: 'TCP', local: 'SH', vnc: 'VNC', rdp: 'RDP', rnsh: 'RNS' };

function loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem('termcraft.expanded') || '[]')); } catch { return new Set(); }
}
function saveExpanded(set) {
  try { localStorage.setItem('termcraft.expanded', JSON.stringify([...set])); } catch { /* storage unavailable */ }
}

export class SessionManager {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.expanded = loadExpanded();
    this.selected = null; // { kind, id }
    this.filter = '';

    this.filterInput = h('input', {
      type: 'search', placeholder: 'Filter sessions', 'aria-label': 'Filter sessions',
      oninput: (e) => { this.filter = e.target.value.toLowerCase(); this.render(); },
      onkeydown: (e) => {
        if (e.key === 'Enter') { const first = this.treeEl.querySelector('.node.session'); first?.dispatchEvent(new MouseEvent('dblclick')); }
      },
    });
    this.treeEl = h('div.tree', {
      tabindex: 0, role: 'tree', 'aria-label': 'Sessions',
      onkeydown: (e) => this.onKey(e),
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => this.onDrop(e, ''),
      oncontextmenu: (e) => {
        if (e.target !== this.treeEl) return;
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'New Session…', action: () => this.newSession('') },
          { label: 'New Folder…', action: () => this.newFolder('') },
          { label: 'Import Hosts…', action: () => importHostsDialog(this.app, '') },
        ]);
      },
    });
    root.append(
      h('div.sm-head', {},
        h('span.sm-title', {}, 'Sessions'),
        h('button.icon-btn', { title: 'New session', 'aria-label': 'New session', onclick: () => this.newSession(this.currentFolder()) }, icon('plus', 16)),
        h('button.icon-btn', { title: 'New folder', 'aria-label': 'New folder', onclick: () => this.newFolder(this.currentFolder()) }, icon('folderPlus', 16)),
        h('button.icon-btn.sm-collapse', { title: 'Collapse Session Manager', 'aria-label': 'Collapse Session Manager', onclick: () => this.app.dispatch('toggleSessionManager') }, icon('chevronsLeft', 16))),
      h('div.sm-filter', {}, this.filterInput),
      this.treeEl);
  }

  currentFolder() {
    if (!this.selected) return '';
    if (this.selected.kind === 'folder') return this.selected.id;
    return this.app.tree.sessions.find((s) => s.id === this.selected.id)?.parent || '';
  }

  render() {
    const { folders, sessions } = this.app.tree;
    const f = this.filter;
    const matches = (s) => !f || [s.name, s.host, s.username, s.serial?.path].some((v) => v && String(v).toLowerCase().includes(f));
    const folderHasMatch = (id) => sessions.some((s) => s.parent === id && matches(s)) || folders.some((c) => c.parent === id && folderHasMatch(c.id));

    const build = (parent, depth) => {
      const nodes = [];
      for (const fo of folders.filter((x) => (x.parent || '') === parent).sort((a, b) => a.name.localeCompare(b.name))) {
        if (f && !folderHasMatch(fo.id)) continue;
        const open = f || this.expanded.has(fo.id);
        nodes.push(this._node('folder', fo, depth, open));
        if (open) nodes.push(...build(fo.id, depth + 1));
      }
      for (const s of sessions.filter((x) => (x.parent || '') === parent).sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        if (matches(s)) nodes.push(this._node('session', s, depth));
      }
      return nodes;
    };
    const nodes = build('', 0);
    this.treeEl.replaceChildren(...(nodes.length ? nodes : [h('div.empty', {}, f ? 'No matching sessions' : 'No sessions yet. Click ＋ to create one, or use Quick Connect.')]));
  }

  _node(kind, item, depth, open) {
    const isSel = this.selected?.kind === kind && this.selected.id === item.id;
    const label = kind === 'folder' ? item.name : (item.name || item.host);
    const sub = kind === 'session' ? (item.protocol === 'serial' ? item.serial?.path : item.protocol === 'local' ? 'local' : `${item.username ? item.username + '@' : ''}${item.host}`) : '';
    const color = kind === 'folder' ? item.color : item.terminal?.tabColor;
    const el = h('div.node', {
      class: `${kind}${isSel ? ' sel' : ''}${color ? ' colored' : ''}`, role: 'treeitem', 'aria-selected': String(isSel),
      'aria-expanded': kind === 'folder' ? String(!!open) : null,
      style: { paddingLeft: 8 + depth * 14 + 'px', ...(color ? { '--node-color': color } : {}) },
      draggable: true,
      title: kind === 'session' ? `${PROTOCOL_LABEL[item.protocol] || item.protocol} — ${sub}${item.notes ? '\n\n' + item.notes : ''}` : '',
      onclick: () => { this.selected = { kind, id: item.id }; if (kind === 'folder') this.toggle(item.id); else this.render(); },
      ondblclick: () => (kind === 'session' ? this.app.openSession(item) : null),
      oncontextmenu: (e) => { e.preventDefault(); this.selected = { kind, id: item.id }; this.render(); this.menu(e, kind, item); },
      ondragstart: (e) => e.dataTransfer.setData('application/x-termcraft-node', JSON.stringify({ kind, id: item.id })),
      ondragover: (e) => { if (kind === 'folder') { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } },
      ondragleave: () => el.classList.remove('drop'),
      ondrop: (e) => { el.classList.remove('drop'); if (kind === 'folder') { e.stopPropagation(); this.onDrop(e, item.id); } },
    },
    kind === 'folder' ? h('span.twisty', {}, open ? '▾' : '▸') : h('span.proto', { class: item.protocol }, ICON[item.protocol] || '?'),
    h('span.name', {}, label),
    sub ? h('span.sub', {}, sub) : null);
    return el;
  }

  toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    saveExpanded(this.expanded);
    this.render();
  }

  async onDrop(e, folderId) {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-termcraft-node');
    if (!raw) return;
    const { kind, id } = JSON.parse(raw);
    if (kind === 'folder' && id === folderId) return;
    await window.api.store.move(kind, id, folderId);
    if (folderId) this.expanded.add(folderId);
    await this.app.reloadTree();
  }

  onKey(e) {
    const nodes = [...this.treeEl.querySelectorAll('.node')];
    const idx = nodes.findIndex((n) => n.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      next?.click();
      this.treeEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      this.connectSelected();
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      this.deleteSelected();
    } else if (e.key === 'F2') {
      this.renameSelected();
    }
  }

  menu(e, kind, item) {
    if (kind === 'folder') {
      contextMenu(e.clientX, e.clientY, [
        { label: 'Connect All in Folder', action: () => this.connectFolder(item.id) },
        { label: 'Run Commands on Folder…', action: () => this.app.runCommands({ folderId: item.id }) },
        '-',
        { label: 'New Session…', action: () => this.newSession(item.id) },
        { label: 'New Folder…', action: () => this.newFolder(item.id) },
        { label: 'Import Hosts Here…', action: () => importHostsDialog(this.app, item.id) },
        { label: 'Folder Color…', action: () => folderColorDialog(this.app, item) },
        { label: 'Rename…', hint: 'F2', action: () => this.renameSelected() },
        { label: 'Delete Folder', action: () => this.deleteSelected() },
      ]);
      return;
    }
    contextMenu(e.clientX, e.clientY, [
      { label: 'Connect in Tab', action: () => this.app.openSession(item) },
      { label: 'Connect SFTP Tab', action: () => this.app.openSftp(item), disabled: item.protocol !== 'ssh2' },
      { label: 'SCP Transfer Manager', action: () => this.app.openScp(item), disabled: item.protocol !== 'ssh2' },
      { label: 'Run Commands…', action: () => this.app.runCommands({ sessionIds: [item.id] }), disabled: !COMMAND_PROTOCOLS.has(item.protocol) },
      { label: 'Install SSH Key…', action: () => installKeyDialog(this.app, item), disabled: item.protocol !== 'ssh2' },
      '-',
      { label: 'Properties…', action: () => this.editSelected() },
      { label: 'Duplicate', action: () => this.duplicate(item) },
      { label: 'Rename…', hint: 'F2', action: () => this.renameSelected() },
      { label: 'Delete', hint: 'Del', action: () => this.deleteSelected() },
      '-',
      { label: 'Copy Connect String', action: () => { window.api.clipboard.write(`${item.protocol === 'ssh2' ? 'ssh' : item.protocol}://${item.username ? item.username + '@' : ''}${item.host}:${item.port}`); toast('Copied'); }, disabled: !item.host },
    ]);
  }

  connectSelected() {
    if (!this.selected) return;
    if (this.selected.kind === 'folder') return this.connectFolder(this.selected.id);
    const s = this.app.tree.sessions.find((x) => x.id === this.selected.id);
    if (s) this.app.openSession(s);
  }

  connectFolder(folderId) {
    const { folders, sessions } = this.app.tree;
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) { grew = false; for (const f of folders) if (!ids.has(f.id) && ids.has(f.parent)) { ids.add(f.id); grew = true; } }
    const list = sessions.filter((s) => ids.has(s.parent));
    if (!list.length) return toast('Folder has no sessions');
    for (const s of list) this.app.openSession(s);
  }

  async newSession(parent) {
    const saved = await editSession(this.app, null, { parent });
    if (saved) { this.selected = { kind: 'session', id: saved.id }; if (parent) this.expanded.add(parent); this.render(); }
  }

  async newFolder(parent) {
    const name = await promptDialog('New Folder', 'Folder name:');
    if (!name) return;
    const f = await window.api.store.saveFolder({ name, parent });
    if (parent) this.expanded.add(parent);
    this.selected = { kind: 'folder', id: f.id };
    await this.app.reloadTree();
  }

  async editSelected() {
    if (!this.selected) return;
    if (this.selected.kind === 'folder') return this.renameSelected();
    const s = this.app.tree.sessions.find((x) => x.id === this.selected.id);
    if (s) {
      await editSession(this.app, s);
      this.app.refreshTabsForSession(s.id);
    }
  }

  async duplicate(item) {
    const copy = JSON.parse(JSON.stringify(item));
    delete copy.id;
    copy.name = `${item.name} (copy)`;
    delete copy.auth.hasPassword;
    delete copy.auth.hasPassphrase;
    const saved = await window.api.store.saveSession(copy);
    this.selected = { kind: 'session', id: saved.id };
    await this.app.reloadTree();
    if (item.auth?.hasPassword) toast('Duplicated. Saved password was not copied.');
  }

  async renameSelected() {
    if (!this.selected) return;
    const { kind, id } = this.selected;
    const list = kind === 'folder' ? this.app.tree.folders : this.app.tree.sessions;
    const item = list.find((x) => x.id === id);
    const name = await promptDialog('Rename', 'New name:', item?.name || '');
    if (!name) return;
    if (kind === 'folder') await window.api.store.saveFolder({ ...item, name });
    else {
      const copy = { ...item, name, auth: { ...item.auth } };
      delete copy.auth.hasPassword; delete copy.auth.hasPassphrase;
      await window.api.store.saveSession(copy);
    }
    await this.app.reloadTree();
  }

  async deleteSelected() {
    if (!this.selected) return;
    const { kind, id } = this.selected;
    if (kind === 'folder') {
      const f = this.app.tree.folders.find((x) => x.id === id);
      if (!await confirmDialog('Delete Folder', `Delete folder "${f?.name}" and every session and folder inside it?`, 'Delete', true)) return;
      await window.api.store.deleteFolder(id);
    } else {
      const s = this.app.tree.sessions.find((x) => x.id === id);
      if (!await confirmDialog('Delete Session', `Delete session "${s?.name}"?`, 'Delete', true)) return;
      await window.api.store.deleteSession(id);
    }
    this.selected = null;
    await this.app.reloadTree();
  }
}
