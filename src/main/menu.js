// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { Menu, app, shell } = require('electron');

const isMac = process.platform === 'darwin';
// On macOS Cmd shortcuts don't collide with the terminal; elsewhere Ctrl+Shift avoids stealing Ctrl+C etc.
const mod = (key) => (isMac ? `Cmd+${key}` : `Ctrl+Shift+${key}`);

/**
 * @param {(action: string, arg?: any) => void} act  dispatches to the renderer
 * @param {object} state  check-box states { showSessionManager, showButtonBar, ... }
 */
function buildMenu(act, state = {}) {
  const item = (label, action, accelerator, extra = {}) => ({ label, accelerator, click: () => act(action), ...extra });
  const check = (label, action, key, accelerator) => ({
    label, type: 'checkbox', checked: !!state[key], accelerator, click: () => act(action),
  });
  const layout = (label, value, key) => ({
    label, type: 'radio', checked: (state.layout || 'tabs') === value,
    accelerator: isMac ? `Cmd+Alt+${key}` : undefined,
    click: () => act(`layout:${value}`),
  });
  const recent = (state.recentScripts || []).map((f) => ({ label: f, click: () => act('runScript', f) }));

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Global Options…', 'globalOptions', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        item('Quick Connect…', 'quickConnect', mod('Q')),
        item('Connect…  (Session Manager)', 'connectDialog', mod('O')),
        item('Connect in Tab…', 'connectDialog', mod('T')),
        item('New Local Shell Tab', 'localShell', mod('L')),
        item('Connect SFTP Tab', 'sftpTab', mod('P')),
        item('SCP Transfer Manager', 'scpTab', mod('U')),
        { type: 'separator' },
        item('Clone Session', 'cloneTab', mod('D')),
        item('Reconnect', 'reconnect', mod('R')),
        item('Reconnect All', 'reconnectAll'),
        item('Disconnect', 'disconnect'),
        item('Disconnect All', 'disconnectAll'),
        { type: 'separator' },
        check('Log Session', 'toggleLog', 'logging'),
        item('Log Session As…', 'logAs'),
        { type: 'separator' },
        item('Close Tab', 'closeTab', isMac ? 'Cmd+W' : 'Ctrl+Shift+W'),
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Copy', 'copy', mod('C')),
        item('Paste', 'paste', mod('V')),
        item('Copy and Paste', 'copyPaste'),
        item('Paste as Single Line', 'pasteSingle'),
        item('Select All', 'selectAll', mod('A')),
        { type: 'separator' },
        item('Find…', 'find', mod('F')),
        { type: 'separator' },
        item('Clear Scrollback', 'clearScrollback', mod('K')),
        item('Clear Screen', 'clearScreen'),
        item('Clear Screen and Scrollback', 'clearAll'),
        item('Reset Terminal', 'resetTerminal'),
        { type: 'separator' },
        item('Send Break', 'sendBreak'),
      ],
    },
    {
      label: 'View',
      submenu: [
        // Cmd+M is macOS "Minimize window", so the Session Manager uses Cmd+Shift+M there.
        check('Session Manager', 'toggleSessionManager', 'showSessionManager', isMac ? 'Cmd+Shift+M' : 'Ctrl+Shift+M'),
        check('Maximize Terminal Area', 'focusMode', 'focusMode', isMac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter'),
        check('Button Bar', 'toggleButtonBar', 'showButtonBar'),
        check('Command Window', 'toggleCommandWindow', 'showCommandWindow', mod('E')),
        check('Status Bar', 'toggleStatusBar', 'showStatusBar'),
        { type: 'separator' },
        item('Increase Font Size', 'fontBigger', isMac ? 'Cmd+=' : 'Ctrl+='),
        item('Decrease Font Size', 'fontSmaller', isMac ? 'Cmd+-' : 'Ctrl+-'),
        item('Reset Font Size', 'fontReset', isMac ? 'Cmd+0' : 'Ctrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Options',
      submenu: [
        item('Session Options…', 'sessionOptions', mod('S')),
        item('Global Options…', 'globalOptions', isMac ? undefined : 'Ctrl+Shift+,'),
        { type: 'separator' },
        item('Edit Button Bar…', 'editButtons'),
        item('Keyword Highlighting…', 'editHighlights'),
        item('Keyboard Map…', 'editKeymap'),
        { type: 'separator' },
        check('Send Keystrokes to All Tabs', 'toggleBroadcast', 'broadcast', mod('B')),
      ],
    },
    {
      label: 'Transfer',
      submenu: [
        item('Connect SFTP Tab', 'sftpTab'),
        item('SCP Transfer Manager', 'scpTab'),
        item('Send ASCII File…', 'sendAscii'),
      ],
    },
    {
      label: 'Script',
      submenu: [
        item('Run…', 'runScript', isMac ? 'Cmd+Shift+J' : 'Ctrl+Shift+J'),
        item('Cancel Running Scripts', 'cancelScripts'),
        { type: 'separator' },
        item('Open Example Scripts Folder', 'openExamples'),
        ...(recent.length ? [{ type: 'separator' }, { label: 'Recent Scripts', enabled: false }, ...recent] : []),
      ],
    },
    {
      label: 'Tools',
      submenu: [
        item('Manage Known Hosts…', 'knownHosts'),
        item('Import ~/.ssh/config', 'importSshConfig'),
        item('Import Sessions…', 'importSessions'),
        item('Export Sessions…', 'exportSessions'),
        { type: 'separator' },
        item('Open Log Folder', 'openLogFolder'),
      ],
    },
    {
      label: 'Window',
      submenu: [
        layout('Tabs', 'tabs', '1'),
        layout('Stacked (one above another)', 'tile-h', '2'),
        layout('Side by Side', 'tile-v', '3'),
        layout('Grid', 'grid', '4'),
        { type: 'separator' },
        item('Next Tab', 'nextTab', isMac ? 'Cmd+Shift+]' : 'Ctrl+Tab'),
        item('Previous Tab', 'prevTab', isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }, { role: 'front' }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [item('About TermCraft', 'about'), { type: 'separator' }]),
        item('Keyboard Shortcuts', 'shortcuts'),
        { label: 'Scripting Reference', click: () => act('scriptHelp') },
        item('License (GPL-2.0-or-later)', 'license'),
        { label: 'Project README', click: () => shell.openPath(require('path').join(__dirname, '..', '..', 'README.md')) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
