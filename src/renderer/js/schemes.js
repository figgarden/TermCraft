// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Terminal color schemes (xterm.js ITheme).

const ansi = (list) => {
  const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  return Object.fromEntries(keys.map((k, i) => [k, list[i]]));
};

const XTERM = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];

import { THEMES } from './themes.js';

// Classic schemes that aren't full app themes.
const EXTRAS = {
  'Traditional': { background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#404040', ...ansi(XTERM) },
  'White / Black': { background: '#ffffff', foreground: '#000000', cursor: '#000000', selectionBackground: '#b5d5ff', ...ansi(XTERM) },
  'Monokai': {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e',
    ...ansi(['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  },
  'Green Phosphor': {
    background: '#0a1408', foreground: '#33ff66', cursor: '#33ff66', selectionBackground: '#1e4d26',
    ...ansi(['#0a1408', '#33ff66', '#33ff66', '#33ff66', '#33ff66', '#33ff66', '#33ff66', '#33ff66',
      '#1f9c3f', '#66ff8c', '#66ff8c', '#66ff8c', '#66ff8c', '#66ff8c', '#66ff8c', '#b3ffc6']),
  },
  'Amber': {
    background: '#140c00', foreground: '#ffb000', cursor: '#ffb000', selectionBackground: '#4d3500',
    ...ansi(['#140c00', '#ffb000', '#ffb000', '#ffb000', '#ffb000', '#ffb000', '#ffb000', '#ffb000',
      '#996a00', '#ffc84d', '#ffc84d', '#ffc84d', '#ffc84d', '#ffc84d', '#ffc84d', '#ffe0a3']),
  },
};

export const SCHEMES = {
  ...Object.fromEntries(Object.values(THEMES).map((t) => [t.name, t.term])),
  ...EXTRAS,
};

export const FOLLOW_THEME = '';
export const schemeNames = () => Object.keys(SCHEMES);
export const CLASSIC_SCHEMES = Object.keys(EXTRAS);
/** Options for color-scheme pickers: "Follow app theme" first. */
export const schemeOptions = () => [[FOLLOW_THEME, 'Match theme'], ...schemeNames().map((n) => [n, n])];
/** A scheme by name; empty or unknown names use the app theme's own terminal colors. */
export const getScheme = (name, appTheme) => SCHEMES[name] || appTheme?.term || SCHEMES['TermCraft Dark'];

/**
 * Terminal colors for a session: its own choice, else the default from Settings → Appearance,
 * else the current theme's terminal colors.
 */
export const schemeFor = (session, settings, appTheme) =>
  getScheme(session?.terminal?.colorScheme || settings?.defaultSession?.terminal?.colorScheme || '', appTheme);

/** A <select> of terminal color choices, grouped. `first` is the label of the '' option. */
export function schemeSelect(h, value, first, attrs = {}) {
  const themed = schemeNames().filter((n) => !CLASSIC_SCHEMES.includes(n));
  const sel = h('select', attrs,
    h('option', { value: '' }, first),
    h('optgroup', { label: 'Theme palettes' }, themed.map((n) => h('option', { value: n }, n))),
    h('optgroup', { label: 'Classic' }, CLASSIC_SCHEMES.map((n) => h('option', { value: n }, n))));
  sel.value = value || '';
  return sel;
}
