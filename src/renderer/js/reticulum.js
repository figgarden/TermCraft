// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Reticulum (RNS): reach devices by destination hash. Hidden unless turned on in
// Settings → General. Each tool runs in a terminal tab:
//   rnsh ≈ ssh · rncp ≈ scp · rnx ≈ "ssh host command" · rnprobe ≈ ping · rnpath ≈ traceroute · rnstatus ≈ show interfaces
import { h, showDialog, fillForm, collectForm, field, input, number, checkbox, toast } from './dom.js';

/** A destination or identity hash (32 hex digits) from the forms people paste: <hash>, rnsh://hash, with colons. */
export function normalizeHash(s) {
  const t = String(s || '').trim().replace(/^rnsh?:\/\//i, '').replace(/[<>\s:/]/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
}

export const enabled = (app) => !!app.settings.reticulum?.enabled;

/** "b72e…74a4" for tab names. */
export const shortHash = (hash) => `${hash.slice(0, 4)}…${hash.slice(-4)}`;

/** The hash of the active rnsh tab or the selected rnsh session, to prefill dialogs. */
function currentHash(app) {
  const t = app.active;
  if (t?.cfg?.protocol === 'rnsh') return t.cfg.host;
  const sel = app.sm.selected?.kind === 'session' && app.tree.sessions.find((s) => s.id === app.sm.selected.id);
  return sel?.protocol === 'rnsh' ? sel.host : '';
}

/** Ask for a destination hash (and any extra fields). Returns the form values or null. */
async function ask(app, title, { extra = [], data = {}, okLabel = 'Run', hint = '' } = {}) {
  const body = h('div.form', {},
    field('Destination hash', input('dest', { placeholder: '<a1b2c3…> — 32 hex digits', autofocus: true, spellcheck: false }), hint),
    ...extra);
  fillForm(body, { dest: currentHash(app), ...data });
  const ok = await showDialog({
    title, body, width: 520,
    buttons: [{ label: 'Cancel', value: false }, {
      label: okLabel, value: true, primary: true,
      validate: () => (normalizeHash(body.querySelector('[data-path="dest"]').value) ? null : 'Enter a destination hash: 32 hex digits'),
    }],
  });
  if (!ok) return null;
  const v = collectForm(body, {});
  return { ...v, dest: normalizeHash(v.dest) };
}

/** Run a Reticulum tool in its own terminal tab. */
function runTool(app, name, rntool) {
  return app.openSession({ name, protocol: 'rntool', rntool, terminal: { tabColor: '' } });
}

export async function rnshConnect(app) {
  const v = await ask(app, 'Connect to Destination Hash (rnsh)', {
    okLabel: 'Connect',
    hint: 'The hash an rnsh listener prints (“listening on <…>”).',
    extra: [checkbox('save', 'Save session')],
  });
  if (!v) return;
  let session = { name: `rnsh ${shortHash(v.dest)}`, protocol: 'rnsh', host: v.dest, port: 0 };
  if (v.save) {
    session = await window.api.store.saveSession(session);
    await app.reloadTree();
  }
  return app.openSession(session);
}

export async function rnsExec(app) {
  const v = await ask(app, 'Run Remote Command (rnx)', {
    hint: 'The hash of an rnx listener (rnx -l).',
    extra: [field('Command', input('command', { placeholder: 'uptime' }), 'Runs on the remote system; its output and exit code are shown.')],
  });
  if (!v) return;
  if (!v.command.trim()) return toast('Enter a command', 'warn');
  return runTool(app, `rnx ${shortHash(v.dest)}`, { tool: 'exec', dest: v.dest, command: v.command });
}

export async function rnsProbe(app) {
  const v = await ask(app, 'Probe Destination (rnprobe)', {
    data: { fullName: 'rnstransport.probe', probes: 4 },
    hint: 'Like ping: round-trip time and hops. The destination must answer probes.',
    extra: [h('div.row', {},
      field('Destination name', input('fullName', { spellcheck: false }), 'Its app and aspects, e.g. rnstransport.probe'),
      field('Probes', number('probes', { min: 1, max: 100 })))],
  });
  if (!v) return;
  return runTool(app, `rnprobe ${shortHash(v.dest)}`, { tool: 'probe', dest: v.dest, fullName: v.fullName.trim(), probes: Number(v.probes) || 4 });
}

export async function rnsPath(app) {
  const v = await ask(app, 'Find Path to Destination (rnpath)', { hint: 'Like traceroute: requests a path and shows hops and the interface it goes out of.' });
  if (v) return runTool(app, `rnpath ${shortHash(v.dest)}`, { tool: 'path', dest: v.dest });
}

export const rnsPaths = (app) => runTool(app, 'rnpath -t', { tool: 'paths' });
export const rnsStatus = (app) => runTool(app, 'rnstatus', { tool: 'status', all: true });
export const rnsIdentity = (app) => runTool(app, 'rnsh identity', { tool: 'identity' });

export async function rnsSend(app) {
  const file = await window.api.dialog.openFile({ title: 'File to send over Reticulum' });
  if (!file) return;
  const v = await ask(app, `Send ${file.split(/[\\/]/).pop()} (rncp)`, { okLabel: 'Send', hint: 'The hash of an rncp listener (rncp -l).' });
  if (v) return runTool(app, `rncp → ${shortHash(v.dest)}`, { tool: 'send', dest: v.dest, file });
}

export async function rnsFetch(app) {
  const saveDir = input('saveDir', { placeholder: '~/Downloads', readonly: true });
  const v = await ask(app, 'Fetch File over Reticulum (rncp)', {
    okLabel: 'Fetch',
    hint: 'The hash of an rncp listener that allows fetching (rncp -l -F).',
    extra: [
      field('Remote file', input('remotePath', { placeholder: 'configs/router1.cfg', spellcheck: false })),
      field('Save in', h('div.row', {}, saveDir, h('button.small', { type: 'button', onclick: async () => { const d = await window.api.dialog.openDir({ title: 'Save fetched files in' }); if (d) saveDir.value = d; } }, 'Browse…'))),
    ],
  });
  if (!v) return;
  if (!v.remotePath.trim()) return toast('Enter the remote file', 'warn');
  return runTool(app, `rncp ← ${shortHash(v.dest)}`, { tool: 'fetch', dest: v.dest, remotePath: v.remotePath.trim(), saveDir: v.saveDir });
}

/** Settings → General: the toggle, plus folders that only show while it is on. */
export function settingsSection() {
  const status = h('span.hint.rns-tools');
  const binDir = input('reticulum.binDir', { placeholder: '(automatic: PATH, ~/.local/bin, Python user folders)' });
  let seq = 0;
  const refresh = async () => {
    const mine = ++seq;
    try {
      const found = await window.api.rns.tools(binDir.value.trim());
      if (mine !== seq) return; // a newer lookup is running
      const order = ['rnsh', 'rncp', 'rnx', 'rnstatus', 'rnpath', 'rnprobe', 'rnid'];
      const have = order.filter((n) => found[n]);
      const missing = order.filter((n) => n in found && !found[n]);
      status.textContent = have.length
        ? `Found: ${have.join(', ')}${missing.length ? ` · not found: ${missing.join(', ')}` : ''}`
        : 'Reticulum tools not found. Install them with: pipx install rns and pipx install rnsh, or choose their folder.';
    } catch (e) { status.textContent = String(e?.message || e); }
  };
  const details = h('div.rns-only', {},
    field('Tools folder', h('div.row', {}, binDir, h('button.small', { type: 'button', onclick: async () => { const d = await window.api.dialog.openDir({ title: 'Folder with rnsh, rncp, rnstatus…' }); if (d) { binDir.value = d; refresh(); } } }, 'Browse…')), status),
    field('Config folder', input('reticulum.configDir', { placeholder: '~/.reticulum (default)' }), 'Uses the running rnsd shared instance when there is one.'),
    field('Identity file', input('reticulum.identity', { placeholder: '(each tool’s own identity)' }), 'Used by rncp and rnx, and by rnsh sessions that don’t set their own.'));
  const toggle = checkbox('reticulum.enabled', 'Reticulum (RNS) — connect by destination hash: rnsh sessions, rncp, rnx, rnprobe, rnpath, rnstatus', {
    onchange: (e) => { details.hidden = !e.target.checked; if (e.target.checked) refresh(); },
  });
  binDir.addEventListener('change', refresh);
  const el = h('div.rns-settings', {}, toggle, details);
  // Called after the form is filled.
  el.sync = () => { details.hidden = !toggle.querySelector('input').checked; if (!details.hidden) refresh(); };
  return el;
}
