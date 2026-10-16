// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Button bars: multiple named bars, each a row of configurable buttons.
import { h, showDialog, contextMenu, confirmDialog, promptDialog, toast, field } from './dom.js';

/** What a button can do. */
export const FUNCTIONS = [
  ['send', 'Send String'],
  ['sendAll', 'Send String to All Tabs'],
  ['script', 'Run Script'],
  ['connect', 'Connect Session'],
  ['menu', 'Menu Function'],
  ['run', 'Launch Application'],
];
const FUNCTION_LABEL = Object.fromEntries(FUNCTIONS);

/** Menu functions a button can trigger: [action, label]. */
export const MENU_FUNCTIONS = [
  ['reconnect', 'Reconnect'], ['reconnectAll', 'Reconnect All'], ['disconnect', 'Disconnect'], ['disconnectAll', 'Disconnect All'],
  ['cloneTab', 'Clone Session'], ['localShell', 'New Local Shell'], ['sftpTab', 'Connect SFTP Tab'], ['scpTab', 'SCP Transfer Manager'], ['quickConnect', 'Quick Connect'],
  ['toggleLog', 'Start/Stop Logging'], ['logAs', 'Log Session As…'],
  ['copy', 'Copy'], ['paste', 'Paste'], ['pasteSingle', 'Paste as Single Line'], ['selectAll', 'Select All'], ['find', 'Find'],
  ['clearScrollback', 'Clear Scrollback'], ['clearScreen', 'Clear Screen'], ['resetTerminal', 'Reset Terminal'], ['sendBreak', 'Send Break'],
  ['sendAscii', 'Send ASCII File…'], ['runScript', 'Run Script…'], ['toggleBroadcast', 'Send Keystrokes to All Tabs'],
  ['toggleSessionManager', 'Show/Hide Session Manager'], ['toggleCommandWindow', 'Show/Hide Command Window'], ['focusMode', 'Maximize Terminal Area'],
  ['layout:tabs', 'Layout: Tabs'], ['layout:tile-h', 'Layout: Stacked'], ['layout:tile-v', 'Layout: Side by Side'], ['layout:grid', 'Layout: Grid'],
  ['nextTab', 'Next Tab'], ['prevTab', 'Previous Tab'], ['sessionOptions', 'Session Options…'], ['globalOptions', 'Settings…'],
];
const MENU_LABEL = Object.fromEntries(MENU_FUNCTIONS);

export const COLORS = [['', 'Default'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['gray', 'Gray']];

const newId = () => 'bb_' + Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));

function expandEscapes(str) {
  return (str || '').replace(/\\(x[0-9a-fA-F]{2}|[rntebav\\0])/g, (m, c) => {
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { r: '\r', n: '\n', t: '\t', e: '\x1b', b: '\b', a: '\x07', v: '\v', '\\': '\\', 0: '\0' }[c];
  });
}

/**
 * Turn a Send String value into chunks to send, asking for any ${prompt:Label} values first.
 * "\p" pauses one second between chunks. Returns null if cancelled.
 */
export async function prepareSendString(value, ask = promptDialog) {
  let text = value || '';
  const prompts = [...new Set([...text.matchAll(/\$\{prompt:([^}]*)\}/g)].map((m) => m[1]))];
  for (const label of prompts) {
    const answer = await ask('Button Input', `${label || 'Value'}:`);
    if (answer == null) return null;
    text = text.split(`\${prompt:${label}}`).join(answer);
  }
  return text.split('\\p').map(expandEscapes);
}

export function describeButton(b) {
  const what = b.action === 'menu' ? MENU_LABEL[b.value] || b.value : b.value;
  return `${FUNCTION_LABEL[b.action] || b.action}: ${what}${b.tooltip ? `\n${b.tooltip}` : ''}`;
}

