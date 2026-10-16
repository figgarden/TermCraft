// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, shell, Menu, nativeTheme, session: electronSession } = require('electron');
const { pathToFileURL } = require('url');
const { isSafeExternalUrl, ApprovedPaths, safeJsonParse } = require('./security');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('./store');
const { ConnectionManager, PROTOCOLS } = require('./connection-manager');
const { ScriptEngine } = require('./scripting');
const { SftpService } = require('./sftp-service');
const { ScpService } = require('./scp-service');
const { VncBridge, RdpService } = require('./remote-desktop');
const { SerialConnection, defaultShell } = require('./protocols/simple');
const { buildMenu } = require('./menu');
const { Launcher } = require('./launcher');
const { BatchRunner } = require('./batch-runner');
const { TftpServer } = require('./tftp-server');
const { parseHosts } = require('./host-import');
const sshKeys = require('./ssh-keys');
const xmodem = require('./xmodem');
const zmodem = require('./zmodem');
const { SshConnection } = require('./protocols/ssh');
const { timestamp } = require('./util');

app.setName('TermCraft');

const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
const COPYRIGHT = 'Copyright © 2026 Gabriel Moreno and contributors';
const LICENSE_NOTICE = 'TermCraft is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 2 of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.';

let win = null;
let store, manager, scripts, sftp, scpService, vnc, rdp, launcher, batch;
let tftp = null;
const xfers = new Map(); // tabId -> cancel signal
let allowClose = false;
let menuState = {};
const approved = new ApprovedPaths();
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

// ---- main -> renderer request/response ---------------------------------
const pending = new Map();
let reqSeq = 0;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function request(type, payload) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  const id = ++reqSeq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send('main:request', { id, type, payload });
  });
}

/** Only TermCraft's own window (its top frame, showing our index.html) may talk to the main process. */
function trustedSender(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === INDEX_URL;
}

ipcMain.on('main:response', (_e, id, result) => {
  if (!trustedSender(_e)) return;
  const resolve = pending.get(id);
  if (resolve) { pending.delete(id); resolve(result); }
});

// ---- window ------------------------------------------------------------
function createWindow() {
  const bounds = store.getSettings().windowBounds || { width: 1280, height: 800 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    title: 'TermCraft',
    backgroundColor: '#1b1d23',
    // macOS: the toolbar is the title bar (window controls inset into it), like native Mac apps.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    show: false,
    icon: ICON, // window/taskbar icon on Windows and Linux
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(INDEX_HTML);

  // Links clicked in the terminal open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.TERMCRAFT_DEBUG) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
    win.webContents.on('did-finish-load', () => console.log('[main] renderer loaded'));
  }
  // Dev hook: TERMCRAFT_SMOKE=path/to/script.js drives the UI for automated smoke tests.
  // Never available in packaged builds (it loads arbitrary code).
  if (process.env.TERMCRAFT_SMOKE && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      require(path.resolve(process.env.TERMCRAFT_SMOKE))(win, { store, manager, app })
        .catch((e) => console.error('[smoke]', e))
        .finally(() => {
          allowClose = true;
          app.quit();
          // Test runs only: if something keeps the app alive, say what, then exit so CI doesn't hang.
          setTimeout(() => {
            const handles = (process._getActiveHandles?.() || []).map((h) => h?.constructor?.name || typeof h);
            console.error(`[smoke] Error app did not quit within 5 s; open handles: ${handles.join(', ')}`);
            app.exit(1);
          }, 5000).unref();
        });
    });
  }

  win.on('close', (e) => {
    store.saveSettings({ windowBounds: win.getBounds() });
    if (allowClose) return;
    e.preventDefault();
    request('confirmClose', {}).then((ok) => {
      if (ok) { allowClose = true; win.close(); }
    });
  });
  win.on('closed', () => {
    win = null;
    manager.closeAll();
    sftp.closeAll();
    scpService.closeAll();
    vnc.closeAll();
    rdp.closeAll();
    batch.cancelAll();
    tftp?.stop();
    tftp = null;
  });
  refreshMenu();
}

