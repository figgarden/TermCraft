// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const HEX = /^#[0-9a-f]{6}$/i;

// WCAG relative luminance / contrast ratio.
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('themes: complete, valid and readable', async () => {
  const { THEMES, THEME_NAMES, ANSI_KEYS, resolveTheme, cssVars } = await import('../src/renderer/js/themes.js');
  assert.ok(THEME_NAMES.length >= 20);
  assert.strictEqual(new Set(THEME_NAMES).size, THEME_NAMES.length, 'unique names');
  for (const name of ['Catppuccin Mocha', 'Catppuccin Latte', 'Nord', 'Solarized Dark', 'Solarized Light', 'Dracula', 'Gruvbox Dark', 'Tokyo Night', 'One Dark', 'Rosé Pine', 'Everforest Dark', 'Kanagawa', 'GitHub Dark']) {
    assert.ok(THEMES[name], name);
  }
  for (const t of Object.values(THEMES)) {
    for (const [k, v] of Object.entries(t.ui)) assert.match(v, HEX, `${t.name} ui.${k}`);
    for (const k of ['background', 'foreground', 'cursor', 'selectionBackground', ...ANSI_KEYS]) assert.match(t.term[k] || '', HEX, `${t.name} term.${k}`);
    assert.ok(contrast(t.ui.fg, t.ui.panel) >= 4.5, `${t.name}: UI text contrast ${contrast(t.ui.fg, t.ui.panel).toFixed(2)}`);
    assert.ok(contrast(t.term.foreground, t.term.background) >= 4.5, `${t.name}: terminal text contrast ${contrast(t.term.foreground, t.term.background).toFixed(2)}`);
    assert.strictEqual(t.dark, lum(t.ui.panel) < 0.2, `${t.name}: dark flag matches its background`);
    assert.ok(Object.values(cssVars(t)).every((v) => HEX.test(v)));
  }
  assert.strictEqual(resolveTheme('dark', false).name, 'TermCraft Dark');
  assert.strictEqual(resolveTheme('light', true).name, 'TermCraft Light');
  assert.strictEqual(resolveTheme('system', true).name, 'TermCraft Dark');
  assert.strictEqual(resolveTheme('system', false).name, 'TermCraft Light');
  assert.strictEqual(resolveTheme('Nord', false).name, 'Nord');
});

test('themes: terminal schemes follow the app theme unless a session picks one', async () => {
  const { getScheme, schemeOptions, SCHEMES } = await import('../src/renderer/js/schemes.js');
  const { THEMES } = await import('../src/renderer/js/themes.js');
  assert.deepStrictEqual(schemeOptions()[0], ['', 'Follow app theme']);
  assert.strictEqual(getScheme('', THEMES.Nord), THEMES.Nord.term);
  assert.strictEqual(getScheme('Monokai', THEMES.Nord), SCHEMES.Monokai);
  assert.strictEqual(getScheme('No Such Scheme', THEMES.Dracula), THEMES.Dracula.term);
});

test('themes: old settings and sessions migrate to the new model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-theme-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light', defaultSession: { terminal: { colorScheme: 'TermCraft Dark' } } }));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ folders: [], sessions: [
    { id: 'a', name: 'a', terminal: { colorScheme: 'TermCraft Dark' } },
    { id: 'b', name: 'b', terminal: { colorScheme: 'Monokai' } },
  ] }));
  const store = new Store(dir, null);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(store.getSettings().theme, 'TermCraft Light');
  assert.strictEqual(store.getSettings().defaultSession.terminal.colorScheme, '');
  assert.strictEqual(store.getSession('a').terminal.colorScheme, '', 'old default now follows the theme');
  assert.strictEqual(store.getSession('b').terminal.colorScheme, 'Monokai', 'explicit choices are kept');
});