export class ButtonBars {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.sessionOverride = null; // bar chosen by the active tab's session (not persisted)
    this.dragIndex = null;
    el.addEventListener('contextmenu', (e) => {
      if (e.target === el || e.target.classList.contains('bb-buttons')) { e.preventDefault(); this.barMenu(e.clientX, e.clientY); }
    });
  }

  get bars() { return this.app.settings.buttonBars || []; }

  get current() {
    const id = this.sessionOverride || this.app.settings.activeButtonBar;
    return this.bars.find((b) => b.id === id) || this.bars[0] || null;
  }

  async save(bars, activeId = this.current?.id) {
    await this.app.saveSettings({ buttonBars: bars, activeButtonBar: activeId });
  }

  // ---- rendering ----------------------------------------------------------
  render() {
    const bar = this.current;
    const select = h('select.bb-select', {
      'aria-label': 'Button bar', title: 'Switch button bar',
      onchange: (e) => this.select(e.target.value),
    }, this.bars.map((b) => h('option', { value: b.id }, b.name)));
    if (bar) select.value = bar.id;

    const buttons = (bar?.buttons || []).map((b, i) => h('button.bb', {
      class: b.color ? `bb-${b.color}` : '',
      title: describeButton(b),
      draggable: true,
      onclick: () => this.run(b),
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.buttonMenu(e.clientX, e.clientY, i); },
      ondragstart: (e) => { this.dragIndex = i; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { if (this.dragIndex != null) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); this.move(this.dragIndex, i); this.dragIndex = null; },
      ondragend: () => { this.dragIndex = null; },
    }, b.label));

    this.el.replaceChildren(
      select,
      h('button.icon-btn.bb-manage', { title: 'Button bar options', 'aria-label': 'Button bar options', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); this.barMenu(r.left, r.top - 4, true); } }, '⋯'),
      h('div.bb-buttons', {},
        buttons.length ? buttons : h('span.bb-empty', {}, 'No buttons yet — click ＋ or right-click here to add one.'),
        h('button.bb.bb-add', { title: 'New button', 'aria-label': 'New button', onclick: () => this.editButton(null) }, '＋')));
  }

  /** Switch bars. Choosing one manually also makes it the default going forward. */
  select(id) {
    this.sessionOverride = null;
    this.app.saveSettings({ activeButtonBar: id }, true).then(() => this.render());
    this.app.active?.focus();
  }

  /** When a tab becomes active, show the bar its session asks for (per-session button bar). */
  onTabActivated(tab) {
    const want = tab?.cfg?.terminal?.buttonBar;
    const next = want && this.bars.some((b) => b.id === want) ? want : null;
    if (next !== this.sessionOverride) { this.sessionOverride = next; this.render(); }
  }

  // ---- running buttons -------------------------------------------------------
  async run(b, tab = this.app.active) {
    const app = this.app;
    const terms = () => app.tabs.filter((t) => t.kind === 'terminal');
    try {
      switch (b.action) {
        case 'send':
        case 'sendAll': {
          const targets = b.action === 'sendAll' ? terms() : tab?.kind === 'terminal' ? [tab] : [];
          if (!targets.length) return toast('Open a session first', 'warn');
          const chunks = await prepareSendString(b.value);
          if (!chunks) return;
          for (let i = 0; i < chunks.length; i++) {
            if (i) await new Promise((r) => setTimeout(r, 1000));
            for (const t of targets) t.send(chunks[i]);
          }
          break;
        }
        case 'script': await app.runScript(b.value || undefined); break;
        case 'connect': await app.connectTarget(b.value); break;
        case 'menu': await app.dispatch(b.value); break;
        case 'run': if (await window.api.app.run(b.value)) toast(`Launched: ${b.value}`); break;
        default: toast(`Unknown button function "${b.action}"`, 'error');
      }
    } catch (e) {
      toast(`${b.label || 'Button'}: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    } finally {
      if (b.action !== 'connect') tab?.focus();
    }
  }

  // ---- editing buttons ----------------------------------------------------
  async editButton(index, barId = this.current?.id) {
    const bars = clone(this.bars);
    let bar = bars.find((b) => b.id === barId);
    if (!bar) {
      bar = { id: newId(), name: 'Default', buttons: [] };
      bars.push(bar);
    }
    const isNew = index == null;
    const btn = isNew ? { label: '', action: 'send', value: '', tooltip: '', color: '' } : { ...bar.buttons[index] };
    const result = await mapButtonDialog(this.app, btn, isNew, bars, bar.id);
    if (!result) return;
    const target = bars.find((b) => b.id === result.barId);
    const { barId: _ignored, ...button } = result;
    if (!isNew && target.id === bar.id) bar.buttons[index] = button;
    else {
      if (!isNew) bar.buttons.splice(index, 1);
      target.buttons.push(button);
    }
    await this.save(bars, this.sessionOverride ? this.app.settings.activeButtonBar : target.id);
  }

  async move(from, to) {
    if (from == null || from === to) return this.render();
    const bars = clone(this.bars);
    const bar = bars.find((b) => b.id === this.current.id);
    const [b] = bar.buttons.splice(from, 1);
    bar.buttons.splice(to, 0, b);
    await this.save(bars);
  }

  buttonMenu(x, y, index) {
    const bar = this.current;
    const b = bar.buttons[index];
    const others = this.bars.filter((x) => x.id !== bar.id);
    contextMenu(x, y, [
      { label: `Run “${b.label}”`, action: () => this.run(b) },
      '-',
      { label: 'Edit Button…', action: () => this.editButton(index) },
      { label: 'New Button…', action: () => this.editButton(null) },
      { label: 'Duplicate Button', action: async () => { const bars = clone(this.bars); const cur = bars.find((x) => x.id === bar.id); cur.buttons.splice(index + 1, 0, { ...b, label: b.label + ' copy' }); await this.save(bars); } },
      { label: 'Move Left', disabled: index === 0, action: () => this.move(index, index - 1) },
      { label: 'Move Right', disabled: index === bar.buttons.length - 1, action: () => this.move(index, index + 1) },
      ...others.map((o) => ({ label: `Copy to “${o.name}”`, action: async () => { const bars = clone(this.bars); bars.find((x) => x.id === o.id).buttons.push({ ...b }); await this.save(bars); toast(`Copied to ${o.name}`); } })),
      '-',
      { label: 'Delete Button', action: async () => {
        if (!await confirmDialog('Delete Button', `Delete the “${b.label}” button?`, 'Delete', true)) return;
        const bars = clone(this.bars); bars.find((x) => x.id === bar.id).buttons.splice(index, 1); await this.save(bars);
      } },
    ]);
  }

  // ---- managing bars --------------------------------------------------------
  barMenu(x, y, above = false) {
    const bar = this.current;
    const tab = this.app.active;
    const sessionId = tab?.kind === 'terminal' ? tab.session.id : null;
    const items = [
      { label: 'New Button…', action: () => this.editButton(null) },
      '-',
      { label: 'New Button Bar…', action: () => this.newBar() },
      { label: `Rename “${bar?.name}”…`, disabled: !bar, action: () => this.renameBar() },
      { label: `Duplicate “${bar?.name}”`, disabled: !bar, action: () => this.duplicateBar() },
      { label: `Delete “${bar?.name}”…`, disabled: this.bars.length <= 1, action: () => this.deleteBar() },
      '-',
      { label: sessionId ? `Always Show This Bar for “${tab.session.name}”` : 'Always Show This Bar for Session (save the session first)', disabled: !sessionId || !bar, action: () => this.assignToSession(sessionId, bar.id) },
      sessionId && tab.cfg.terminal.buttonBar ? { label: `Stop Choosing a Bar for “${tab.session.name}”`, action: () => this.assignToSession(sessionId, '') } : null,
      '-',
      { label: 'Import Button Bar…', action: () => this.importBars() },
      { label: `Export “${bar?.name}”…`, disabled: !bar, action: () => this.exportBars([bar]) },
      { label: 'Export All Button Bars…', action: () => this.exportBars(this.bars) },
      '-',
      { label: 'Edit All Button Bars…', action: () => this.app.dispatch('editButtons') },
      { label: 'Hide Button Bar', action: () => this.app.dispatch('toggleButtonBar') },
    ];
    contextMenu(x, y, items);
    if (above) {
      // Open upward from the ⋯ button, since the bar sits at the bottom of the window.
      const menu = document.querySelector('.context-menu');
      if (menu) menu.style.top = Math.max(4, y - menu.offsetHeight) + 'px';
    }
  }

  uniqueName(name) {
    const names = new Set(this.bars.map((b) => b.name));
    if (!names.has(name)) return name;
    let n = 2;
    while (names.has(`${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

  async newBar() {
    const name = await promptDialog('New Button Bar', 'Button bar name:', this.uniqueName('New Bar'));
    if (!name) return;
    const bar = { id: newId(), name: this.uniqueName(name), buttons: [] };
    this.sessionOverride = null;
    await this.save([...clone(this.bars), bar], bar.id);
    toast(`Created “${bar.name}”. Click ＋ to add buttons.`);
  }

  async renameBar() {
    const bar = this.current;
    const name = await promptDialog('Rename Button Bar', 'Button bar name:', bar.name);
    if (!name || name === bar.name) return;
    const bars = clone(this.bars);
    bars.find((b) => b.id === bar.id).name = name;
    await this.save(bars);
  }

  async duplicateBar() {
    const bar = clone(this.current);
    const copy = { ...bar, id: newId(), name: this.uniqueName(`${bar.name} copy`) };
    this.sessionOverride = null;
    await this.save([...clone(this.bars), copy], copy.id);
  }

  async deleteBar() {
    const bar = this.current;
    if (!await confirmDialog('Delete Button Bar', `Delete “${bar.name}” and its ${bar.buttons.length} button(s)?`, 'Delete', true)) return;
    const bars = clone(this.bars).filter((b) => b.id !== bar.id);
    this.sessionOverride = null;
    await this.save(bars, bars[0]?.id);
  }

  async assignToSession(sessionId, barId) {
    const s = this.app.tree.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const copy = clone(s);
    copy.terminal = { ...(copy.terminal || {}), buttonBar: barId };
    delete copy.auth?.hasPassword;
    delete copy.auth?.hasPassphrase;
    await window.api.store.saveSession(copy);
    await this.app.reloadTree();
    this.app.refreshTabsForSession(sessionId);
    this.onTabActivated(this.app.active);
    toast(barId ? `“${s.name}” will always show “${this.bars.find((b) => b.id === barId)?.name}”` : `“${s.name}” no longer picks a button bar`);
  }

  async exportBars(bars) {
    const name = bars.length === 1 ? `${bars[0].name.replace(/[^\w.-]+/g, '-')}.buttonbar.json` : 'termcraft-button-bars.json';
    const file = await window.api.file.saveText(name, JSON.stringify({ format: 'termcraft-buttonbars', version: 1, bars }, null, 2));
    if (file) toast(`Exported to ${file}`);
  }

  async importBars() {
    const file = await window.api.dialog.openFile({ title: 'Import Button Bar', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!file) return;
    let data;
    try { data = JSON.parse(await window.api.file.readText(file)); } catch (e) { return toast(`Not a valid button bar file: ${e.message}`, 'error'); }
    const incoming = Array.isArray(data) ? data : data.bars || (data.buttons ? [data] : []);
    const valid = incoming.filter((b) => b && Array.isArray(b.buttons));
    if (!valid.length) return toast('No button bars found in that file', 'error');
    // A shared button bar can carry buttons that run programs or scripts on this computer.
    // Show exactly what they would run before importing.
    const risky = valid.flatMap((b) => b.buttons.filter((x) => x && (x.action === 'run' || x.action === 'script'))
      .map((x) => `${x.label}: ${x.action === 'run' ? 'runs' : 'runs script'} ${x.value || '(chosen when clicked)'}`));
    if (risky.length) {
      const ok = await showDialog({
        title: 'Imported Buttons Run Programs', width: 620,
        body: h('div.form', {},
          h('p', {}, 'These buttons run programs or scripts on this computer when clicked. Only import them if you trust where this file came from:'),
          h('pre.code', {}, risky.join('\n'))),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Import Anyway', value: true, danger: true }],
      });
      if (!ok) return;
    }
    const bars = clone(this.bars);
    for (const b of valid) {
      bars.push({
        id: newId(),
        name: this.uniqueName(b.name || 'Imported'),
        buttons: b.buttons.filter((x) => x && x.label).map((x) => ({ label: String(x.label), action: x.action || 'send', value: x.value ?? '', tooltip: x.tooltip || '', color: x.color || '' })),
      });
    }
    this.sessionOverride = null;
    await this.save(bars, bars[bars.length - 1].id);
    toast(`Imported ${valid.length} button bar(s)`);
  }
}

/** The button editor dialog. Resolves the edited button (+ barId) or null. */
async function mapButtonDialog(app, btn, isNew, bars, barId) {
  const label = h('input', { type: 'text', value: btn.label, placeholder: 'Button label', autofocus: true, 'aria-label': 'Label' });
  const fn = h('select', { 'aria-label': 'Function' }, FUNCTIONS.map(([v, l]) => h('option', { value: v }, l)));
  fn.value = btn.action || 'send';
  const barSel = h('select', { 'aria-label': 'Button bar' }, bars.map((b) => h('option', { value: b.id }, b.name)));
  barSel.value = barId;
  const tooltip = h('input', { type: 'text', value: btn.tooltip || '', placeholder: 'Shown when you hover the button', 'aria-label': 'Tooltip' });
  const color = h('select', { 'aria-label': 'Color' }, COLORS.map(([v, l]) => h('option', { value: v }, l)));
  color.value = btn.color || '';
  const preview = h('button.bb', { type: 'button', tabindex: -1 });
  const syncPreview = () => { preview.className = `bb ${color.value ? 'bb-' + color.value : ''}`; preview.textContent = label.value || 'Button'; };
  label.addEventListener('input', syncPreview);
  color.addEventListener('change', syncPreview);
  syncPreview();

  // Function-specific value editors.
  const sendText = h('textarea', { rows: 3, 'aria-label': 'String to send', placeholder: 'show interfaces\\r' });
  const scriptPath = h('input', { type: 'text', placeholder: 'Script file (.js) — leave empty to choose when clicked', 'aria-label': 'Script file' });
  const sessionNames = h('datalist', { id: 'bb-sessions' }, app.tree.sessions.map((s) => h('option', { value: s.name })));
  const connectTarget = h('input', { type: 'text', list: 'bb-sessions', placeholder: 'Saved session name, or user@host:port', 'aria-label': 'Session' });
  const menuFn = h('select', { 'aria-label': 'Menu function' }, MENU_FUNCTIONS.map(([v, l]) => h('option', { value: v }, l)));
  const runCmd = h('input', { type: 'text', placeholder: app.platform === 'darwin' ? 'open -a "Visual Studio Code"' : app.platform === 'win32' ? 'notepad.exe' : 'gedit', 'aria-label': 'Command' });
  const editors = {
    send: field('String to send', sendText, 'Escapes: \\r Enter, \\n newline, \\t tab, \\e Esc, \\x03 Ctrl-C, \\p pause 1 s. Use ${prompt:Label} to ask for a value when clicked.'),
    script: field('Script', h('div.row', {}, scriptPath, h('button.small', { type: 'button', onclick: async () => { const f = await window.api.dialog.openFile({ title: 'Choose script', filters: [{ name: 'JavaScript', extensions: ['js'] }] }); if (f) scriptPath.value = f; } }, 'Browse…'))),
    connect: field('Session', h('div', {}, connectTarget, sessionNames), 'Opens the session in a new tab'),
    menu: field('Menu function', menuFn),
    run: field('Command', runCmd, 'A program and its arguments, run on this computer without a shell (no pipes or ;). Quote arguments with spaces. You approve each new command the first time it runs.'),
  };
  editors.sendAll = editors.send;
  const set = { send: sendText, sendAll: sendText, script: scriptPath, connect: connectTarget, menu: menuFn, run: runCmd };
  if (btn.action && set[btn.action]) set[btn.action].value = btn.value ?? '';
  else sendText.value = btn.value ?? '';
  if (btn.action === 'menu' && !btn.value) menuFn.value = 'reconnect';

  const valueSlot = h('div');
  const showEditor = () => {
    valueSlot.replaceChildren(editors[fn.value]);
    // Suggest a label from the string being sent when none is set yet.
    if (!label.value && fn.value === 'menu') { label.value = MENU_LABEL[menuFn.value]; syncPreview(); }
  };
  fn.addEventListener('change', showEditor);
  menuFn.addEventListener('change', () => { if (!label.value || MENU_FUNCTIONS.some(([, l]) => l === label.value)) { label.value = MENU_LABEL[menuFn.value]; syncPreview(); } });
  showEditor();

  const body = h('div.form', {},
    h('div.row', {}, field('Label', label), field('Button bar', barSel)),
    field('Function', fn),
    valueSlot,
    h('div.row', {}, field('Tooltip', tooltip), field('Color', color), h('div.field.bb-preview', {}, h('span.label', {}, 'Preview'), preview)));

  const ok = await showDialog({
    title: isNew ? 'New Button' : `Edit Button — ${btn.label}`,
    body, width: 600,
    buttons: [{ label: 'Cancel', value: false }, {
      label: isNew ? 'Add Button' : 'OK', value: true, primary: true,
      validate: () => {
        if (!label.value.trim()) return 'Give the button a label';
        if (['send', 'sendAll', 'connect', 'run'].includes(fn.value) && !set[fn.value].value.trim()) return 'Fill in what the button should do';
        return null;
      },
    }],
  });
  if (!ok) return null;
  return {
    label: label.value.trim(),
    action: fn.value,
    value: set[fn.value].value,
    tooltip: tooltip.value.trim(),
    color: color.value,
    barId: barSel.value,
  };
}
