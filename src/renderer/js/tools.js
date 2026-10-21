// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Dialogs for the network/sysadmin tools: shared credentials, bulk host import, running commands
// on many sessions, SSH keys and tab colors.
import { h, showDialog, field, toast, confirmDialog } from './dom.js';

export const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Tab colors: mark production, lab, customer... at a glance.
export const TAB_COLORS = [
  ['', 'None'], ['#e5484d', 'Red'], ['#f76b15', 'Orange'], ['#ffc53d', 'Yellow'],
  ['#30a46c', 'Green'], ['#0090ff', 'Blue'], ['#8e4ec6', 'Purple'], ['#8b8d98', 'Gray'],
];

/** Protocols that can run commands without a tab. */
export const COMMAND_PROTOCOLS = new Set(['ssh2', 'telnet', 'rlogin', 'serial', 'rnsh']);

function folderOptions(tree, rootLabel = '(top level)') {
  const out = [['', rootLabel]];
  const walk = (parent, depth) => {
    for (const f of tree.folders.filter((x) => (x.parent || '') === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push([f.id, `${'  '.repeat(depth)}${f.name}`]);
      walk(f.id, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

const options = (list, value) => {
  const s = h('select', {}, list.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value ?? list[0]?.[0] ?? '';
  return s;
};

function colorPicker(value) {
  const hidden = h('input', { type: 'hidden', value: value || '' });
  const row = h('div.swatches', { role: 'radiogroup', 'aria-label': 'Color' });
  const render = () => row.replaceChildren(...TAB_COLORS.map(([v, label]) => h('button.swatch', {
    type: 'button', role: 'radio', title: label, 'aria-label': label, 'aria-checked': String(hidden.value === v),
    class: hidden.value === v ? 'on' : '', style: { background: v || 'transparent' },
    onclick: () => { hidden.value = v; render(); },
  }, v ? '' : '∅')));
  render();
  return { el: h('div', {}, row, hidden), get value() { return hidden.value; }, input: hidden };
}

// ---- tab colors ------------------------------------------------------------------
export function colorPickerField(value) { return colorPicker(value); }

export async function folderColorDialog(app, folder) {
  const pick = colorPicker(folder.color);
  const ok = await showDialog({
    title: `Color — ${folder.name}`, width: 420,
    body: h('div.form', {}, h('p.hint', {}, 'Tabs of sessions in this folder (and its subfolders) get this color, unless a session picks its own.'), pick.el),
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
  });
  if (!ok) return;
  await window.api.store.saveFolder({ ...folder, color: pick.value });
  await app.reloadTree();
  app.renderTabs();
}

// ---- shared credentials ---------------------------------------------------------------
async function editCredential(app, cred) {
  const name = h('input', { type: 'text', value: cred?.name || '', placeholder: 'e.g. TACACS, Domain admin, Lab devices', autofocus: true });
  const user = h('input', { type: 'text', value: cred?.username || '', autocomplete: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'off', placeholder: cred?.hasPassword ? '•••••••• (saved — type to replace)' : '' });
  const clear = h('input', { type: 'checkbox' });
  const key = h('input', { type: 'text', value: cred?.keyFile || '', placeholder: '(optional) ~/.ssh/id_ed25519' });
  const phrase = h('input', { type: 'password', autocomplete: 'off', placeholder: cred?.hasPassphrase ? '•••••••• (saved)' : '(optional)' });
  const notes = h('textarea', { rows: 2 }, cred?.notes || '');
  const ok = await showDialog({
    title: cred ? `Credential — ${cred.name}` : 'New Credential', width: 520,
    body: h('div.form', {},
      field('Name', name),
      field('Username', user),
      field('Password', pass, 'Encrypted with the OS keychain. Used for SSH and to answer Telnet/serial login prompts.'),
      cred?.hasPassword ? h('label.check', {}, clear, 'Clear saved password') : null,
      field('Private key file', h('div.row', {}, key, h('button.small', { type: 'button', onclick: async () => { const f = await window.api.dialog.openFile({ title: 'Private key' }); if (f) key.value = f; } }, 'Browse…'))),
      field('Key passphrase', phrase),
      field('Notes', notes)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true, validate: () => (name.value.trim() || user.value.trim() ? null : 'Enter a name or username') }],
  });
  if (!ok) return null;
  const out = { id: cred?.id, name: name.value.trim() || user.value.trim(), username: user.value.trim(), keyFile: key.value.trim(), notes: notes.value };
  if (pass.value) out.password = pass.value; else if (clear.checked) out.password = '';
  if (phrase.value) out.passphrase = phrase.value;
  try {
    const saved = await window.api.store.saveCredential(out);
    await app.reloadTree();
    return saved;
  } catch (e) { toast(errMsg(e), 'error'); return null; }
}

export async function credentialsDialog(app) {
  const list = h('div.cred-list');
  const render = () => {
    const creds = app.tree.credentials || [];
    list.replaceChildren(creds.length
      ? h('table.scp-table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Username', 'Login', 'Used by', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, creds.map((c) => h('tr', {},
          h('td', {}, c.name), h('td', {}, c.username || '—'),
          h('td', {}, [c.hasPassword ? 'password' : '', c.keyFile ? 'key' : ''].filter(Boolean).join(' + ') || '—'),
          h('td.num', {}, `${c.usedBy} session${c.usedBy === 1 ? '' : 's'}`),
          h('td.row-actions', {},
            h('button.small', { onclick: async () => { if (await editCredential(app, c)) render(); } }, 'Edit'),
            h('button.small', {
              onclick: async () => {
                if (!await confirmDialog('Delete Credential', `Delete "${c.name}"?${c.usedBy ? ` ${c.usedBy} session(s) use it and will ask for a login instead.` : ''}`, 'Delete', true)) return;
                await window.api.store.deleteCredential(c.id);
                await app.reloadTree();
                render();
              },
            }, 'Delete'))))))
      : h('p.hint', {}, 'No shared credentials yet.'));
  };
  render();
  await showDialog({
    title: 'Credentials', width: 680,
    body: h('div.form', {},
      h('p.hint', {}, 'A credential is one login (username + password and/or key) shared by many sessions, such as your TACACS/RADIUS or domain account. Pick it in Session Options → Authentication. When the password changes, update it here once — or just log in once with the new one and choose "Save login".'),
      list,
      h('div', {}, h('button', { onclick: async () => { if (await editCredential(app, null)) render(); } }, '+ New Credential'))),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

export function credentialOptions(app) {
  return [['', '(none)'], ...(app.tree.credentials || []).map((c) => [c.id, `${c.name}${c.username ? ` (${c.username})` : ''}`])];
}

// ---- bulk host import -------------------------------------------------------------------
export async function importHostsDialog(app, parentFolder = '') {
  const text = h('textarea.mono', {
    rows: 10, spellcheck: false,
    placeholder: 'Paste a CSV with a header row, or one host per line:\n\nname,host,folder,protocol,credential\ncore-sw-01,10.10.0.1,HQ/Core,ssh,TACACS\nedge-rtr-01,10.10.0.254,HQ/Edge,telnet,\n\n— or —\n\n10.20.0.1\nbranch-sw-02 10.20.0.2',
  });
  const proto = options([['ssh2', 'SSH2'], ['telnet', 'Telnet'], ['rlogin', 'Rlogin'], ['raw', 'Raw TCP'], ['vnc', 'VNC'], ['rdp', 'RDP'], ...(app.settings.reticulum?.enabled ? [['rnsh', 'RNSH (Reticulum)']] : [])], 'ssh2');
  const port = h('input', { type: 'number', min: 0, max: 65535, placeholder: 'default' });
  const user = h('input', { type: 'text', placeholder: '(none)' });
  const cred = options(credentialOptions(app), '');
  const folder = options(folderOptions(app.tree), parentFolder);
  const skip = h('input', { type: 'checkbox', checked: true });
  const preview = h('div.import-preview');
  let parsed = { rows: [], errors: [] };
  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      parsed = await window.api.store.parseHosts(text.value, { protocol: proto.value, port: Number(port.value) || 0, username: user.value.trim() });
      const rows = parsed.rows;
      preview.replaceChildren(...[
        h('p.hint', {}, rows.length ? `${rows.length} host${rows.length === 1 ? '' : 's'} found${parsed.errors.length ? `, ${parsed.errors.length} line(s) skipped` : ''}.` : 'Nothing to import yet.'),
        rows.length ? h('div.table-scroll', {}, h('table.scp-table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Host', 'Port', 'Protocol', 'User', 'Folder', 'Credential', 'Jump'].map((c) => h('th', {}, c)))),
          h('tbody', {}, rows.slice(0, 100).map((r) => h('tr', {}, [r.name, r.host, r.port, r.protocol, r.username, r.folder, r.credential, r.jump].map((v) => h('td', {}, String(v ?? '')))))))) : null,
        parsed.errors.length ? h('p.error', {}, parsed.errors.slice(0, 5).join('\n')) : null].filter(Boolean));
    }, 200);
  };
  for (const el of [text, proto, port, user]) el.addEventListener('input', refresh);
  proto.addEventListener('change', refresh);
  const ok = await showDialog({
    title: 'Import Hosts', width: 900, className: 'import-dialog',
    body: h('div.form', {},
      h('div.row', {},
        h('span.hint', {}, 'Columns are matched by header name: name, host/ip/address, port, protocol, username, folder/site (use / for subfolders), credential, jump/bastion, notes.'),
        h('button.small', {
          type: 'button',
          onclick: async () => {
            const f = await window.api.dialog.openFile({ title: 'Hosts file (CSV or text)', filters: [{ name: 'CSV or text', extensions: ['csv', 'txt', 'tsv'] }, { name: 'All files', extensions: ['*'] }] });
            if (!f) return;
            try { text.value = await window.api.file.readText(f); refresh(); } catch (e) { toast(errMsg(e), 'error'); }
          },
        }, 'Open File…')),
      text,
      h('div.row.wrap', {},
        field('Default protocol', proto), field('Default port', port), field('Default username', user),
        field('Credential', cred), field('Import into', folder)),
      h('label.check', {}, skip, 'Skip hosts that already have a session (same host, port and protocol)'),
      preview),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Import', value: true, primary: true, validate: () => (parsed.rows.length ? null : 'No hosts to import') }],
  });
  if (!ok) return;
  const r = await window.api.store.importHosts(parsed.rows, { folder: folder.value, credentialId: cred.value, skipExisting: skip.checked });
  await app.reloadTree();
  toast(`Imported ${r.created} session${r.created === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already existed)` : ''}`);
  if (r.warnings.length) toast(r.warnings.slice(0, 3).join('\n') + (r.warnings.length > 3 ? `\n…and ${r.warnings.length - 3} more` : ''), 'warn', 9000);
}

// ---- run commands on many sessions ------------------------------------------------------
/** Session checklist grouped by folder. Returns { el, selected(): string[] }. */
function sessionPicker(app, preselected) {
  const { folders, sessions } = app.tree;
  const usable = sessions.filter((s) => COMMAND_PROTOCOLS.has(s.protocol));
  const checked = new Set(preselected.filter((id) => usable.some((s) => s.id === id)));
  const filter = h('input', { type: 'search', placeholder: 'Filter by name or host', 'aria-label': 'Filter sessions' });
  const count = h('span.hint');
  const tree = h('div.picker-tree');
  const onChange = [];
  const subtree = (folderId) => {
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) { grew = false; for (const f of folders) if (!ids.has(f.id) && ids.has(f.parent)) { ids.add(f.id); grew = true; } }
    return usable.filter((s) => ids.has(s.parent || ''));
  };
  const render = () => {
    const q = filter.value.toLowerCase();
    const match = (s) => !q || [s.name, s.host, s.serial?.path].some((v) => v && String(v).toLowerCase().includes(q));
    const rows = [];
    const walk = (parent, depth) => {
      for (const f of folders.filter((x) => (x.parent || '') === parent).sort((a, b) => a.name.localeCompare(b.name))) {
        const inside = subtree(f.id).filter(match);
        if (!inside.length) continue;
        const all = inside.every((s) => checked.has(s.id));
        const box = h('input', { type: 'checkbox', checked: all, onchange: () => { for (const s of inside) if (box.checked) checked.add(s.id); else checked.delete(s.id); render(); } });
        box.indeterminate = !all && inside.some((s) => checked.has(s.id));
        rows.push(h('label.picker-row.folder', { style: { paddingLeft: depth * 16 + 'px' } }, box, h('strong', {}, f.name), h('span.hint', {}, ` ${inside.length}`)));
        walk(f.id, depth + 1);
      }
      for (const s of usable.filter((x) => (x.parent || '') === parent && match(x)).sort((a, b) => a.name.localeCompare(b.name))) {
        rows.push(h('label.picker-row', { style: { paddingLeft: depth * 16 + 'px' } },
          h('input', { type: 'checkbox', checked: checked.has(s.id), onchange: (e) => { if (e.target.checked) checked.add(s.id); else checked.delete(s.id); update(); } }),
          s.name, h('span.hint', {}, ` ${s.protocol === 'serial' ? s.serial?.path : s.host}`)));
      }
    };
    walk('', 0);
    tree.replaceChildren(...(rows.length ? rows : [h('p.hint', {}, usable.length ? 'No matches' : 'No SSH2, Telnet, Rlogin or Serial sessions yet.')]));
    update();
  };
  const update = () => { count.textContent = `${checked.size} selected`; onChange.forEach((f) => f()); };
  filter.addEventListener('input', render);
  render();
  return {
    el: h('div.picker', {}, h('div.row', {}, filter,
      h('button.small', { type: 'button', onclick: () => { usable.forEach((s) => checked.add(s.id)); render(); } }, 'All'),
      h('button.small', { type: 'button', onclick: () => { checked.clear(); render(); } }, 'None'), count), tree),
    selected: () => [...checked],
    onChange: (f) => onChange.push(f),
  };
}

function storageGet(key, def = '') { try { return localStorage.getItem(key) ?? def; } catch { return def; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

export async function runCommandsDialog(app, { sessionIds = [], folderId = null } = {}) {
  if (folderId != null) {
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) { grew = false; for (const f of app.tree.folders) if (!ids.has(f.id) && ids.has(f.parent)) { ids.add(f.id); grew = true; } }
    sessionIds = app.tree.sessions.filter((s) => ids.has(s.parent || '')).map((s) => s.id);
  }
  const picker = sessionPicker(app, sessionIds);
  const commands = h('textarea.mono', { rows: 8, spellcheck: false, placeholder: 'One command per line, e.g.\nshow version\nshow ip interface brief\nshow running-config' });
  commands.value = storageGet('termcraft.batch.commands');
  const concurrency = options([['1', '1 at a time'], ['5', '5 at a time'], ['10', '10 at a time'], ['20', '20 at a time']], storageGet('termcraft.batch.concurrency', '5'));
  const timeout = h('input', { type: 'number', min: 5, max: 3600, value: storageGet('termcraft.batch.timeout', '60') });
  const outDir = h('input', { type: 'text', readOnly: true, placeholder: `${app.info.home}/TermCraft Output` });
  const ok = await showDialog({
    title: 'Run Commands on Sessions', width: 960, className: 'batch-dialog',
    body: h('div.batch-grid', {},
      h('div.form', {}, h('h4', {}, 'Sessions'), picker.el),
      h('div.form', {},
        h('h4', {}, 'Commands'), commands,
        h('p.hint', {}, 'Runs in the background — no tabs open. Each session’s output is saved to its own file. Logins come from the session or its credential; Telnet/serial login prompts are answered automatically, and “--More--” pagers are handled for you.'),
        h('div.row.wrap', {}, field('Parallel', concurrency), field('Timeout per command (s)', timeout)),
        field('Save output in', h('div.row', {}, outDir,
          h('button.small', { type: 'button', onclick: async () => { const d = await window.api.dialog.openDir({ title: 'Folder for the output files' }); if (d) outDir.value = d; } }, 'Browse…'),
          h('button.small', { type: 'button', onclick: () => { outDir.value = ''; } }, 'Default')), 'A new dated folder is created inside it for each run.'))),
    buttons: [{ label: 'Cancel', value: false }, {
      label: 'Run', value: true, primary: true,
      validate: () => (!picker.selected().length ? 'Select at least one session' : !commands.value.trim() ? 'Enter at least one command' : null),
    }],
  });
  if (!ok) return;
  const list = commands.value.split(/\r?\n/).filter((c) => c.trim());
  storageSet('termcraft.batch.commands', commands.value);
  storageSet('termcraft.batch.concurrency', concurrency.value);
  storageSet('termcraft.batch.timeout', timeout.value);
  const ids = picker.selected();
  if (ids.length > 1 && /^\s*(conf|configure|write|wr\b|copy|reload|delete|erase|format|rm |shutdown|reboot|commit|request system)/im.test(commands.value)
    && !await confirmDialog('Change Many Devices?', `These commands can change configuration or restart devices, and will run on ${ids.length} sessions:\n\n${list.slice(0, 8).join('\n')}${list.length > 8 ? '\n…' : ''}`, `Run on ${ids.length} sessions`, true)) return;
  app.openBatch({ sessionIds: ids, commands: list, concurrency: Number(concurrency.value), timeoutSec: Number(timeout.value), outputDir: outDir.value || '' });
}

// ---- SSH keys -------------------------------------------------------------------------
export async function sshKeysDialog(app) {
  const list = h('div');
  let keys = [];
  const render = async () => {
    keys = await window.api.keys.list();
    list.replaceChildren(keys.length
      ? h('table.scp-table', {},
        h('thead', {}, h('tr', {}, ['File', 'Type', 'Comment', 'Fingerprint', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, keys.map((k) => h('tr', {},
          h('td', {}, k.file.split(/[\\/]/).pop()), h('td', {}, k.type), h('td', {}, k.comment), h('td.mono', { title: k.fingerprint }, `${k.fingerprint.slice(0, 22)}…`),
          h('td.row-actions', {}, h('button.small', { onclick: () => { window.api.clipboard.write(k.line); toast('Public key copied'); } }, 'Copy'))))))
      : h('p.hint', {}, 'No public keys in ~/.ssh yet.'));
  };
  await render();
  const name = h('input', { type: 'text', value: 'id_ed25519', 'aria-label': 'Key file name' });
  const kind = options([['ed25519', 'Ed25519 (recommended)'], ['rsa-4096', 'RSA 4096 (older servers and devices)'], ['ecdsa-256', 'ECDSA P-256']], 'ed25519');
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '(recommended)' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const comment = h('input', { type: 'text', placeholder: 'you@laptop' });
  // Suggest a file name that doesn't exist yet (id_ed25519, then id_ed25519_2, ...).
  const freeName = () => {
    const base = { ed25519: 'id_ed25519', 'rsa-4096': 'id_rsa', 'ecdsa-256': 'id_ecdsa' }[kind.value];
    const taken = new Set(keys.map((k) => k.file.split(/[\\/]/).pop().replace(/\.pub$/, '')));
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
    return n;
  };
  name.value = freeName();
  kind.addEventListener('change', () => { if (/^id_(ed25519|rsa|ecdsa)(_\d+)?$/.test(name.value)) name.value = freeName(); });
  const generate = async () => {
    if (p1.value !== p2.value) return toast('The passphrases do not match', 'error');
    try {
      const k = await window.api.keys.generate({ name: name.value.trim(), kind: kind.value, passphrase: p1.value, comment: comment.value.trim() });
      p1.value = ''; p2.value = '';
      window.api.clipboard.write(k.line);
      toast(`Created ${k.privateKey} — public key copied to the clipboard`, 'info', 6000);
      await render();
      name.value = freeName();
    } catch (e) { toast(errMsg(e), 'error', 6000); }
  };
  await showDialog({
    title: 'SSH Keys', width: 820,
    body: h('div.form', {},
      h('h4', {}, 'Your public keys (~/.ssh)'), list,
      h('h4', {}, 'Create a new key'),
      h('div.row.wrap', {}, field('Type', kind), field('File name', name), field('Comment', comment)),
      h('div.row.wrap', {}, field('Passphrase', p1), field('Confirm passphrase', p2)),
      h('div', {}, h('button', { onclick: generate }, 'Create Key')),
      h('p.hint', {}, 'To log in with a key, right-click a session → Install SSH Key… (like ssh-copy-id), then set the key in Session Options → Authentication.')),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

export async function installKeyDialog(app, session) {
  const keys = await window.api.keys.list();
  if (!keys.length) { toast('Create a key first (Tools → SSH Keys…)', 'warn'); return sshKeysDialog(app); }
  const sel = options(keys.map((k) => [k.file, `${k.file.split(/[\\/]/).pop()} — ${k.type} ${k.comment}`]), keys.find((k) => /ed25519/.test(k.type))?.file || keys[0].file);
  const use = h('input', { type: 'checkbox', checked: true });
  const ok = await showDialog({
    title: `Install SSH Key — ${session.name}`, width: 560,
    body: h('div.form', {},
      h('p', {}, `Adds the public key to ~/.ssh/authorized_keys on ${session.username ? session.username + '@' : ''}${session.host}, so you can log in without a password. You may be asked for the password one last time.`),
      field('Public key', sel),
      h('label.check', {}, use, 'Use this key for the session from now on')),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Install', value: true, primary: true }],
  });
  if (!ok) return;
  try {
    const r = await window.api.keys.install(session.id || session, sel.value);
    toast(r.status === 'added' ? `Key installed on ${session.name}` : `${session.name} already has this key`);
    if (use.checked && r.privateKey && session.id) {
      const copy = JSON.parse(JSON.stringify(session));
      copy.auth = { ...(copy.auth || {}), keyFile: r.privateKey, methods: ['publickey', ...((copy.auth?.methods || ['keyboard-interactive', 'password']).filter((m) => m !== 'publickey'))] };
      delete copy.auth.hasPassword; delete copy.auth.hasPassphrase;
      await window.api.store.saveSession(copy);
      await app.reloadTree();
    }
  } catch (e) { toast(`Install failed: ${errMsg(e)}`, 'error', 8000); }
}

// ---- order a series of files before sending ----------------------------------------------
/**
 * Put several files in the order the device expects (e.g. a firmware package delivered as a
 * series of files). The order used last time for the same session and file names is remembered.
 */
export async function orderFilesDialog(app, { tabId, protocol, files }) {
  const tab = app.tabs.find((t) => t.id === tabId);
  const key = `termcraft.fileOrder.${tab?.session?.id || tab?.session?.host || 'any'}`;
  const base = (f) => f.split(/[\\/]/).pop();
  let remembered = [];
  try { remembered = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* none */ }
  const rank = (f) => { const i = remembered.indexOf(base(f)); return i < 0 ? 1e6 : i; };
  const list = [...files].sort((a, b) => rank(a) - rank(b) || base(a).localeCompare(base(b), undefined, { numeric: true }));
  const body = h('div');
  const render = () => body.replaceChildren(h('table.scp-table', {}, h('tbody', {}, list.map((f, i) => h('tr', {},
    h('td.num', {}, String(i + 1)), h('td.name', { title: f }, base(f)),
    h('td.row-actions', {},
      h('button.icon-btn', { type: 'button', title: 'Move up', 'aria-label': `Move ${base(f)} up`, disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; render(); } }, '↑'),
      h('button.icon-btn', { type: 'button', title: 'Move down', 'aria-label': `Move ${base(f)} down`, disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; render(); } }, '↓'),
      h('button.icon-btn', { type: 'button', title: 'Remove', 'aria-label': `Remove ${base(f)}`, disabled: list.length === 1, onclick: () => { list.splice(i, 1); render(); } }, '✕')))))));
  render();
  const ok = await showDialog({
    title: `Send ${list.length} Files — ${String(protocol).toUpperCase()}`, width: 560,
    body: h('div.form', {}, h('p.hint', {}, 'Files are sent in this order. TermCraft remembers the order for this session.'), body),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Send', value: true, primary: true }],
  });
  if (!ok) return null;
  try { localStorage.setItem(key, JSON.stringify([...list.map(base), ...remembered.filter((n) => !list.some((f) => base(f) === n))].slice(0, 200))); } catch { /* storage unavailable */ }
  return list;
}
