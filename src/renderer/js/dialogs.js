// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { h, showDialog, fillForm, collectForm, field, input, number, checkbox, select, listEditor, toast, confirmDialog } from './dom.js';
import { schemeOptions } from './schemes.js';
import { THEMES, THEME_NAMES, resolveTheme } from './themes.js';
import { comboOf } from './terminal-tab.js';
import { FUNCTIONS, COLORS } from './button-bars.js';

const DEFAULT_PORTS = { ssh2: 22, telnet: 23, rlogin: 513, raw: 23, vnc: 5900, rdp: 3389 };

// ---- Quick Connect ----------------------------------------------------------
export async function quickConnect(app) {
  const data = {
    protocol: 'ssh2', host: '', port: 22, username: '', keyFile: '', password: '',
    save: false, sftp: false, ...(app.lastQuickConnect || {}),
  };
  data.password = '';
  const keyFile = input('keyFile', { placeholder: '(optional) ~/.ssh/id_ed25519' });
  const serialPath = input('serialPath', { placeholder: app.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0' });
  const body = h('div.form', {},
    field('Protocol', select('protocol', [['ssh2', 'SSH2'], ['telnet', 'Telnet'], ['rlogin', 'Rlogin'], ['serial', 'Serial'], ['raw', 'Raw TCP'], ['local', 'Local Shell'], ['vnc', 'VNC'], ['rdp', 'RDP']],
      { onchange: (e) => sync(e.target.value, true) })),
    h('div.qc-net', {},
      field('Hostname', input('host', { placeholder: 'host, user@host or user@host:port', autofocus: true })),
      h('div.row', {},
        field('Port', number('port', { min: 1, max: 65535 })),
        field('Username', input('username', { placeholder: '(prompt)' })))),
    h('div.qc-ssh', {},
      field('Password', h('input', { type: 'password', dataset: { path: 'password' }, placeholder: '(prompt if needed)', autocomplete: 'off' })),
      h('div.qc-ssh-only', {},
        field('Public key', h('div.row', {}, keyFile, h('button.small', { type: 'button', onclick: async () => { const f = await window.api.dialog.openFile({ title: 'Private key' }); if (f) keyFile.value = f; } }, 'Browse…'))),
        checkbox('sftp', 'Open as SFTP tab'))),
    h('div.qc-serial', {},
      field('Port', serialPath),
      field('Baud rate', select('baudRate', ['9600', '19200', '38400', '57600', '115200']))),
    checkbox('save', 'Save session'));
  const sync = (p, reset) => {
    body.querySelector('.qc-net').hidden = p === 'serial' || p === 'local';
    body.querySelector('.qc-ssh').hidden = !['ssh2', 'vnc', 'rdp'].includes(p);
    for (const el of body.querySelectorAll('.qc-ssh-only')) el.hidden = p !== 'ssh2';
    body.querySelector('.qc-serial').hidden = p !== 'serial';
    if (reset && DEFAULT_PORTS[p]) body.querySelector('[data-path="port"]').value = DEFAULT_PORTS[p];
  };
  fillForm(body, data);
  sync(data.protocol);
  window.api.serial.list().then((ports) => { if (ports[0] && !serialPath.value) serialPath.value = ports[0].path; }).catch(() => {});

  const ok = await showDialog({
    title: 'Quick Connect', body, width: 460,
    buttons: [{ label: 'Cancel', value: false }, {
      label: 'Connect', value: true, primary: true,
      validate: () => {
        const p = body.querySelector('[data-path="protocol"]').value;
        return ['serial', 'local'].includes(p) || body.querySelector('[data-path="host"]').value.trim() ? null : 'Hostname is required';
      },
    }],
  });
  if (!ok) return;
  const v = collectForm(body, {});
  // Accept user@host:port in the hostname field.
  const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(v.host.trim());
  if (m) { v.username = m[1] || v.username; v.host = m[2].replace(/^\[|\]$/g, ''); if (m[3]) v.port = Number(m[3]); }
  app.lastQuickConnect = { ...v, password: '' };

  const session = {
    name: v.protocol === 'serial' ? v.serialPath : v.protocol === 'local' ? 'Local Shell' : `${v.username ? v.username + '@' : ''}${v.host}`,
    protocol: v.protocol, host: v.host, port: v.port, username: v.username,
    auth: { keyFile: v.keyFile, password: v.password, savePassword: !!v.password },
    serial: { path: v.serialPath, baudRate: Number(v.baudRate) },
  };
  let target = session;
  if (v.save) {
    target = await window.api.store.saveSession(session);
    await app.reloadTree();
  }
  if (v.sftp && v.protocol === 'ssh2') app.openSftp(target);
  else app.openSession(target);
}

// ---- Global Options ---------------------------------------------------------
export async function globalOptions(app, startCat = 'General') {
  const s = JSON.parse(JSON.stringify(app.settings));
  const panels = {
    General: h('div.form', {},
      field('Theme', themePicker(app, s), 'Click to preview. Terminals use the theme colors unless a session picks its own scheme.'),
      checkbox('copyOnSelect', 'Copy on select'),
      checkbox('rightClickPaste', 'Paste on right-click (Shift+right-click for menu)'),
      checkbox('confirmMultilinePaste', 'Confirm before pasting multiple lines'),
      field('Paste line delay (ms)', number('pasteLineDelay', { min: 0, max: 5000 }), 'Delay between lines when pasting; useful for slow devices'),
      checkbox('confirmCloseConnected', 'Confirm before closing connected tabs'),
      checkbox('tabActivityIndicator', 'Mark tabs with new output'),
      field('RDP client command', input('rdpClient', { placeholder: '(automatic: Windows App / mstsc / xfreerdp)' }),
        'Optional. Tokens: {file} (.rdp file), {host}, {port}, {user}. Example: remmina -c {file}')),
    Terminal: h('div.form', {},
      field('Default font family', input('fontFamily')),
      field('Default font size', number('fontSize', { min: 6, max: 72 })),
      h('h4', {}, 'Default session settings'),
      h('p.hint', {}, 'Applied to new sessions and anything a session does not override.'),
      field('Color scheme', select('defaultSession.terminal.colorScheme', schemeOptions())),
      field('Terminal type', select('defaultSession.terminal.termType', ['xterm-256color', 'xterm', 'vt100', 'vt220', 'ansi', 'linux'])),
      field('Scrollback lines', number('defaultSession.terminal.scrollback', { min: 0 })),
      field('SSH keep-alive (s)', number('defaultSession.ssh.keepAlive', { min: 0 })),
      field('Default log file', input('defaultSession.logging.path'))),
    'Button Bars': buttonEditor(s),
    'Keyword Highlighting': highlightEditor(s),
    'Keyboard Map': keymapEditor(s),
  };

  const nav = h('nav.cat-nav');
  const content = h('div.cat-content');
  for (const [name, panel] of Object.entries(panels)) {
    content.append(h('section', { dataset: { cat: name }, hidden: true }, h('h3', {}, name), panel));
    nav.append(h('button.cat', { type: 'button', dataset: { cat: name }, onclick: () => show(name) }, name));
  }
  const show = (name) => {
    for (const sec of content.children) sec.hidden = sec.dataset.cat !== name;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.cat === name);
  };
  const body = h('div.cat-dialog', {}, nav, content);
  fillForm(body, s);
  show(startCat);
  const ok = await showDialog({
    title: 'Global Options', body, width: 900, className: 'session-dialog',
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
  });
  if (!ok) { app.applyTheme(); return; } // undo the live preview
  collectForm(body, s);
  s.buttonBars = s.buttonBars.filter((b) => b.name).map((b) => ({ ...b, buttons: b.buttons.filter((x) => x.label) }));
  if (!s.buttonBars.some((b) => b.id === s.activeButtonBar)) s.activeButtonBar = s.buttonBars[0]?.id;
  s.highlights = s.highlights.filter((x) => x.pattern);
  s.keymap = s.keymap.filter((k) => k.key);
  await app.saveSettings(s);
}

/** Theme cards: each shows the theme's own panel, text, a prompt and its ANSI colors. */
function themePicker(app, s) {
  const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const normalize = (v) => (v === 'dark' ? 'TermCraft Dark' : v === 'light' ? 'TermCraft Light' : v || 'system');
  const hidden = h('input', { type: 'hidden', dataset: { path: 'theme' } });
  const grid = h('div.theme-grid', { role: 'radiogroup', 'aria-label': 'Theme' });
  const cards = new Map();
  const select = (value) => {
    hidden.value = value;
    for (const [v, el] of cards) el.setAttribute('aria-checked', String(v === value));
    app.applyTheme(value); // live preview
  };
  const card = (value, label, sub, t) => {
    const swatches = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((k) => h('i', { style: { background: t.term[k] } }));
    const el = h('button.theme-card', {
      type: 'button', role: 'radio', title: label,
      style: { background: t.ui.panel, color: t.ui.fg, borderColor: t.ui.border },
      onclick: () => select(value),
    },
    h('span.theme-name', {}, label),
    h('span.theme-sub', { style: { color: t.ui.dim } }, sub),
    h('span.theme-term', { style: { background: t.term.background, color: t.term.foreground } },
      h('b', { style: { color: t.term.green } }, '❯ '), 'ssh ', h('span', { style: { color: t.term.blue } }, 'web-01'),
      h('span.theme-cursor', { style: { background: t.term.cursor } })),
    h('span.theme-swatches', {}, swatches));
    cards.set(value, el);
    grid.append(el);
  };
  card('system', 'System', 'Follows your OS light/dark', resolveTheme('system', prefersDark()));
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    card(name, name, `${t.dark ? 'Dark' : 'Light'} · ${t.family}`, t);
  }
  const initial = normalize(s.theme);
  hidden.value = initial;
  for (const [v, el] of cards) el.setAttribute('aria-checked', String(v === initial));
  return h('div', {}, hidden, grid);
}