function refreshMenu() {
  const s = store.getSettings();
  Menu.setApplicationMenu(buildMenu((action, arg) => send('menu:action', action, arg), {
    ...menuState,
    showSessionManager: s.showSessionManager,
    showButtonBar: s.showButtonBar,
    showCommandWindow: s.showCommandWindow,
    showStatusBar: s.showStatusBar,
    recentScripts: s.recentScripts,
  }));
}

// ---- IPC: store ----------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trustedSender(e)) throw new Error('Untrusted sender');
    return fn(...args);
  });
}

function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => { if (trustedSender(e)) fn(...args); });
}

/** Scripts the user configured or picked: recent scripts, button bars, key map, dialog choices. */
function isApprovedScript(file) {
  const s = store.getSettings();
  const resolved = path.resolve(String(file).replace(/^~/, os.homedir()));
  const configured = [
    ...(s.recentScripts || []),
    ...(s.buttonBars || []).flatMap((b) => b.buttons.filter((x) => x.action === 'script').map((x) => x.value)),
    ...(s.keymap || []).filter((k) => k.action === 'script').map((k) => k.value),
  ].filter(Boolean).map((f) => path.resolve(String(f).replace(/^~/, os.homedir())));
  return configured.includes(resolved) || approved.isApprovedFile(resolved);
}

/** Native (not page-drawn) approval for a Launch Application command. */
async function confirmLaunch(argv, command) {
  const args = argv.slice(1);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Launch Application',
    message: 'Allow this button to run a program on your computer?',
    detail: `Program: ${argv[0]}\n${args.length ? `Arguments: ${args.map((a) => JSON.stringify(a)).join(' ')}\n` : ''}`
      + `\nCommand: ${command}\n\nOnly allow programs you trust. Button bars imported from someone else can contain commands.`,
    buttons: ['Cancel', 'Run Once', 'Always Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return [false, 'once', 'always'][response] || false;
}

/** This computer's IPv4 addresses (what a device needs for copy tftp://...). */
function localAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })));
}

/**
 * Files to send, in order. Several files ("a series") are shown to the user to put in the order
 * the device expects; only files picked in this dialog can be sent.
 */
