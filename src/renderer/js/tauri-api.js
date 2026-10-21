// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// `window.api`: the page's bridge to the backend (src-tauri). Every call goes through one
// command, `ipc`, with the channel name; backend events arrive as one event, `termcraft`.
// Loaded as a classic script before the app module, so `window.api` exists when it starts.
'use strict';
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const clean = (args) => args.map((a) => (a === undefined ? null : a));
  const call = (channel) => (...args) => invoke('ipc', { channel, args: clean(args) })
    .catch((e) => { throw new Error(typeof e === 'string' ? e : e?.message || String(e)); });
  const fire = (channel) => (...args) => { invoke('ipc', { channel, args: clean(args) }).catch(() => {}); };
  // Calls are handled concurrently; keystrokes carry a per-tab sequence number so the backend
  // writes them in the order they were typed.
  const writeSeq = new Map();
  const write = (tabId, data) => {
    const n = (writeSeq.get(tabId) || 0) + 1;
    writeSeq.set(tabId, n);
    invoke('ipc', { channel: 'conn:write', args: [tabId, data, n] }).catch(() => {});
  };

  const listeners = new Map();
  listen('termcraft', (e) => {
    const { channel, args } = e.payload || {};
    for (const cb of [...(listeners.get(channel) || [])]) {
      try { cb(...(args || [])); } catch (err) { console.error(err); }
    }
  });
  const on = (channel) => (cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel)?.delete(cb);
  };

  // Files dropped from the system: the window reports their paths; the page gets a normal
  // dragover/drop on the element under the pointer, with File-like items that carry the path.
  const PATH = Symbol('path');
  const fileItems = (paths) => paths.map((p) => ({ name: String(p).split(/[\\/]/).pop(), [PATH]: String(p) }));
  const synth = (type, position, paths = []) => {
    const ratio = window.devicePixelRatio || 1;
    const x = (position?.x || 0) / ratio;
    const y = (position?.y || 0) / ratio;
    const target = document.elementFromPoint(x, y) || document.body;
    const files = fileItems(paths);
    const dataTransfer = { files, items: files, types: files.length ? ['Files'] : [], getData: () => '', setData() {}, dropEffect: 'copy', effectAllowed: 'all' };
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: y });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(ev);
    return target;
  };
  let lastTarget = null;
  listen('tauri://drag-enter', (e) => { lastTarget = synth('dragover', e.payload?.position, e.payload?.paths); });
  listen('tauri://drag-over', (e) => {
    const t = synth('dragover', e.payload?.position);
    if (lastTarget && lastTarget !== t && !t.contains(lastTarget)) lastTarget.dispatchEvent(new Event('dragleave', { bubbles: true }));
    lastTarget = t;
  });
  listen('tauri://drag-leave', () => { lastTarget?.dispatchEvent(new Event('dragleave', { bubbles: true })); lastTarget = null; });
  listen('tauri://drag-drop', (e) => { synth('drop', e.payload?.position, e.payload?.paths || []); lastTarget = null; });

  window.api = {
    store: {
      tree: call('store:tree'),
      saveSession: call('store:saveSession'),
      deleteSession: call('store:deleteSession'),
      saveFolder: call('store:saveFolder'),
      deleteFolder: call('store:deleteFolder'),
      move: call('store:move'),
      settings: call('store:settings'),
      saveSettings: call('store:saveSettings'),
      knownHosts: call('store:knownHosts'),
      deleteKnownHost: call('store:deleteKnownHost'),
      exportSessions: call('store:export'),
      importSessions: call('store:import'),
      importSshConfig: call('store:importSshConfig'),
      saveCredentials: call('store:saveCredentials'),
      saveCredential: call('cred:save'),
      deleteCredential: call('cred:delete'),
      parseHosts: call('hosts:parse'),
      importHosts: call('hosts:import'),
    },
    batch: { start: call('batch:start'), cancel: call('batch:cancel'), onUpdate: on('batch:update'), onDone: on('batch:done') },
    tftp: { status: call('tftp:status'), start: call('tftp:start'), stop: call('tftp:stop'), onTransfer: on('tftp:transfer'), onLog: on('tftp:log') },
    xfer: { send: call('xfer:send'), receive: call('xfer:receive'), cancel: call('xfer:cancel'), onProgress: on('xfer:progress') },
    keys: { list: call('keys:list'), generate: call('keys:generate'), install: call('keys:install') },
    conn: {
      open: call('conn:open'),
      write,
      resize: fire('conn:resize'),
      close: call('conn:close'),
      sendBreak: call('conn:break'),
      log: call('conn:log'),
      onData: on('conn:data'),
      onState: on('conn:state'),
      onStatus: on('conn:status'),
      onLog: on('conn:log'),
      onSessionSaved: on('session:saved'),
    },
    serial: { list: call('serial:list') },
    rns: { tools: call('rns:tools') },
    sftp: {
      open: call('sftp:open'),
      close: call('sftp:close'),
      listRemote: call('sftp:listRemote'),
      listLocal: call('sftp:listLocal'),
      remoteOp: call('sftp:remoteOp'),
      localOp: call('sftp:localOp'),
      download: call('sftp:download'),
      upload: call('sftp:upload'),
      onProgress: on('sftp:progress'),
      onClosed: on('sftp:closed'),
    },
    remote: {
      vncOpen: call('remote:vncOpen'),
      vncClose: call('remote:vncClose'),
      rdpLaunch: call('remote:rdpLaunch'),
      rdpClose: call('remote:rdpClose'),
      onStatus: on('remote:status'),
    },
    scp: {
      open: call('scp:open'),
      close: call('scp:close'),
      upload: call('scp:upload'),
      download: call('scp:download'),
      cancel: call('scp:cancel'),
      onProgress: on('scp:progress'),
      onClosed: on('scp:closed'),
      onLog: on('scp:log'),
    },
    script: { run: call('script:run'), cancel: call('script:cancel'), examplesDir: call('app:examplesDir') },
    dialog: { openFile: call('dialog:openFile'), openDir: call('dialog:openDir'), openPaths: call('dialog:openPaths') },
    file: { readText: call('file:readText'), saveText: call('file:saveText'), saveOutput: call('file:saveOutput'), pathFor: (file) => (file && file[PATH]) || '' },
    clipboard: { read: call('clipboard:read'), write: call('clipboard:write') },
    app: {
      info: call('app:info'),
      openPath: call('shell:openPath'),
      openExternal: call('shell:openExternal'),
      run: call('shell:run'),
      about: call('app:about'),
      licenseText: call('app:licenseText'),
      keychainStatus: call('app:keychainStatus'),
      setMenuState: call('menu:state'),
      setChrome: call('app:chrome'),
    },
    onMenu: on('menu:action'),
    /** Handle requests from the backend (prompts, script queries). Handler may return a promise. */
    onRequest: (handler) => {
      on('main:request')(async ({ id, type, payload }) => {
        let result = null;
        try { result = await handler(type, payload); } catch (err) { console.error(err); }
        invoke('ipc', { channel: 'main:response', args: [id, result === undefined ? null : result] }).catch(() => {});
      });
    },
  };
  Object.freeze(window.api);
})();
