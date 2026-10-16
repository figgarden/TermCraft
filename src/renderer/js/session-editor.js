// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
import { h, showDialog, fillForm, collectForm, field, input, number, checkbox, select, listEditor, toast } from './dom.js';
import { schemeSelect } from './schemes.js';
import { credentialOptions, credentialsDialog, colorPickerField } from './tools.js';

const PROTOCOLS = [['ssh2', 'SSH2'], ['telnet', 'Telnet'], ['rlogin', 'Rlogin'], ['serial', 'Serial'], ['raw', 'Raw TCP'], ['local', 'Local Shell'], ['vnc', 'VNC'], ['rdp', 'RDP']];
const DEFAULT_PORTS = { ssh2: 22, telnet: 23, rlogin: 513, raw: 23, vnc: 5900, rdp: 3389 };
const REMOTE_DESKTOP = new Set(['vnc', 'rdp']);
const TERM_TYPES = ['xterm-256color', 'xterm', 'vt100', 'vt102', 'vt220', 'ansi', 'linux', 'screen-256color'];
const ENCODINGS = [['utf-8', 'UTF-8'], ['iso-8859-1', 'ISO-8859-1 (Latin-1)'], ['windows-1252', 'Windows-1252'], ['iso-8859-15', 'ISO-8859-15'],
  ['shift_jis', 'Shift-JIS (receive)'], ['euc-jp', 'EUC-JP (receive)'], ['gbk', 'GBK (receive)'], ['big5', 'Big5 (receive)'], ['euc-kr', 'EUC-KR (receive)'], ['koi8-r', 'KOI8-R (receive)']];
const BAUD = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export const PROTOCOL_LABEL = Object.fromEntries(PROTOCOLS);

