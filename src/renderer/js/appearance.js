// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Settings → Appearance: one place for the theme (family + Light / Dark / Auto), terminal colors and
// typography, with a live preview of the window and a terminal.
import { h } from './dom.js';
import { icon } from './icons.js';
import { THEMES, FAMILIES, familyOf, variantLabel, appearanceOf, currentTheme } from './themes.js';
import { schemeSelect, getScheme } from './schemes.js';

const BUILT_IN_FONT = 'JetBrains Mono';
const FONT_STACK = (name) => `"${name}", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
const FONT_CANDIDATES = ['SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Fira Code', 'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Iosevka', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Roboto Mono'];
const LINE_HEIGHTS = [['1', 'Tight'], ['1.15', 'Normal'], ['1.3', 'Relaxed']];
const PADDINGS = [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']];
const CURSORS = [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']];

/** Installed monospace fonts (by comparing text widths against the generic fallbacks). */
function installedFonts() {
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (font) => { ctx.font = `20px ${font}`; return ctx.measureText('mmmmmlli1100WW@@').width; };
  const base = { mono: width('monospace'), serif: width('serif') };
  return FONT_CANDIDATES.filter((f) => width(`"${f}", monospace`) !== base.mono || width(`"${f}", serif`) !== base.serif);
}

/** First family name in a CSS font stack. */
const primaryFont = (stack) => (String(stack || '').match(/^\s*"?([^",]+)"?/) || [])[1] || BUILT_IN_FONT;

function segmented(options, value, onChange, label) {
  const el = h('div.segmented.ap-seg', { role: 'radiogroup', 'aria-label': label });
  const render = (v) => el.replaceChildren(...options.map(([val, text, ic]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(val === v), class: val === v ? 'on' : '',
    onclick: () => { render(val); onChange(val); },
  }, ic ? icon(ic, 15) : null, text)));
  render(value);
  return el;
}

/** A small, faithful picture of the window: sidebar, tabs and a terminal with real output. */
function preview(t, s) {
  const term = getScheme(s.defaultSession?.terminal?.colorScheme || '', t);
  const u = t.ui;
  const c = (color, text, bold) => h('span', { style: { color, fontWeight: bold ? '700' : '' } }, text);
  const prompt = () => [c(term.green, 'ops@web-01', true), c(term.foreground, ':'), c(term.blue, '~', true), c(term.foreground, '$ ')];
  const line = (...parts) => h('div', {}, ...parts);
  const pad = { compact: 4, comfortable: 12, spacious: 20 }[s.terminalPadding] ?? 12;
  const cursorStyle = s.defaultSession?.terminal?.cursorStyle || 'block';
  const cursor = h('span.ap-cursor', {
    class: `${cursorStyle}${s.defaultSession?.terminal?.cursorBlink === false ? '' : ' blink'}`,
    style: { '--cursor': term.cursor || term.foreground },
  });
  return h('div.ap-window', { style: { background: u.bg, borderColor: u.border, color: u.fg } },
    h('div.ap-titlebar', { style: { background: u.panel, borderColor: u.border } },
      h('i', { style: { background: '#ff5f57' } }), h('i', { style: { background: '#febc2e' } }), h('i', { style: { background: '#28c840' } }),
      h('span', { style: { color: u.dim } }, 'TermCraft')),
    h('div.ap-body', {},
      h('div.ap-side', { style: { background: u.panel, borderColor: u.border } },
        h('div.ap-side-head', { style: { color: u.dim } }, 'SESSIONS'),
        h('div.ap-row', {}, '▾ Production'),
        h('div.ap-row.sel', { style: { background: u.sel, boxShadow: `inset 3px 0 0 ${u.accent}` } }, 'web-01'),
        h('div.ap-row', {}, 'db-01'),
        h('div.ap-row', { style: { color: u.dim } }, 'core-sw-01')),
      h('div.ap-main', {},
        h('div.ap-tabs', { style: { background: u.panel, borderColor: u.border } },
          h('div.ap-tab.on', { style: { background: term.background, color: term.foreground, boxShadow: `inset 0 2px 0 ${u.accent}` } }, h('i', { style: { background: u.ok } }), 'web-01'),
          h('div.ap-tab', { style: { color: u.dim } }, h('i', { style: { background: u.ok } }), 'db-01')),
        h('div.ap-term', {
          style: {
            background: term.background, color: term.foreground, padding: `${Math.round(pad * 0.75)}px ${pad}px`,
            fontFamily: s.fontFamily, fontSize: `${Math.round((Number(s.fontSize) || 14) * 0.86)}px`, lineHeight: String(Number(s.lineHeight) || 1.15),
          },
        },
        line(...prompt(), 'git status -s'),
        line(c(term.yellow, ' M '), 'deploy.sh'),
        line(c(term.red, '?? '), 'notes.md'),
        line(...prompt(), 'ls'),
        line(c(term.blue, 'releases', true), '  nginx.conf  ', c(term.green, 'deploy.sh', true), '  ', c(term.cyan, 'logs')),
        line(c(term.green, '✓'), ' api healthy  ', c(term.yellow, '⚠'), ' disk 91%  ', c(term.red, '✗'), ' cron failed'),
        line(c(term.brightBlack, '# deployed 2 minutes ago by '), c(term.magenta, 'ops')),
        line(...prompt(), cursor)))));
}

/**
 * The Appearance panel. Edits `s` (a copy of the settings) in place and previews every change in the
 * whole app; Settings applies it on OK and reverts on Cancel.
 */
export function appearancePanel(app, s) {
  Object.assign(s, appearanceOf(s));
  s.defaultSession = s.defaultSession || {};
  s.defaultSession.terminal = s.defaultSession.terminal || {};
  s.terminalPadding = s.terminalPadding || 'comfortable';
  s.lineHeight = String(s.lineHeight || '1.15');
  const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const shown = () => currentTheme(s, prefersDark());
  const darkNow = () => shown().dark;
  const fonts = [BUILT_IN_FONT, ...installedFonts()];

  const previewHost = h('div.ap-preview');
  const note = h('p.ap-note', { role: 'status' });
  const grid = h('div.ap-families', { role: 'radiogroup', 'aria-label': 'Theme' });
  const variants = h('div.ap-variants');
  const update = () => {
    previewHost.replaceChildren(preview(shown(), s));
    renderFamilies();
    renderVariants();
    app.applyTheme({
      appearance: s.appearance, lightTheme: s.lightTheme, darkTheme: s.darkTheme,
      fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, terminalPadding: s.terminalPadding,
      defaultSession: { ...(app.settings.defaultSession || {}), terminal: { ...(app.settings.defaultSession?.terminal || {}), ...s.defaultSession.terminal } },
    });
  };

  const pickFamily = (f) => {
    note.textContent = '';
    if (f.light.length) s.lightTheme = f.light.includes(s.lightTheme) ? s.lightTheme : f.light[0];
    if (f.dark.length) s.darkTheme = f.dark.includes(s.darkTheme) ? s.darkTheme : (f.dark.find((n) => /Mocha$/.test(n)) || f.dark[0]);
    if (!f.light.length && s.appearance !== 'dark') {
      s.appearance = 'dark';
      modeSeg.replaceWith(modeSeg = modeControl());
      note.textContent = `${f.name} only comes in dark, so Appearance is now set to Dark.`;
    }
    if (!f.dark.length && s.appearance !== 'light') {
      s.appearance = 'light';
      modeSeg.replaceWith(modeSeg = modeControl());
      note.textContent = `${f.name} only comes in light, so Appearance is now set to Light.`;
    }
    update();
  };

  function renderFamilies() {
    const current = familyOf(shown().name);
    grid.replaceChildren(...FAMILIES.map((f) => {
      const halves = [f.light[0], f.dark.find((n) => /Mocha$/.test(n)) || f.dark[0]].filter(Boolean).map((n) => THEMES[n]);
      const on = f === current;
      return h('button.ap-family', {
        type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '', title: `${f.name}${!f.light.length ? ' (dark only)' : !f.dark.length ? ' (light only)' : ''}`,
        onclick: () => pickFamily(f),
      },
      h('span.ap-swatch', {}, halves.map((t) => h('span.ap-half', { style: { background: t.term.background } },
        h('span.ap-bar', { style: { background: t.ui.panel } }),
        h('span.ap-dots', {}, ['red', 'green', 'yellow', 'blue', 'magenta'].map((k) => h('i', { style: { background: t.term[k] } })))))),
      h('span.ap-family-name', {}, f.name, on ? icon('check', 14) : null),
      h('span.ap-family-sub', {}, !f.light.length ? 'Dark only' : !f.dark.length ? 'Light only' : `${f.light.length + f.dark.length} variants`));
    }));
  }

  function renderVariants() {
    const f = familyOf(shown().name);
    const rows = [];
    for (const [key, list, label] of [['lightTheme', f.light, 'Light'], ['darkTheme', f.dark, 'Dark']]) {
      if (list.length < 2) continue;
      rows.push(h('div.ap-variant-row', {}, h('span.ap-variant-label', {}, `${label} variant`),
        segmented(list.map((n) => [n, variantLabel(n)]), s[key], (v) => { s[key] = v; update(); }, `${label} variant`)));
    }
    variants.replaceChildren(...rows);
  }

  const modeControl = () => segmented([['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['auto', 'Auto', 'auto']], s.appearance,
    (v) => { s.appearance = v; note.textContent = v === 'auto' ? 'Auto follows your system: the light variant by day, the dark variant at night.' : ''; update(); }, 'Appearance');
  let modeSeg = modeControl();

  // Terminal colors: match the theme unless the user really wants a different palette.
  const colors = schemeSelect(h, s.defaultSession.terminal.colorScheme, 'Match theme (recommended)', {
    'aria-label': 'Terminal colors',
    onchange: (e) => { s.defaultSession.terminal.colorScheme = e.target.value; update(); },
  });

  const fontSel = h('select', { 'aria-label': 'Font', onchange: (e) => { s.fontFamily = FONT_STACK(e.target.value); update(); } },
    fonts.map((f) => h('option', { value: f }, f === BUILT_IN_FONT ? `${f} (built in)` : f)));
  fontSel.value = fonts.includes(primaryFont(s.fontFamily)) ? primaryFont(s.fontFamily) : BUILT_IN_FONT;
  const sizeOut = h('output.ap-size', {}, String(s.fontSize || 14));
  const step = (d) => { s.fontSize = Math.max(9, Math.min(28, (Number(s.fontSize) || 14) + d)); sizeOut.textContent = String(s.fontSize); update(); };
  const blink = h('input', { type: 'checkbox', checked: s.defaultSession.terminal.cursorBlink !== false, onchange: (e) => { s.defaultSession.terminal.cursorBlink = e.target.checked; update(); } });

  const row = (label, control, hint) => h('div.ap-field', {}, h('span.ap-label', {}, label), h('div.ap-control', {}, control, hint ? h('span.hint', {}, hint) : null));

  update();
  return h('div.ap', {},
    h('div.ap-top', {},
      previewHost,
      h('div.ap-mode', {}, h('span.ap-label', {}, 'Mode'), modeSeg, note)),
    h('h4', {}, 'Theme'),
    grid,
    variants,
    h('h4', {}, 'Terminal'),
    row('Colors', colors, 'Terminals use the theme’s own palette. Pick another only if you want terminal text to look different from the window.'),
    row('Font', h('div.row', {}, fontSel,
      h('div.ap-stepper', {}, h('button', { type: 'button', 'aria-label': 'Smaller', onclick: () => step(-1) }, '−'), sizeOut, h('button', { type: 'button', 'aria-label': 'Larger', onclick: () => step(1) }, '+')))),
    row('Line spacing', segmented(LINE_HEIGHTS, s.lineHeight, (v) => { s.lineHeight = v; update(); }, 'Line spacing')),
    row('Margins', segmented(PADDINGS, s.terminalPadding, (v) => { s.terminalPadding = v; update(); }, 'Margins')),
    row('Cursor', h('div.row', {}, segmented(CURSORS, s.defaultSession.terminal.cursorStyle || 'block', (v) => { s.defaultSession.terminal.cursorStyle = v; update(); }, 'Cursor'),
      h('label.check', {}, blink, 'Blink'))));
}
