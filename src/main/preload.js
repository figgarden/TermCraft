// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  store: {
    tree: invoke('store:tree'),
    saveSession: invoke('store:saveSession'),
    deleteSession: invoke('store:deleteSession'),
    saveFolder: invoke('store:saveFolder'),
    deleteFolder: invoke('store:deleteFolder'),
    move: invoke('store:move'),
    settings: invoke('store:settings'),
    saveSettings: invoke('store:saveSettings'),
    knownHosts: invoke('store:knownHosts'),
    deleteKnownHost: invoke('store:deleteKnownHost'),
    exportSessions: invoke('store:export'),
    importSessions: invoke('store:import'),
    importSshConfig: invoke('store:importSshConfig'),
    saveCredentials: invoke('store:saveCredentials'),
  },
  conn: {
    open: invoke('conn:open'),
    write: (tabId, data) => ipcRenderer.send('conn:write', tabId, data),
    resize: (tabId, cols, rows) => ipcRenderer.send('conn:resize', tabId, cols, rows),
    close: invoke('conn:close'),
    sendBreak: invoke('conn:break'),
    log: invoke('conn:log'),
    onData: on('conn:data'),
    onState: on('conn:state'),
    onStatus: on('conn:status'),
    onLog: on('conn:log'),
    onSessionSaved: on('session:saved'),
  },
  serial: { list: invoke('serial:list') },
  sftp: {
    open: invoke('sftp:open'),
    close: invoke('sftp:close'),
    listRemote: invoke('sftp:listRemote'),
    listLocal: invoke('sftp:listLocal'),
    remoteOp: invoke('sftp:remoteOp'),
    localOp: invoke('sftp:localOp'),
    download: invoke('sftp:download'),
    upload: invoke('sftp:upload'),
    onProgress: on('sftp:progress'),
    onClosed: on('sftp:closed'),
  },
  remote: {
    vncOpen: invoke('remote:vncOpen'),
    vncClose: invoke('remote:vncClose'),
    rdpLaunch: invoke('remote:rdpLaunch'),
    rdpClose: invoke('remote:rdpClose'),
    onStatus: on('remote:status'),
  },
  scp: {
    open: invoke('scp:open'),
    close: invoke('scp:close'),
    upload: invoke('scp:upload'),
    download: invoke('scp:download'),
    cancel: invoke('scp:cancel'),
    onProgress: on('scp:progress'),
    onClosed: on('scp:closed'),
    onLog: on('scp:log'),
  },
  script: { run: invoke('script:run'), cancel: invoke('script:cancel'), examplesDir: invoke('app:examplesDir') },
  dialog: { openFile: invoke('dialog:openFile'), openDir: invoke('dialog:openDir'), openPaths: invoke('dialog:openPaths') },
  file: { readText: invoke('file:readText'), saveText: invoke('file:saveText'), pathFor: (file) => webUtils.getPathForFile(file) },
  clipboard: { read: invoke('clipboard:read'), write: invoke('clipboard:write') },
  app: {
    info: invoke('app:info'),
    openPath: invoke('shell:openPath'),
    openExternal: invoke('shell:openExternal'),
    run: invoke('shell:run'),
    about: invoke('app:about'),
    licenseText: invoke('app:licenseText'),
    keychainStatus: invoke('app:keychainStatus'),
    setMenuState: invoke('menu:state'),
  },
  onMenu: on('menu:action'),
  /** Handle requests from the main process (prompts, script queries). Handler may return a promise. */
  onRequest: (handler) => {
    ipcRenderer.on('main:request', async (_e, { id, type, payload }) => {
      let result = null;
      try { result = await handler(type, payload); } catch (err) { console.error(err); }
      ipcRenderer.send('main:response', id, result);
    });
  },
});