function buttonEditor(s) {
  s.buttonBars = s.buttonBars || [];
  const host = h('div');
  let selected = s.activeButtonBar || s.buttonBars[0]?.id;
  const render = () => {
    if (!s.buttonBars.some((b) => b.id === selected)) selected = s.buttonBars[0]?.id;
    const bar = s.buttonBars.find((b) => b.id === selected);
    const picker = h('select', { 'aria-label': 'Button bar', onchange: (e) => { selected = e.target.value; render(); } },
      s.buttonBars.map((b) => h('option', { value: b.id }, `${b.name} (${b.buttons.length})`)));
    picker.value = selected;
    host.replaceChildren(
      h('div.row', {},
        field('Button bar', picker),
        bar ? field('Name', h('input', { type: 'text', value: bar.name, oninput: (e) => { bar.name = e.target.value; picker.selectedOptions[0].textContent = `${bar.name} (${bar.buttons.length})`; } })) : null,
        h('button.small', { type: 'button', onclick: () => {
          const id = 'bb_' + Math.random().toString(36).slice(2, 10);
          s.buttonBars.push({ id, name: 'New Bar', buttons: [] });
          selected = id;
          render();
        } }, '+ New bar'),
        bar && s.buttonBars.length > 1 ? h('button.small.danger', { type: 'button', onclick: () => {
          s.buttonBars = s.buttonBars.filter((b) => b.id !== bar.id);
          render();
        } }, 'Delete bar') : null),
      bar ? listEditor({
        items: bar.buttons,
        columns: [
          { key: 'label', label: 'Label', width: '110px' },
          { key: 'action', label: 'Function', type: 'select', width: '165px', options: FUNCTIONS },
          { key: 'value', label: 'Value', placeholder: 'show version\\r' },
          { key: 'color', label: 'Color', type: 'select', width: '90px', options: COLORS },
        ],
        newItem: () => ({ label: 'New', action: 'send', value: '\\r', tooltip: '', color: '' }),
      }) : h('p.hint', {}, 'No button bars. Click “+ New bar”.'));
  };
  render();
  return h('div.form', {},
    h('p.hint', {}, 'Keep separate sets of buttons — e.g. Linux, Network Devices, Databases — and switch between them from the dropdown on the button bar. Values: Send String uses escapes \\r \\n \\t \\e \\xHH, \\p pauses 1 s, ${prompt:Label} asks for input. Menu Function values are action names (e.g. reconnect, sftpTab). Tip: right-click any button on the bar to edit it with a guided dialog.'),
    host);
}

