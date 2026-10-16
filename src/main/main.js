// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, shell, Menu, session: electronSession } = require('electron');
const { pathToFileURL } = require('url');
const { isSafeExternalUrl, ApprovedPaths, safeJsonParse } = require('./security');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('./store');
const { ConnectionManager } = require('./connection-manager');
const { ScriptEngine } = require('./scripting');
const { SftpService } = require('./sftp-service');
const { ScpService } = require('./scp-service');
const { VncBridge, RdpService } = require('./remote-desktop');
const { SerialConnection, defaultShell } = require('./protocols/simple');
const { buildMenu } = require('./menu');

app.setName('TermCraft');

const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
const COPYRIGHT = 'Copyright © 2026 Gabriel Moreno and contributors';
const LICENSE_NOTICE = 'TermCraft is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 2 of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.';

let win = null;
let store, manager, scripts, sftp, scpService, vnc, rdp;
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
        .finally(() => { allowClose = true; app.quit(); });
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
    approved.approveDir(r.filePaths[0]);
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
  // "Launch Application" buttons: run a user-defined local command, detached from TermCraft.
  // Only commands that are actually configured on a saved button may run.
  handle('shell:run', (command) => {
    const configured = (store.getSettings().buttonBars || []).some((b) => b.buttons.some((x) => x.action === 'run' && x.value === command));
    if (!configured) throw new Error('Command is not configured on any button');
    const child = require('child_process').spawn(command, { shell: true, detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error('[run]', e));
    child.unref();
    return true;
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
    runScript: (file, tabId) => scripts.run(file.replace(/^~/, os.homedir()), tabId),
  });
  scripts = new ScriptEngine({ manager, request, store });
  sftp = new SftpService({ store, request, send });
  scpService = new ScpService({ store, request, send });
  vnc = new VncBridge({ store, request, send });
  rdp = new RdpService({ store, request, send });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (!win) { allowClose = false; createWindow(); } });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
