// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { newId } = require('./util');
const { UNSAFE_KEYS, safeJsonParse } = require('./security');

const SECRET_FIELDS = ['password', 'passphrase'];
const KEYCHAIN_DENIED = 'TermCraft could not use the system keychain to encrypt your login (access was denied). Quit and reopen TermCraft, then choose "Always Allow" when asked about "TermCraft Safe Storage".';

const DEFAULT_SESSION = {
  protocol: 'ssh2',
  host: '',
  port: 22,
  username: '',
  auth: { methods: ['publickey', 'keyboard-interactive', 'password'], keyFile: '', useAgent: true, savePassword: true },
  ssh: { keepAlive: 30, compression: false, agentForward: false, x11: false, jumpSessionId: '', trace: false, readyTimeout: 20 },
  forwards: [],
  terminal: {
    termType: 'xterm-256color', scrollback: 10000, encoding: 'utf-8', backspace: 'del',
    colorScheme: '', fontFamily: '', fontSize: 0, cursorStyle: 'block', cursorBlink: true,
    useRemoteTitle: false,
  },
  logging: { enabled: false, path: '~/TermCraft Logs/%S-%Y%M%D-%h%m%s.log', timestamps: false, append: true, stripAnsi: true },
  logonActions: [],
  logonScript: '',
  antiIdle: { enabled: false, string: '\\r', interval: 300 },
  reconnect: { enabled: false, delay: 5 },
  serial: { path: '', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
  local: { shell: '', args: '', cwd: '' },
  // VNC (embedded noVNC viewer) and RDP (system client) options.
  vnc: { viewOnly: false, scale: 'fit', quality: 6, compression: 2, shared: true },
  rdp: { fullscreen: false, width: 1600, height: 1000, multimon: false, admin: false, domain: '' },
  // VNC/RDP: reach the host through this saved SSH session (an SSH tunnel).
  tunnel: { sshSessionId: '' },
  notes: '',
};

const DEFAULT_SETTINGS = {
  theme: 'TermCraft Dark',
  copyOnSelect: true,
  rightClickPaste: true,
  confirmMultilinePaste: true,
  pasteLineDelay: 0,
  confirmCloseConnected: true,
  fontFamily: '"JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  showSessionManager: true,
  showButtonBar: true,
  showCommandWindow: false,
  showStatusBar: true,
  tabActivityIndicator: true,
  layout: 'tabs',
  // Named button bars. Each button: { label, action, value, tooltip, color }.
  // Actions: send, sendAll, script, connect, menu, run.
  buttonBars: [
    {
      id: 'default', name: 'Default', buttons: [
        { label: 'ls -la', action: 'send', value: 'ls -la\\r', tooltip: 'List files' },
        { label: 'df -h', action: 'send', value: 'df -h\\r', tooltip: 'Disk usage' },
        { label: 'top', action: 'send', value: 'top\\r' },
        { label: 'uptime', action: 'send', value: 'uptime\\r' },
        { label: 'Ctrl-C', action: 'send', value: '\\x03', tooltip: 'Interrupt', color: 'red' },
      ],
    },
    {
      id: 'network', name: 'Network Devices', buttons: [
        { label: 'term len 0', action: 'send', value: 'terminal length 0\\r' },
        { label: 'show ver', action: 'send', value: 'show version\\r' },
        { label: 'int brief', action: 'send', value: 'show ip interface brief\\r' },
        { label: 'show run', action: 'send', value: 'show running-config\\r' },
        { label: 'show vlan…', action: 'send', value: 'show vlan id ${prompt:VLAN ID}\\r', tooltip: 'Asks for the VLAN ID' },
        { label: 'wr mem', action: 'send', value: 'write memory\\r', color: 'orange' },
      ],
    },
    {
      id: 'tools', name: 'Tools', buttons: [
        { label: 'SFTP', action: 'menu', value: 'sftpTab', tooltip: 'Open an SFTP tab for this session' },
        { label: 'Log', action: 'menu', value: 'toggleLog', tooltip: 'Start/stop logging' },
        { label: 'Clear', action: 'menu', value: 'clearScrollback' },
        { label: 'Reconnect', action: 'menu', value: 'reconnect' },
      ],
    },
  ],
  activeButtonBar: 'default',
  highlights: [
    { pattern: 'error', regex: false, caseSensitive: false, color: '#ff5555', bold: true, enabled: true },
    { pattern: 'fail(ed|ure)?', regex: true, caseSensitive: false, color: '#ff5555', bold: true, enabled: true },
    { pattern: 'warn(ing)?', regex: true, caseSensitive: false, color: '#f1c40f', bold: true, enabled: true },
    { pattern: '\\b(up|ok|success)\\b', regex: true, caseSensitive: false, color: '#50fa7b', bold: false, enabled: true },
  ],
  keymap: [],
  defaultSession: DEFAULT_SESSION,
  windowBounds: null,
  recentScripts: [],
  rdpClient: '', // custom RDP client command; tokens {file} {host} {port} {user}
};

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over !== undefined ? over : base;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) if (!UNSAFE_KEYS.has(k)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over !== undefined ? over : base;
}

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    // Sessions, settings and known hosts are private to the user.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not supported (e.g. some Windows file systems) */ }
    this.files = {
      sessions: path.join(dir, 'sessions.json'),
      settings: path.join(dir, 'settings.json'),
      knownHosts: path.join(dir, 'known_hosts.json'),
    };
    this.data = {
      sessions: this._read(this.files.sessions, { folders: [], sessions: [] }),
      settings: deepMerge(DEFAULT_SETTINGS, Store._migrateSettings(this._read(this.files.settings, {}))),
      knownHosts: this._read(this.files.knownHosts, {}),
    };
    // Sessions saved with the old fixed default scheme now follow the app theme.
    for (const s of this.data.sessions.sessions || []) {
      if (s.terminal?.colorScheme === 'TermCraft Dark') s.terminal.colorScheme = '';
    }
  }

  /** Older versions had one flat `buttons` list; keep those as a "Default" button bar. */
  static _migrateSettings(raw) {
    // 'TermCraft Dark' used to be the fixed default terminal scheme; now the default follows the app theme.
    if (raw.defaultSession?.terminal?.colorScheme === 'TermCraft Dark') raw.defaultSession.terminal.colorScheme = '';
    if (raw.theme === 'dark') raw.theme = 'TermCraft Dark';
    if (raw.theme === 'light') raw.theme = 'TermCraft Light';
    if (Array.isArray(raw.buttons) && !raw.buttonBars) {
      const defaults = DEFAULT_SETTINGS.buttonBars.filter((b) => b.id !== 'default');
      raw.buttonBars = [{ id: 'default', name: 'Default', buttons: raw.buttons }, ...defaults];
      raw.activeButtonBar = 'default';
    }
    delete raw.buttons;
    return raw;
  }

  _read(file, fallback) {
    try { return safeJsonParse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _write(key) {
    const file = this.files[key];
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data[key], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---- secrets -------------------------------------------------------
  encrypt(plain) {
    if (!plain) return '';
    const keychainOS = process.platform === 'darwin' || process.platform === 'win32';
    if (this.safeStorage?.isEncryptionAvailable()) {
      try {
        return 'enc:' + this.safeStorage.encryptString(plain).toString('base64');
      } catch {
        throw new Error(KEYCHAIN_DENIED);
      }
    }
    // macOS/Windows always have a keychain: if it is unavailable, access was denied — never
    // silently fall back to weaker storage there. (Linux without a keyring uses the fallback,
    // and the UI warns about it.)
    if (keychainOS && this.safeStorage) throw new Error(KEYCHAIN_DENIED);
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  /**
   * When saved logins exist, check that the OS keychain can be used (on macOS this is when the
   * "TermCraft Safe Storage" prompt appears). Returns 'none' | 'ok' | 'denied'.
   */
  checkKeychain() {
    const hasSecrets = this.data.sessions.sessions.some((s) => SECRET_FIELDS.some((f) => String(s.auth?.[f] || '').startsWith('enc:')));
    if (!hasSecrets || !this.safeStorage) return 'none';
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return 'denied';
      this.safeStorage.encryptString('termcraft-keychain-check');
      return 'ok';
    } catch {
      return 'denied';
    }
  }

  decrypt(stored) {
    if (!stored) return '';
    if (stored.startsWith('enc:')) {
      try { return this.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); } catch { return ''; }
    }
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    return stored;
  }

  // ---- settings ------------------------------------------------------
  getSettings() { return this.data.settings; }

  saveSettings(patch) {
    this.data.settings = deepMerge(this.data.settings, patch);
    this._write('settings');
    return this.data.settings;
  }

  // ---- sessions ------------------------------------------------------
  /** Session tree with secrets replaced by has* flags, safe to send to the renderer. */
  getTree() {
    return {
      folders: this.data.sessions.folders,
      sessions: this.data.sessions.sessions.map((s) => this._sanitize(s)),
    };
  }

  _sanitize(s) {
    const out = JSON.parse(JSON.stringify(s));
    for (const f of SECRET_FIELDS) {
      out.auth = out.auth || {};
      out.auth['has' + f[0].toUpperCase() + f.slice(1)] = !!s.auth?.[f];
      delete out.auth[f];
    }
    return out;
  }

  getSession(id) {
    return this.data.sessions.sessions.find((s) => s.id === id);
  }

  findSessionByName(name) {
    return this.data.sessions.sessions.find((s) => s.name === name || s.id === name);
  }

  /** Full session config with defaults applied and secrets decrypted (main process only). */
  resolveSession(idOrSession) {
    const raw = typeof idOrSession === 'string' ? this.getSession(idOrSession) : idOrSession;
    if (!raw) throw new Error('Session not found');
    const s = deepMerge(this.data.settings.defaultSession || DEFAULT_SESSION, JSON.parse(JSON.stringify(raw)));
    s.auth = s.auth || {};
    // Stored sessions keep encrypted secrets; ad-hoc (quick connect) sessions carry plaintext ones.
    const stored = raw.id ? this.getSession(raw.id) : null;
    for (const f of SECRET_FIELDS) {
      s.auth[f] = stored ? this.decrypt(stored.auth?.[f]) : (raw.auth?.[f] || '');
    }
    return s;
  }

  /**
   * Insert/update a session. For secret fields: undefined keeps the stored value,
   * '' clears it, any other string replaces it.
   */
  saveSession(session) {
    const list = this.data.sessions.sessions;
    const existing = session.id ? list.find((s) => s.id === session.id) : null;
    const next = JSON.parse(JSON.stringify(session));
    next.auth = next.auth || {};
    delete next.auth.hasPassword;
    delete next.auth.hasPassphrase;
    for (const f of SECRET_FIELDS) {
      if (next.auth[f] === undefined) next.auth[f] = existing?.auth?.[f] || '';
      else next.auth[f] = this.encrypt(next.auth[f]);
    }
    if (next.auth.savePassword === false) next.auth.password = '';
    if (existing) Object.assign(existing, next);
    else { next.id = next.id || newId('s_'); list.push(next); }
    this._write('sessions');
    return this._sanitize(existing || next);
  }

  /**
   * Remember a login the user chose to save at the prompt. Updates the stored session,
   * or — for an ad-hoc (quick connect) session — creates a saved session from it.
   * @param {string|object} ref  session id, or the ad-hoc session object
   * @param {{username?: string, password?: string, passphrase?: string}} creds
   * @returns sanitized saved session
   */
  saveCredentials(ref, creds) {
    const stored = typeof ref === 'string' ? this.getSession(ref) : ref?.id ? this.getSession(ref.id) : null;
    const base = stored ? JSON.parse(JSON.stringify(stored)) : JSON.parse(JSON.stringify(ref));
    base.auth = { ...(base.auth || {}) };
    // saveSession treats undefined secrets as "keep stored value"; only pass the new ones.
    for (const f of SECRET_FIELDS) delete base.auth[f];
    if (!stored) {
      delete base.id;
      base.name = base.name || `${creds.username ? creds.username + '@' : ''}${base.host}`;
      base.parent = base.parent || '';
    }
    if (creds.username) base.username = creds.username;
    if (creds.password !== undefined) { base.auth.password = creds.password; base.auth.savePassword = true; }
    if (creds.passphrase !== undefined) base.auth.passphrase = creds.passphrase;
    return this.saveSession(base);
  }

  deleteSession(id) {
    this.data.sessions.sessions = this.data.sessions.sessions.filter((s) => s.id !== id);
    this._write('sessions');
  }

  saveFolder(folder) {
    const list = this.data.sessions.folders;
    const existing = folder.id && list.find((f) => f.id === folder.id);
    if (existing) Object.assign(existing, folder);
    else list.push({ ...folder, id: folder.id || newId('f_') });
    this._write('sessions');
    return existing || list[list.length - 1];
  }

  deleteFolder(id) {
    const { folders, sessions } = this.data.sessions;
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) if (!doomed.has(f.id) && doomed.has(f.parent)) { doomed.add(f.id); grew = true; }
    }
    this.data.sessions.folders = folders.filter((f) => !doomed.has(f.id));
    this.data.sessions.sessions = sessions.filter((s) => !doomed.has(s.parent));
    this._write('sessions');
  }

  moveItem(kind, id, parent) {
    const list = kind === 'folder' ? this.data.sessions.folders : this.data.sessions.sessions;
    const item = list.find((x) => x.id === id);
    if (!item) return;
    if (kind === 'folder') {
      // Refuse to move a folder into its own subtree.
      for (let p = parent; p; p = this.data.sessions.folders.find((f) => f.id === p)?.parent) if (p === id) return;
    }
    item.parent = parent || '';
    this._write('sessions');
  }

  /** Export sessions. Secrets are exported decrypted only when explicitly requested. */
  exportSessions(includeSecrets) {
    const out = JSON.parse(JSON.stringify(this.data.sessions));
    for (const s of out.sessions) {
      for (const f of SECRET_FIELDS) s.auth[f] = includeSecrets ? this.decrypt(s.auth?.[f]) : '';
    }
    return { format: 'termcraft-sessions', version: 1, ...out };
  }

  /**
   * Import sessions from an exported file. Session files can come from anyone, so anything that
   * would run code on this machine when a session is opened (logon scripts, local shell commands)
   * is removed; the caller is told how many sessions were affected.
   * @returns {{ count: number, cleared: number }}
   */
  importSessions(data, parentFolderName = 'Imported') {
    const root = this.saveFolder({ name: parentFolderName, parent: '' });
    const idMap = new Map();
    for (const f of data.folders || []) idMap.set(f.id, newId('f_'));
    for (const f of data.folders || []) {
      this.data.sessions.folders.push({ ...f, id: idMap.get(f.id), parent: f.parent ? idMap.get(f.parent) || root.id : root.id });
    }
    let n = 0;
    let cleared = 0;
    for (const s of data.sessions || []) {
      if (!s || typeof s !== 'object') continue;
      const copy = { ...s, id: undefined, parent: s.parent ? idMap.get(s.parent) || root.id : root.id };
      copy.auth = { ...(s.auth || {}) };
      for (const f of SECRET_FIELDS) if (!copy.auth[f]) delete copy.auth[f];
      if (copy.logonScript || copy.local?.shell || copy.local?.args) {
        cleared++;
        copy.logonScript = '';
        copy.local = { ...(copy.local || {}), shell: '', args: '' };
      }
      this.saveSession(copy);
      n++;
    }
    this._write('sessions');
    return { count: n, cleared };
  }

  /** Import Host entries from an OpenSSH client config file (~/.ssh/config). */
  importSshConfig(file = path.join(os.homedir(), '.ssh', 'config')) {
    const text = fs.readFileSync(file, 'utf8');
    const hosts = [];
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(\w+)\s*=?\s*(.+?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const key = m[1].toLowerCase();
      const val = m[2].replace(/^"|"$/g, '');
      if (key === 'host') {
        cur = null;
        for (const pat of val.split(/\s+/)) {
          if (/[*?!]/.test(pat)) continue;
          cur = { name: pat, protocol: 'ssh2', host: pat, port: 22, username: '', auth: {}, ssh: {} };
          hosts.push(cur);
        }
      } else if (key === 'match') {
        cur = null;
      } else if (cur) {
        if (key === 'hostname') cur.host = val;
        else if (key === 'port') cur.port = Number(val);
        else if (key === 'user') cur.username = val;
        else if (key === 'identityfile') cur.auth.keyFile = val.replace(/^~/, os.homedir());
        else if (key === 'forwardagent') cur.ssh.agentForward = /yes/i.test(val);
        else if (key === 'compression') cur.ssh.compression = /yes/i.test(val);
        else if (key === 'serveraliveinterval') cur.ssh.keepAlive = Number(val);
        else if (key === 'proxyjump') cur._proxyJump = val.split(',')[0];
      }
    }
    if (!hosts.length) return 0;
    const folder = this.saveFolder({ name: 'SSH Config', parent: '' });
    const saved = new Map();
    for (const h of hosts) saved.set(h.name, this.saveSession({ ...h, parent: folder.id, _proxyJump: undefined }));
    for (const h of hosts) {
      if (!h._proxyJump) continue;
      const jump = saved.get(h._proxyJump.replace(/^.*@/, '').replace(/:\d+$/, ''));
      if (jump) {
        const s = this.getSession(saved.get(h.name).id);
        s.ssh = { ...(s.ssh || {}), jumpSessionId: jump.id };
      }
    }
    this._write('sessions');
    return hosts.length;
  }

  // ---- known hosts ---------------------------------------------------
  getKnownHost(hostPort) { return this.data.knownHosts[hostPort]; }

  setKnownHost(hostPort, info) {
    this.data.knownHosts[hostPort] = { ...info, added: new Date().toISOString() };
    this._write('knownHosts');
  }

  listKnownHosts() { return this.data.knownHosts; }

  deleteKnownHost(hostPort) {
    delete this.data.knownHosts[hostPort];
    this._write('knownHosts');
  }
}

module.exports = { Store, DEFAULT_SESSION, DEFAULT_SETTINGS, deepMerge };