function folderOptions(tree) {
  const out = [['', '(root)']];
  const walk = (parent, depth) => {
    for (const f of tree.folders.filter((x) => (x.parent || '') === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push([f.id, `${'  '.repeat(depth)}${f.name}`]);
      walk(f.id, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

/**
 * Edit (or create) a session. Returns the saved sanitized session, or null if cancelled.
 * When `adHoc` is true the session is returned without being stored (quick connect "options").
 */
export async function editSession(app, original, { title = 'Session Options', parent = '' } = {}) {
  const s = app.effectiveSession(original || { parent });
  s.forwards = (s.forwards || []).map((f) => ({ ...f }));
  s.logonActions = (s.logonActions || []).map((a) => ({ ...a }));
  const tree = app.tree;
  const isNew = !original?.id;

  // ---- panels ----
  const passwordInput = h('input', { type: 'password', placeholder: s.auth.hasPassword ? '•••••••• (saved — type to replace)' : '', autocomplete: 'off', 'aria-label': 'Password' });
  const clearPassword = h('input', { type: 'checkbox' });
  const passphraseInput = h('input', { type: 'password', placeholder: s.auth.hasPassphrase ? '•••••••• (saved)' : '(prompt when needed)', autocomplete: 'off', 'aria-label': 'Key passphrase' });
  const methodBoxes = ['publickey', 'keyboard-interactive', 'password'].map((m) =>
    h('label.check', {}, h('input', { type: 'checkbox', checked: (s.auth.methods || []).includes(m), dataset: { method: m } }), m));

  const serialPort = h('select', { dataset: { path: 'serial.path' }, 'aria-label': 'Serial port' });
  const refreshPorts = async () => {
    const ports = await window.api.serial.list().catch(() => []);
    const cur = s.serial?.path;
    serialPort.replaceChildren(
      ...ports.map((p) => h('option', { value: p.path }, `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`)),
      ...(cur && !ports.some((p) => p.path === cur) ? [h('option', { value: cur }, cur)] : []));
    serialPort.value = cur || ports[0]?.path || '';
  };

  const keyFile = input('auth.keyFile', { placeholder: '~/.ssh/id_ed25519' });
  const logonScript = input('logonScript', { placeholder: 'Optional .js script to run after connecting' });
  const browse = (target, opts) => h('button.small', {
    type: 'button',
    onclick: async () => { const f = await window.api.dialog.openFile(opts); if (f) target.value = f; },
  }, 'Browse…');

  const sshSessions = tree.sessions.filter((x) => x.protocol === 'ssh2' && x.id !== s.id);
  const credSel = select('auth.credentialId', credentialOptions(app));
  const tabColor = colorPickerField(s.terminal?.tabColor);
  const panels = {
    Connection: h('div.form', {},
      field('Name', input('name', { placeholder: 'My server', autofocus: true })),
      field('Folder', select('parent', folderOptions(tree))),
      field('Protocol', select('protocol', PROTOCOLS, { onchange: (e) => onProtocol(e.target.value) })),
      h('div.net-only', {},
        field('Hostname', input('host', { placeholder: 'host.example.com or 10.0.0.1' })),
        field('Port', number('port', { min: 1, max: 65535 })),
        h('div.remote-only', {}, field('Connect through SSH session', select('tunnel.sshSessionId', [['', '(none — connect directly)'], ...sshSessions.map((x) => [x.id, x.name || x.host])]),
          'Reach the remote desktop through an SSH tunnel to this saved session (recommended for VNC, which is often unencrypted)'))),
      h('div.serial-only', {},
        field('Port', h('div.row', {}, serialPort, h('button.small', { type: 'button', onclick: refreshPorts }, 'Refresh'))),
        field('Baud rate', select('serial.baudRate', BAUD.map(String))),
        h('div.row', {},
          field('Data bits', select('serial.dataBits', ['5', '6', '7', '8'])),
          field('Parity', select('serial.parity', ['none', 'odd', 'even', 'mark', 'space'])),
          field('Stop bits', select('serial.stopBits', ['1', '1.5', '2']))),
        field('Flow control', select('serial.flowControl', [['none', 'None'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']]))),
      h('div.user-field', {}, field('Username', input('username', { placeholder: '(prompt)' }))),
      h('div.local-only', {},
        field('Shell', input('local.shell', { placeholder: app.info.defaultShell }), 'Leave blank for the system default shell'),
        field('Arguments', input('local.args', { placeholder: app.platform === 'win32' ? '' : '-l' })),
        field('Start in', input('local.cwd', { placeholder: '~' }))),
      field('Notes', h('textarea', { dataset: { path: 'notes' }, rows: 3 }))),

    Authentication: h('div.form', {},
      field('Credential', h('div.row', {}, credSel,
        h('button.small', { type: 'button', onclick: async () => { const cur = credSel.value; await credentialsDialog(app); credSel.replaceChildren(...credentialOptions(app).map(([v, l]) => h('option', { value: v }, l))); credSel.value = cur; } }, 'Manage…')),
        'A shared login (e.g. your TACACS or domain account). Its username, password and key are used instead of the ones below.'),
      h('div.inband-only', {}, checkbox('auth.autoLogin', 'Log in automatically: answer “Username:” and “Password:” prompts')),
      h('fieldset.ssh-auth-only', {}, h('legend', {}, 'Methods (tried in this order)'), ...methodBoxes),
      field('Password', passwordInput),
      h('div.row', {},
        checkbox('auth.savePassword', 'Save password (encrypted with OS keychain)'),
        s.auth.hasPassword ? h('label.check', {}, clearPassword, 'Clear saved password') : null),
      h('p.hint.rdp-auth-only', {}, 'macOS and Windows RDP clients ask for the password themselves and can keep it in their own keychain; a saved password is passed to FreeRDP on Linux.'),
      h('div.ssh-auth-only', {},
        field('Public key file', h('div.row', {}, keyFile, browse(keyFile, { title: 'Select private key' }))),
        field('Key passphrase', passphraseInput),
        checkbox('auth.useAgent', 'Use SSH agent (ssh-agent / Pageant / Windows OpenSSH agent)'))),

    VNC: h('div.form', {},
      field('Scaling', select('vnc.scale', [['fit', 'Fit to window'], ['remote', 'Resize remote desktop to the window'], ['none', 'Actual size']])),
      h('div.row', {},
        field('Quality (0–9)', number('vnc.quality', { min: 0, max: 9 })),
        field('Compression (0–9)', number('vnc.compression', { min: 0, max: 9 }))),
      checkbox('vnc.viewOnly', 'View only (do not send keyboard or mouse)'),
      checkbox('vnc.shared', 'Shared session (do not disconnect other viewers)'),
      h('p.hint', {}, 'Supports VNC password, Apple Remote Desktop (macOS Screen Sharing), VeNCrypt and RSA-AES authentication.')),

    RDP: h('div.form', {},
      field('Domain', input('rdp.domain', { placeholder: '(optional)' })),
      checkbox('rdp.fullscreen', 'Full screen'),
      h('div.row', {},
        field('Width', number('rdp.width', { min: 640, max: 7680 })),
        field('Height', number('rdp.height', { min: 480, max: 4320 }))),
      checkbox('rdp.multimon', 'Use all monitors'),
      checkbox('rdp.admin', 'Connect to the administrative (console) session'),
      h('p.hint', {}, 'TermCraft opens the session (and SSH tunnel, if set) with your system RDP client: Windows App on macOS, Remote Desktop Connection on Windows, FreeRDP or Remmina on Linux. Change the client in Settings.')),

    SSH: h('div.form', {},
      field('Jump host / firewall', select('ssh.jumpSessionId', [['', '(none — connect directly)'], ...sshSessions.map((x) => [x.id, x.name || x.host])]),
        'Tunnel this connection through another saved SSH2 session'),
      field('Keep-alive interval (s)', number('ssh.keepAlive', { min: 0 }), 'SSH protocol keep-alive. 0 disables.'),
      field('Connect timeout (s)', number('ssh.readyTimeout', { min: 1 })),
      checkbox('ssh.compression', 'Enable compression (zlib)'),
      checkbox('ssh.agentForward', 'Enable agent forwarding'),
      checkbox('ssh.x11', 'Forward X11 connections'),
      checkbox('ssh.trace', 'Trace protocol (show debug output in terminal)')),

    'Port Forwarding': h('div.form', {},
      h('p.hint', {}, 'L = local (listen here, forward to remote destination). R = remote (listen on server, forward to local destination). D = dynamic SOCKS4/5 proxy.'),
      listEditor({
        items: s.forwards,
        columns: [
          { key: 'enabled', label: 'On', type: 'checkbox', width: '36px' },
          { key: 'type', label: 'Type', type: 'select', options: [['L', 'Local'], ['R', 'Remote'], ['D', 'Dynamic']], width: '92px' },
          { key: 'bindHost', label: 'Listen host', placeholder: '127.0.0.1' },
          { key: 'bindPort', label: 'Listen port', type: 'number', width: '90px' },
          { key: 'destHost', label: 'Destination host', placeholder: 'localhost' },
          { key: 'destPort', label: 'Dest port', type: 'number', width: '90px' },
        ],
        newItem: () => ({ enabled: true, type: 'L', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80 }),
      })),

    Terminal: h('div.form', {},
      field('Terminal type', select('terminal.termType', TERM_TYPES)),
      field('Scrollback lines', number('terminal.scrollback', { min: 0, max: 1000000 })),
      field('Character encoding', select('terminal.encoding', ENCODINGS)),
      field('Backspace sends', select('terminal.backspace', [['del', 'Delete (^?)'], ['bs', 'Backspace (^H)']])),
      checkbox('terminal.useRemoteTitle', 'Use remote window title for tab name')),

    Appearance: h('div.form', {},
      field('Terminal colors', schemeSelect(h, '', `Default (${app.settings.defaultSession?.terminal?.colorScheme || 'match theme'})`, { dataset: { path: 'terminal.colorScheme' } }),
        'Default follows Settings → Appearance. Pick a palette to make this session look different.'),
      field('Font family', input('terminal.fontFamily', { placeholder: 'Default (Settings → Appearance)' })),
      field('Font size', number('terminal.fontSize', { min: 0, max: 72 }), '0 = default'),
      field('Cursor', select('terminal.cursorStyle', [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Vertical bar']])),
      checkbox('terminal.cursorBlink', 'Blinking cursor'),
      field('Tab color', tabColor.el, 'Mark production or customer sessions at a glance. None = use the folder’s color.'),
      field('Button bar', select('terminal.buttonBar', [['', '(whichever bar is selected)'], ...(app.settings.buttonBars || []).map((b) => [b.id, b.name])]),
        'Show this button bar automatically when this session’s tab is active')),

    'Log File': h('div.form', {},
      checkbox('logging.enabled', 'Start logging when the session connects'),
      field('Log file name', input('logging.path'),
        'Tokens: %S session, %H host, %P port, %U user, %Y %M %D date, %h %m %s time'),
      checkbox('logging.append', 'Append to existing file'),
      checkbox('logging.timestamps', 'Prefix each line with a timestamp'),
      checkbox('logging.stripAnsi', 'Strip escape sequences (plain text log)')),

    'Logon Actions': h('div.form', {},
      h('p.hint', {}, 'Wait for each “Expect” string, then send “Send”. Leave Expect empty to send immediately. Escapes: \\r \\n \\t \\e \\xHH'),
      listEditor({
        items: s.logonActions,
        columns: [
          { key: 'expect', label: 'Expect', placeholder: 'login:' },
          { key: 'send', label: 'Send', placeholder: 'admin\\r' },
        ],
        newItem: () => ({ expect: '', send: '\\r' }),
      }),
      field('Logon script', h('div.row', {}, logonScript, browse(logonScript, { title: 'Select logon script', filters: [{ name: 'JavaScript', extensions: ['js'] }] })))),

    Advanced: h('div.form', {},
      h('fieldset', {}, h('legend', {}, 'Anti-idle'),
        checkbox('antiIdle.enabled', 'Send a string when idle'),
        h('div.row', {},
          field('String', input('antiIdle.string')),
          field('Every (s)', number('antiIdle.interval', { min: 5 })))),
      h('fieldset', {}, h('legend', {}, 'Auto reconnect'),
        checkbox('reconnect.enabled', 'Reconnect automatically when the connection drops'),
        field('Delay (s)', number('reconnect.delay', { min: 1 })))),
  };

  const nav = h('nav.cat-nav', { role: 'tablist' });
  const content = h('div.cat-content');
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = true;
    content.append(h('section', { dataset: { cat: name } }, h('h3', {}, name), panel));
    nav.append(h('button.cat', { type: 'button', role: 'tab', dataset: { cat: name }, onclick: () => show(name) }, name));
  }
  const show = (name) => {
    for (const sec of content.children) { const on = sec.dataset.cat === name; sec.hidden = !on; sec.lastChild.hidden = !on; }
    for (const b of nav.children) b.classList.toggle('active', b.dataset.cat === name);
  };
  const body = h('div.cat-dialog', {}, nav, content);

  const onProtocol = (p) => {
    const visible = (cat, on) => { const b = nav.querySelector(`[data-cat="${cat}"]`); if (b) b.hidden = !on; };
    for (const el of body.querySelectorAll('.net-only')) el.hidden = p === 'serial' || p === 'local';
    for (const el of body.querySelectorAll('.user-field')) el.hidden = p === 'raw' || p === 'local';
    for (const el of body.querySelectorAll('.serial-only')) el.hidden = p !== 'serial';
    for (const el of body.querySelectorAll('.local-only')) el.hidden = p !== 'local';
    const rd = REMOTE_DESKTOP.has(p);
    for (const el of body.querySelectorAll('.remote-only')) el.hidden = !rd;
    for (const el of body.querySelectorAll('.ssh-auth-only')) el.hidden = p !== 'ssh2';
    for (const el of body.querySelectorAll('.rdp-auth-only')) el.hidden = p !== 'rdp';
    const inband = ['telnet', 'rlogin', 'serial'].includes(p);
    for (const el of body.querySelectorAll('.inband-only')) el.hidden = !inband;
    visible('Authentication', p === 'ssh2' || rd || inband);
    visible('SSH', p === 'ssh2');
    visible('Port Forwarding', p === 'ssh2');
    visible('VNC', p === 'vnc');
    visible('RDP', p === 'rdp');
    for (const cat of ['Terminal', 'Appearance', 'Log File', 'Logon Actions', 'Advanced']) visible(cat, !rd);
    const portEl = body.querySelector('[data-path="port"]');
    if (DEFAULT_PORTS[p] && Object.values(DEFAULT_PORTS).includes(Number(portEl.value))) portEl.value = DEFAULT_PORTS[p];
    if (p === 'serial' && !serialPort.options.length) refreshPorts();
  };

  fillForm(body, s);
  // Show the session's own choices, not the merged defaults, so "Default" stays default.
  body.querySelector('[data-path="terminal.colorScheme"]').value = original?.terminal?.colorScheme || '';
  body.querySelector('[data-path="terminal.fontFamily"]').value = original?.terminal?.fontFamily || '';
  serialPort.value = s.serial?.path || '';
  onProtocol(s.protocol);
  show('Connection');
  if (s.protocol === 'serial') refreshPorts();

  const result = await showDialog({
    title: isNew ? 'New Session' : `${title} — ${s.name || s.host}`,
    body, width: 820, className: 'session-dialog',
    buttons: [{ label: 'Cancel', value: false }, {
      label: isNew ? 'Save' : 'OK', value: true, primary: true,
      validate: () => {
        const p = body.querySelector('[data-path="protocol"]').value;
        if (['ssh2', 'telnet', 'rlogin', 'raw', 'vnc', 'rdp'].includes(p) && !body.querySelector('[data-path="host"]').value.trim()) {
          show('Connection');
          return 'Hostname is required';
        }
        return null;
      },
    }],
  });
  if (!result) return null;

  const out = collectForm(body, JSON.parse(JSON.stringify(original || {})));
  out.forwards = s.forwards.filter((f) => f.bindPort);
  out.logonActions = s.logonActions;
  out.auth = out.auth || {};
  out.auth.methods = methodBoxes.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.dataset.method);
  if (passwordInput.value) out.auth.password = passwordInput.value;
  else if (clearPassword.checked) out.auth.password = '';
  else delete out.auth.password;
  if (passphraseInput.value) out.auth.passphrase = passphraseInput.value;
  else delete out.auth.passphrase;
  out.port = Number(out.port) || DEFAULT_PORTS[out.protocol] || 0;
  out.serial.baudRate = Number(out.serial.baudRate);
  out.serial.dataBits = Number(out.serial.dataBits);
  out.serial.stopBits = Number(out.serial.stopBits);
  out.terminal = { ...(out.terminal || {}), tabColor: tabColor.value };
  if (!out.name) out.name = out.protocol === 'serial' ? out.serial.path : out.protocol === 'local' ? 'Local Shell' : out.host;
  delete out.auth.hasPassword;
  delete out.auth.hasPassphrase;

  const saved = await window.api.store.saveSession(out);
  await app.reloadTree();
  toast(`Saved "${saved.name}"`);
  return saved;
}