async function chooseFilesToSend(tabId, protocol, multiple) {
  const r = await dialog.showOpenDialog(win, { title: `Send ${protocol.toUpperCase()}`, properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  if (r.filePaths.length === 1) return r.filePaths;
  const picked = new Set(r.filePaths);
  const ordered = await request('orderFiles', { tabId, protocol, files: r.filePaths });
  if (!Array.isArray(ordered) || !ordered.length) return null;
  return ordered.filter((f, i) => picked.has(f) && ordered.indexOf(f) === i);
}

/** The device ran rz (wants files) or sz (is sending): run ZMODEM in that tab. */
function startZmodem(tabId, direction, initial) {
  const run = direction === 'send'
    ? runXfer(tabId, 'zmodem', 'send', async (io, signal, onProgress) => {
      const files = await chooseFilesToSend(tabId, 'zmodem', true);
      if (!files) { io.write(zmodem.ABORT); return null; } // tell rz we're not sending anything
      await zmodem.send(io, files, { signal, onProgress });
      return files;
    }, initial)
    : runXfer(tabId, 'zmodem', 'receive', (io, signal, onProgress) => {
      // Device-started downloads always go to ~/Downloads (a fixed place the page can't redirect).
      const dir = path.join(os.homedir(), 'Downloads');
      fs.mkdirSync(dir, { recursive: true });
      return zmodem.receive(io, dir, { signal, onProgress });
    }, initial);
  run.catch(() => {}); // reported to the tab by runXfer
}

/** Run an XMODEM/YMODEM transfer on a tab, reporting progress to it. */
async function runXfer(tabId, protocol, direction, fn, initial = null) {
  if (xfers.has(tabId)) throw new Error('A file transfer is already running in this tab');
  const signal = {};
  xfers.set(tabId, signal);
  let last = 0;
  const onProgress = (p) => { const now = Date.now(); if (now - last > 200 || p.bytes === p.size) { last = now; send('xfer:progress', tabId, { protocol, direction, ...p }); } };
  send('xfer:progress', tabId, { protocol, direction, state: 'waiting' });
  try {
    const files = await manager.rawTransfer(tabId, (io) => fn(io, signal, onProgress), initial);
    if (!files) { send('xfer:progress', tabId, { protocol, direction, state: 'cancelled' }); return null; }
    send('xfer:progress', tabId, { protocol, direction, state: 'done', files });
    return files;
  } catch (e) {
    send('xfer:progress', tabId, { protocol, direction, state: 'failed', error: e.message });
    throw e;
  } finally {
    xfers.delete(tabId);
  }
}

function registerIpc() {
  handle('store:tree', () => store.getTree());
  handle('store:saveSession', (s) => store.saveSession(s));
  handle('store:deleteSession', (id) => store.deleteSession(id));
  handle('store:saveFolder', (f) => store.saveFolder(f));
  handle('store:deleteFolder', (id) => store.deleteFolder(id));
  handle('store:move', (kind, id, parent) => store.moveItem(kind, id, parent));
  handle('store:settings', () => store.getSettings());
  handle('store:saveSettings', (patch) => { const s = store.saveSettings(patch); refreshMenu(); return s; });
  handle('store:knownHosts', () => store.listKnownHosts());
  handle('store:deleteKnownHost', (hp) => store.deleteKnownHost(hp));
  handle('store:importSshConfig', () => store.importSshConfig());

  handle('store:export', async (includeSecrets) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export Sessions', defaultPath: 'termcraft-sessions.json', filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled) return null;
    fs.writeFileSync(filePath, JSON.stringify(store.exportSessions(includeSecrets), null, 2), { mode: 0o600 });
    return filePath;
  });

  handle('store:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import Sessions', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled) return null;
    return store.importSessions(safeJsonParse(fs.readFileSync(filePaths[0], 'utf8')));
  });

  // ---- connections ----
  handle('conn:open', (tabId, sessionRef, cols, rows) => manager.open(tabId, sessionRef, cols, rows));
  on('conn:write', (tabId, data) => manager.write(tabId, data));
  on('conn:resize', (tabId, cols, rows) => manager.resize(tabId, cols, rows));
  handle('conn:close', (tabId) => manager.close(tabId));
  handle('conn:break', (tabId) => manager.sendBreak(tabId));
  handle('conn:log', async (tabId, enable, chooseFile) => {
    if (!enable) return manager.stopLog(tabId);
    let file;
    if (chooseFile) {
      const r = await dialog.showSaveDialog(win, { title: 'Log Session As', defaultPath: path.join(os.homedir(), 'session.log') });
      if (r.canceled) return null;
      file = r.filePath;
    }
    return manager.startLog(tabId, file);
  });
  handle('serial:list', () => SerialConnection.list());

  // ---- sftp ----
  handle('sftp:open', (id, ref) => sftp.open(id, ref));
  handle('sftp:close', (id) => sftp.close(id));
  handle('sftp:listRemote', (id, dir) => sftp.listRemote(id, dir));
  handle('sftp:listLocal', async (dir) => {
    const res = await sftp.listLocal(dir);
    approved.approveDir(res.path); // the user is browsing here; allow file operations in it
    return res;
  });
  handle('sftp:remoteOp', (id, op, a, b) => sftp.remoteOp(id, op, a, b));
  handle('sftp:localOp', (op, a, b) => {
    // Only inside folders the user has browsed in the SFTP local pane.
    if (!approved.isInApprovedDir(a) || (b != null && !approved.isInApprovedDir(b))) throw new Error('Path is outside the browsed folders');
    return sftp.localOp(op, a, b);
  });
  handle('sftp:download', (id, tid, remote, localDir) => sftp.download(id, tid, remote, localDir));
  handle('sftp:upload', (id, tid, local, remoteDir) => sftp.upload(id, tid, local, remoteDir));

  // ---- remote desktops ----
  handle('remote:vncOpen', (tabId, ref) => vnc.open(tabId, ref));
  handle('remote:vncClose', (tabId) => vnc.close(tabId));
  handle('remote:rdpLaunch', (tabId, ref) => rdp.launch(tabId, ref));
  handle('remote:rdpClose', (tabId) => rdp.close(tabId));
  // Save a login entered in the renderer (VNC authenticates there), after it succeeded.
  handle('store:saveCredentials', (ref, creds) => store.saveCredentials(ref, creds));

  // ---- scp ----
  handle('scp:open', (tabId, ref, jump) => scpService.open(tabId, ref, jump));
  handle('scp:close', (tabId) => scpService.close(tabId));
  handle('scp:upload', (tabId, jobId, paths, remoteDir, opts) => scpService.upload(tabId, jobId, paths, remoteDir, opts));
  handle('scp:download', (tabId, jobId, remotePath, localDir, opts) => scpService.download(tabId, jobId, remotePath, localDir, opts));
  handle('scp:cancel', (jobId) => scpService.cancel(jobId));
  handle('dialog:openPaths', async (opts = {}) => {
    const props = Array.isArray(opts.properties) ? opts.properties.filter((p) => ['openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles'].includes(p)) : ['openFile', 'multiSelections', 'showHiddenFiles'];
    const r = await dialog.showOpenDialog(win, { title: typeof opts.title === 'string' ? opts.title : undefined, properties: props });
    if (r.canceled) return [];
    r.filePaths.forEach((f) => approved.approveFile(f));
    return r.filePaths;
  });

  // ---- shared credentials and bulk host import ----
  handle('cred:save', (c) => store.saveCredential(c));
  handle('cred:delete', (id) => store.deleteCredential(id));
  handle('hosts:parse', (text, defaults) => parseHosts(String(text || '').slice(0, 5e6), defaults || {}));
  handle('hosts:import', (rows, opts) => store.importHosts(rows, opts || {}));

  // ---- run commands on many sessions ----
  // Output goes to ~/TermCraft Output/<date time> or to a folder the user picked in a dialog.
  handle('batch:start', (runId, opts = {}) => {
    let dir = opts.outputDir && approved.isChosenDir(opts.outputDir) ? path.resolve(opts.outputDir) : '';
    if (opts.outputDir && !dir) throw new Error('Choose the output folder with Browse…');
    const stamp = timestamp().replace(/[: ]/g, (c) => (c === ':' ? '' : '-')).replace(/\..*$/, '');
    dir = path.join(dir || path.join(os.homedir(), 'TermCraft Output'), stamp);
    return batch.start(String(runId), {
      sessionIds: (opts.sessionIds || []).map(String), commands: (opts.commands || []).map(String),
      concurrency: opts.concurrency, timeoutSec: opts.timeoutSec, outputDir: dir,
    });
  });
  handle('batch:cancel', (runId) => batch.cancel(String(runId)));

  // ---- TFTP server ----
  const tftpStatus = () => ({ running: !!tftp?.running, ...(tftp ? { root: tftp.opts.root, port: tftp.opts.port, host: tftp.opts.host, allowWrite: tftp.opts.allowWrite, allowOverwrite: tftp.opts.allowOverwrite } : {}) });
  handle('tftp:status', () => ({ ...tftpStatus(), defaultRoot: path.join(os.homedir(), 'TermCraft TFTP'), addresses: localAddresses() }));
  handle('tftp:start', async (opts = {}) => {
    tftp?.stop();
    let root = opts.root ? path.resolve(String(opts.root).replace(/^~/, os.homedir())) : path.join(os.homedir(), 'TermCraft TFTP');
    // The TFTP folder is shared on the network: only the default or a folder picked in a dialog.
    if (root !== path.join(os.homedir(), 'TermCraft TFTP') && !approved.isChosenDir(root)) throw new Error('Choose the TFTP folder with Browse…');
    fs.mkdirSync(root, { recursive: true });
    const port = Number(opts.port) || 69;
    if (!(port > 0 && port < 65536)) throw new Error('Invalid port');
    const host = opts.host === '127.0.0.1' ? '127.0.0.1' : opts.host && localAddresses().some((a) => a.address === opts.host) ? opts.host : '0.0.0.0';
    const server = new TftpServer({ root, port, host, allowWrite: !!opts.allowWrite, allowOverwrite: !!opts.allowOverwrite });
    server.on('transfer', (t) => send('tftp:transfer', t));
    server.on('log', (m) => send('tftp:log', m));
    await server.start();
    tftp = server;
    return tftpStatus();
  });
  handle('tftp:stop', () => { tftp?.stop(); tftp = null; return tftpStatus(); });

  // ---- XMODEM / YMODEM in a terminal tab ----
  handle('xfer:send', async (tabId, protocol) => {
    if (!['xmodem', 'xmodem-1k', 'ymodem', 'zmodem'].includes(protocol)) throw new Error('Unknown protocol');
    const files = await chooseFilesToSend(tabId, protocol, protocol === 'ymodem' || protocol === 'zmodem');
    if (!files) return null;
    const proto = protocol === 'zmodem' ? zmodem : xmodem;
    return runXfer(tabId, protocol, 'send', (io, signal, onProgress) => proto.send(io, files, { protocol, signal, onProgress }).then(() => files));
  });
  handle('xfer:receive', async (tabId, protocol) => {
    if (!['xmodem', 'ymodem', 'zmodem'].includes(protocol)) throw new Error('Unknown protocol');
    let dir; let name;
    if (protocol === 'xmodem') {
      const r = await dialog.showSaveDialog(win, { title: 'Receive XMODEM — save as', defaultPath: path.join(os.homedir(), 'Downloads', 'received.bin') });
      if (r.canceled) return null;
      dir = path.dirname(r.filePath); name = path.basename(r.filePath);
      if (fs.existsSync(r.filePath)) fs.rmSync(r.filePath); // the user confirmed replacing it in the dialog
    } else {
      const r = await dialog.showOpenDialog(win, { title: 'Receive YMODEM — choose a folder', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      dir = r.filePaths[0];
    }
    const proto = protocol === 'zmodem' ? zmodem : xmodem;
    return runXfer(tabId, protocol, 'receive', (io, signal, onProgress) => proto.receive(io, dir, { protocol, name, signal, onProgress }));
  });
  handle('xfer:cancel', (tabId) => { const s = xfers.get(tabId); if (s) { s.cancelled = true; s.onCancel?.(); } });

  // ---- SSH keys ----
  handle('keys:list', () => sshKeys.listPublicKeys());
  handle('keys:generate', (opts = {}) => sshKeys.generateKey({ name: String(opts.name || ''), kind: String(opts.kind || 'ed25519'), passphrase: String(opts.passphrase || ''), comment: String(opts.comment || '') }));
  handle('keys:install', async (sessionRef, pubFile) => {
    const key = sshKeys.listPublicKeys().find((k) => k.file === pubFile);
    if (!key) throw new Error('Choose a public key from ~/.ssh');
    const session = store.resolveSession(sessionRef);
    if (session.protocol !== 'ssh2') throw new Error('Keys can only be installed on SSH2 sessions');
    session.forwards = [];
    const conn = new SshConnection(session, { store, mode: 'tunnel', prompt: (req) => request('prompt', req) });
    conn.on('error', () => {});
    await conn.connect();
    try {
      const out = await new Promise((resolve, reject) => {
        conn.exec(sshKeys.installCommand(key.line)).then((st) => {
          let text = '';
          const timer = setTimeout(() => { st.close?.(); reject(new Error('The server did not answer')); }, 15000);
          st.on('data', (d) => { text += d; });
          st.stderr?.on('data', (d) => { text += d; });
          st.on('close', () => { clearTimeout(timer); resolve(text); });
        }, reject);
      });
      if (/TERMCRAFT_KEY_PRESENT/.test(out)) return { status: 'present', privateKey: key.privateKey };
      if (/TERMCRAFT_KEY_ADDED/.test(out)) return { status: 'added', privateKey: key.privateKey };
      throw new Error(`The server did not accept the key (it may not be a Unix shell): ${out.trim().slice(0, 200)}`);
    } finally { conn.close(); }
  });

  // ---- save terminal output ----
  handle('file:saveOutput', async (defaultName, text) => {
    const name = String(defaultName || 'output').replace(/[^\w.@ -]+/g, '_').slice(0, 100);
    const r = await dialog.showSaveDialog(win, { title: 'Save Output As', defaultPath: path.join(os.homedir(), `${name}.txt`), filters: [{ name: 'Text', extensions: ['txt', 'log'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, String(text), { mode: 0o600 });
    return r.filePath;
  });

  // ---- scripts ----
  handle('script:run', async (file, tabId) => {
    if (file && !isApprovedScript(file)) throw new Error('That script has not been chosen or configured in TermCraft');
    if (!file) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Run Script', properties: ['openFile'],
        defaultPath: path.join(__dirname, '..', '..', 'examples', 'scripts'),
        filters: [{ name: 'JavaScript', extensions: ['js'] }],
      });
      if (r.canceled) return null;
      file = r.filePaths[0];
      approved.approveFile(file);
    }
    const recent = [file, ...(store.getSettings().recentScripts || []).filter((f) => f !== file)].slice(0, 8);
    store.saveSettings({ recentScripts: recent });
    refreshMenu();
    try {
      await scripts.run(file, tabId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.stack || err.message };
    }
  });
  handle('script:cancel', () => scripts.cancelAll());

  // ---- misc ----
  // Dialog results are what the user explicitly chose, so they become approved paths.
  const dialogOpts = (opts, defaults) => ({ title: typeof opts?.title === 'string' ? opts.title : undefined, filters: Array.isArray(opts?.filters) ? opts.filters : undefined, properties: defaults });
  handle('dialog:openFile', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, dialogOpts(opts, ['openFile', 'showHiddenFiles']));
    if (r.canceled) return null;
    approved.approveFile(r.filePaths[0]);
    return r.filePaths[0];
  });
  handle('dialog:openDir', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, dialogOpts(opts, ['openDirectory', 'createDirectory']));
    if (r.canceled) return null;
    approved.chooseDir(r.filePaths[0]);
    return r.filePaths[0];
  });
  handle('file:readText', (file) => {
    if (!approved.isApprovedFile(file)) throw new Error('File was not chosen in a dialog');
    return fs.readFileSync(file, 'utf8');
  });
  handle('file:saveText', async (defaultName, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(os.homedir(), defaultName), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
  // "Launch Application" buttons: run a program configured on a saved button, without a shell,
  // after the user approves that exact command in a native dialog (see launcher.js).
  handle('shell:run', (command) => {
    const configured = (store.getSettings().buttonBars || []).some((b) => b.buttons.some((x) => x.action === 'run' && x.value === command));
    if (!configured) throw new Error('Command is not configured on any button');
    return launcher.run(command);
  });
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (text) => clipboard.writeText(text));
  handle('app:info', () => ({
    platform: process.platform, version: app.getVersion(), home: os.homedir(), defaultShell: defaultShell(),
    encryption: safeStorage.isEncryptionAvailable(),
  }));
  // Folders only: opening a file could launch an executable.
  handle('shell:openPath', async (p) => {
    const target = path.resolve(String(p).replace(/^~/, os.homedir()));
    let st;
    try { st = await fs.promises.stat(target); } catch { await fs.promises.mkdir(target, { recursive: true, mode: 0o700 }); st = await fs.promises.stat(target); }
    if (!st.isDirectory()) { shell.showItemInFolder(target); return ''; }
    return shell.openPath(target);
  });
  handle('shell:openExternal', (url) => isSafeExternalUrl(url) && shell.openExternal(url));
  handle('menu:state', (state) => { menuState = { ...menuState, ...state }; refreshMenu(); });
  // Native parts (title bar, window controls, scrollbars, system dialogs) follow the app's theme.
  handle('app:chrome', ({ source, bg } = {}) => {
    if (['system', 'light', 'dark'].includes(source) && nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    if (typeof bg === 'string' && /^#[0-9a-f]{6}$/i.test(bg)) win?.setBackgroundColor(bg);
  });
  handle('app:about', () => ({ version: app.getVersion(), copyright: COPYRIGHT, notice: LICENSE_NOTICE, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }));
  handle('app:keychainStatus', () => store.checkKeychain());
  handle('app:licenseText', () => fs.readFileSync(path.join(__dirname, '..', '..', 'LICENSE'), 'utf8'));
  handle('app:examplesDir', () => path.join(__dirname, '..', '..', 'examples', 'scripts'));
}

/**
 * One-time migration from the app's former name (OpenCRT): copy sessions, settings and
 * known hosts, and update references to the old default log folder and color scheme.
 * Saved passwords can't be migrated (the OS keychain entry is tied to the app name);
 * TermCraft prompts for them on next connect.
 */
function migrateFromOpenCrt(newDir) {
  // Only for the real TermCraft profile: never copy the user's data into custom
  // --user-data-dir profiles (tests, demos, screenshots).
  if (path.resolve(app.getPath('userData')) !== path.resolve(app.getPath('appData'), 'TermCraft')) return;
  const oldDir = path.join(app.getPath('appData'), 'OpenCRT', 'data');
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  fs.cpSync(oldDir, newDir, { recursive: true });
  for (const file of ['settings.json', 'sessions.json']) {
    const p = path.join(newDir, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8')
      .replaceAll('~/OpenCRT Logs/', '~/TermCraft Logs/')
      .replaceAll('"OpenCRT Dark"', '"TermCraft Dark"');
    fs.writeFileSync(p, text, { mode: 0o600 });
  }
  console.log(`[main] migrated data from ${oldDir}`);
}

// Deny every web permission (camera, mic, geolocation, notifications…), block embedded webviews
// and new windows in any web contents.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  app.setAboutPanelOptions({
    applicationName: 'TermCraft',
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT,
    credits: LICENSE_NOTICE,
    iconPath: ICON,
  });
  // In development the Dock shows Electron's icon unless we set ours.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON);
  const dataDir = path.join(app.getPath('userData'), 'data');
  try { migrateFromOpenCrt(dataDir); } catch (e) { console.error('[main] migration failed:', e); }
  store = new Store(dataDir, safeStorage);
  manager = new ConnectionManager({
    store, send, request,
    onZmodem: (tabId, direction, initial) => startZmodem(tabId, direction, initial),
    runScript: (file, tabId) => scripts.run(file.replace(/^~/, os.homedir()), tabId),
  });
  scripts = new ScriptEngine({ manager, request, store });
  sftp = new SftpService({ store, request, send });
  scpService = new ScpService({ store, request, send });
  vnc = new VncBridge({ store, request, send });
  rdp = new RdpService({ store, request, send });
  launcher = new Launcher(path.join(dataDir, 'approved_commands.json'), { confirm: confirmLaunch });
  batch = new BatchRunner({ store, request, send, protocols: PROTOCOLS });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (!win) { allowClose = false; createWindow(); } });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