function highlightEditor(s) {
  return h('div.form', {},
    h('p.hint', {}, 'Matching words in terminal output are colored. Regex rules use JavaScript syntax.'),
    listEditor({
      items: s.highlights,
      columns: [
        { key: 'enabled', label: 'On', type: 'checkbox', width: '36px' },
        { key: 'pattern', label: 'Pattern' },
        { key: 'regex', label: 'Regex', type: 'checkbox', width: '52px' },
        { key: 'caseSensitive', label: 'Case', type: 'checkbox', width: '48px' },
        { key: 'color', label: 'Color', type: 'color', width: '60px' },
        { key: 'bold', label: 'Bold', type: 'checkbox', width: '44px' },
      ],
      newItem: () => ({ enabled: true, pattern: '', regex: false, caseSensitive: false, color: '#ff79c6', bold: true }),
    }));
}

function keymapEditor(s) {
  const wrap = h('div.form', {},
    h('p.hint', {}, 'Click a Key cell and press the key combination to map. Mapped keys are intercepted before the terminal.'));
  const editor = listEditor({
    items: s.keymap,
    columns: [
      { key: 'key', label: 'Key', width: '160px', placeholder: 'press keys…' },
      { key: 'action', label: 'Action', type: 'select', width: '130px', options: [['send', 'Send string'], ['script', 'Run script'], ['menu', 'Menu action']] },
      { key: 'value', label: 'Value', placeholder: '\\x1b[15~' },
    ],
    newItem: () => ({ key: '', action: 'send', value: '' }),
  });
  // Capture key combos in the Key column.
  editor.addEventListener('keydown', (e) => {
    const td = e.target.closest('td');
    if (!td || td.cellIndex !== 0 || e.target.tagName !== 'INPUT') return;
    if (['Tab', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.target.value = comboOf(e);
    e.target.dispatchEvent(new Event('input'));
  }, true);
  wrap.append(editor);
  return wrap;
}

// ---- Known hosts ------------------------------------------------------------
export async function knownHostsDialog() {
  const tbody = h('tbody');
  const render = async () => {
    const hosts = await window.api.store.knownHosts();
    const rows = Object.entries(hosts);
    tbody.replaceChildren(...(rows.length ? rows.map(([hp, info]) => h('tr', {},
      h('td', {}, hp), h('td', {}, info.type), h('td.mono', {}, info.fingerprint),
      h('td', {}, h('button.small.danger', {
        onclick: async () => {
          if (await confirmDialog('Remove Host Key', `Remove the saved key for ${hp}? You will be asked to verify it on next connect.`, 'Remove', true)) {
            await window.api.store.deleteKnownHost(hp); render();
          }
        },
      }, 'Remove')))) : [h('tr', {}, h('td', { colSpan: 4 }, 'No saved host keys.'))]));
  };
  await render();
  await showDialog({
    title: 'Known Hosts', width: 860,
    body: h('div.table-scroll', {}, h('table.data', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Host'), h('th', {}, 'Type'), h('th', {}, 'Fingerprint'), h('th'))), tbody)),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---- Prompts from the main process -------------------------------------------
export async function handlePrompt(app, req) {
  const tab = app.tabs.find((t) => t.id === req.tabId);
  const where = tab ? ` — ${tab.displayTitle}` : '';
  if (tab && app.active !== tab) app.activate(tab);

  if (req.kind === 'hostkey') {
    const body = h('div.form', {},
      req.changed
        ? h('div.warn-box', {}, h('strong', {}, 'WARNING: THE HOST KEY HAS CHANGED!'),
          h('p', {}, 'Someone could be intercepting this connection (man-in-the-middle attack), or the server was reinstalled. Only continue if you know why the key changed.'),
          h('p.mono', {}, `Saved:    ${req.oldFingerprint}`))
        : h('p', {}, `The host key for ${req.host} is not in your known hosts list.`),
      h('table.kv', {},
        h('tr', {}, h('th', {}, 'Host'), h('td', {}, req.host)),
        h('tr', {}, h('th', {}, 'Key type'), h('td', {}, req.keyType)),
        h('tr', {}, h('th', {}, 'SHA256'), h('td.mono', {}, req.fingerprint)),
        h('tr', {}, h('th', {}, 'MD5'), h('td.mono', {}, req.md5))),
      h('p.hint', {}, 'Compare the fingerprint with the one reported by the server administrator (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub).'));
    return showDialog({
      title: (req.changed ? 'Host Key Changed' : 'New Host Key') + where, body, width: 600,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Accept Once', value: 'once' },
        { label: req.changed ? 'Accept & Replace' : 'Accept & Save', value: 'save', primary: !req.changed, danger: req.changed },
      ],
    });
  }

  if (req.kind === 'kbdint') {
    const inputs = req.prompts.map((p) => h('input', { type: p.echo ? 'text' : 'password', autocomplete: 'off', 'aria-label': p.prompt }));
    const save = req.offerSave ? saveLoginBox(app) : null;
    const ok = await showDialog({
      title: (req.title || 'Login') + where,
      body: h('div.form', {},
        req.retry ? h('p.error', {}, 'Authentication failed. Please try again.') : null,
        req.message ? h('p.pre', {}, req.message) : null,
        req.prompts.map((p, i) => field(p.prompt.trim(), inputs[i])),
        save?.el),
      buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
    });
    if (!ok) return null;
    const answers = inputs.map((i) => i.value);
    return save ? { answers, save: save.commit() } : answers;
  }

  if (req.kind === 'password' || req.kind === 'text') {
    const el = h('input', { type: req.kind, value: req.defaultValue || '', autocomplete: 'off', autofocus: true, 'aria-label': req.message });
    const save = req.offerSave ? saveLoginBox(app) : null;
    const ok = await showDialog({
      title: (req.title || 'Input') + where,
      body: h('div.form', {}, req.retry ? h('p.error', {}, 'Authentication failed. Please try again.') : null, h('label.block', {}, req.message), el, save?.el),
      buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
    });
    if (!ok) return null;
    return save ? { value: el.value, save: save.commit() } : el.value;
  }

  if (req.kind === 'message') {
    await showDialog({ title: req.title, body: h('p.pre', {}, req.message) });
    return true;
  }
  toast(`Unknown prompt ${req.kind}`, 'error');
  return null;
}

/**
 * "Save login" checkbox for credential prompts. The last choice is remembered so
 * someone who always saves logins doesn't have to tick it every time.
 */
function saveLoginBox(app) {
  let last = false;
  try { last = localStorage.getItem('termcraft.saveLogin') === '1'; } catch { /* storage unavailable */ }
  const box = h('input', { type: 'checkbox', checked: last });
  const where = { darwin: 'the macOS Keychain', win32: 'Windows (DPAPI)', linux: 'the system keyring' }[app.platform] || 'the system keyring';
  const hint = app.info.encryption
    ? `Encrypted with ${where}. You won't be asked again for this session.`
    : 'Warning: no system keyring is available, so it will be stored obfuscated, not encrypted.';
  return {
    el: h('div.save-login', {},
      h('label.check', {}, box, 'Save login (username and password)'),
      h('p.hint', {}, hint)),
    commit() {
      try { localStorage.setItem('termcraft.saveLogin', box.checked ? '1' : '0'); } catch { /* storage unavailable */ }
      return box.checked;
    },
  };
}

// ---- Help ------------------------------------------------------------------------
export function scriptHelp() {
  const code = `// Scripts are JavaScript, run with top-level await.
// The tab that launched the script is tc.Screen / tc.Session.

tc.Screen.Send("show version\\r");
await tc.Screen.WaitForString("#", 10);         // -> true / false on timeout
const i = await tc.Screen.WaitForStrings(["$", "#", ">"], 5); // 1-based, 0 = timeout
const out = await tc.Screen.ReadString("#", 10);  // text before the match
const text = await tc.Screen.Get();               // visible screen text
tc.Screen.SendKeys("exit\\r");                    // expands \\r \\n \\t \\xHH

const name = await tc.Dialog.Prompt("Hostname?", "Title", "default");
await tc.Dialog.MessageBox("Done: " + name);
await tc.Sleep(500);

const tab = await tc.Session.Connect("My Router");  // saved name or user@host:port
await tab.Screen.WaitForString("login:");
tab.Session.Log(true);   // start logging that tab
tab.Session.Disconnect();

console.log("printed in the terminal");
const fs = require("fs");  // fs, path, os, child_process, net, crypto available`;
  return showDialog({ title: 'Scripting Reference', width: 720, body: h('pre.code', {}, code) });
}

export function shortcutsHelp(platform) {
  const m = platform === 'darwin' ? '⌘' : 'Ctrl+Shift+';
  const rows = [
    ['Quick Connect', `${m}Q`], ['Connect (Session Manager)', `${m}O`], ['Local shell tab', `${m}L`], ['SFTP tab', `${m}P`],
    ['Clone session', `${m}D`], ['Reconnect', `${m}R`], ['Close tab', `${m}W`], ['Copy / Paste', `${m}C / ${m}V`],
    ['Find', `${m}F`], ['Clear scrollback', `${m}K`], ['Session options', `${m}S`], ['Show / hide Session Manager', platform === 'darwin' ? '⌘⇧M' : 'Ctrl+Shift+M'],
    ['Maximize terminal area', platform === 'darwin' ? '⌘⇧↩' : 'Ctrl+Shift+Enter'],
    ['Layout: Tabs / Stacked / Side by Side / Grid', platform === 'darwin' ? '⌘⌥1 – ⌘⌥4' : 'Toolbar or Window menu'],
    ['Toggle command window', `${m}E`], ['Broadcast to all tabs', `${m}B`], ['Run script', `${m}J`],
    ['Next / previous tab', platform === 'darwin' ? '⌘⇧] / ⌘⇧[' : 'Ctrl+Tab / Ctrl+Shift+Tab'], ['Font size', platform === 'darwin' ? '⌘= / ⌘- / ⌘0' : 'Ctrl+= / Ctrl+- / Ctrl+0'],
    ['Reconnect a dropped session', 'Enter'], ['Open link in terminal', `${platform === 'darwin' ? '⌘' : 'Ctrl'}+click`],
  ];
  return showDialog({
    title: 'Keyboard Shortcuts', width: 520,
    body: h('table.data', {}, h('tbody', {}, rows.map(([a, k]) => h('tr', {}, h('td', {}, a), h('td', {}, h('kbd', {}, k)))))),
  });
}

// ---- About / License --------------------------------------------------------------
export async function aboutDialog() {
  const a = await window.api.app.about();
  await showDialog({
    title: 'About TermCraft', width: 520,
    body: h('div.about', {},
      h('img.about-logo', { src: 'assets/logo.svg', alt: 'TermCraft logo: the prompt >_ drawn as a connection from you, through a jump host, to a server', width: 120, height: 120 }),
      h('div', {},
        h('h2', {}, 'TermCraft'),
        h('p.about-tag', {}, '> a craft for the command line_'),
        h('p.hint', {}, `Version ${a.version} · Electron ${a.electron} · Chromium ${a.chrome} · Node ${a.node}`),
        h('p', {}, a.copyright),
        h('p.hint', {}, a.notice))),
    buttons: [{ label: 'View License', value: 'license' }, { label: 'OK', value: true, primary: true }],
  }).then((v) => (v === 'license' ? licenseDialog() : null));
}

export async function licenseDialog() {
  const text = await window.api.app.licenseText();
  await showDialog({ title: 'GNU General Public License v2 (or later)', width: 760, body: h('pre.code.license', {}, text) });
}
