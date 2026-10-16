// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// App themes: each one colors the whole UI and, by default, every terminal.
// Palettes come from popular open-source themes; see THIRD-PARTY-NOTICES.md for credits.

const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/**
 * Build a theme.
 * ui:   bg (window), panel (sidebar/toolbar), raised (buttons), hover, border, fg, dim, accent,
 *       accentFg, ok, warn, err, sel
 * term: background, foreground, cursor, selection and the 16 ANSI colors
 */
function theme(name, family, dark, ui, term, ansi) {
  return {
    name,
    family,
    dark,
    ui,
    term: {
      background: term.bg, foreground: term.fg, cursor: term.cursor || term.fg, cursorAccent: term.bg,
      selectionBackground: term.sel,
      ...Object.fromEntries(ANSI_KEYS.map((k, i) => [k, ansi[i]])),
    },
  };
}

// Catppuccin (MIT) — one helper for its four flavors.
function catppuccin(name, dark, p) {
  return theme(name, 'Catppuccin', dark,
    { bg: p.mantle, panel: p.base, raised: p.surface0, hover: p.surface1, border: p.surface0, fg: p.text, dim: p.subtext0,
      accent: p.mauve, accentFg: p.crust, ok: p.green, warn: p.yellow, err: p.red, sel: p.surface1 },
    { bg: p.base, fg: p.text, cursor: p.rosewater, sel: p.surface2 },
    dark
      ? [p.surface1, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.subtext1, p.surface2, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.subtext0]
      : [p.subtext1, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.surface2, p.subtext0, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, p.surface1]);
}

const CTP = {
  latte: { base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', text: '#4c4f69', subtext0: '#6c6f85', subtext1: '#5c5f77', surface0: '#ccd0da', surface1: '#bcc0cc', surface2: '#acb0be', rosewater: '#dc8a78', mauve: '#8839ef', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', pink: '#ea76cb', teal: '#179299' },
  frappe: { base: '#303446', mantle: '#292c3c', crust: '#232634', text: '#c6d0f5', subtext0: '#a5adce', subtext1: '#b5bfe2', surface0: '#414559', surface1: '#51576d', surface2: '#626880', rosewater: '#f2d5cf', mauve: '#ca9ee6', red: '#e78284', green: '#a6d189', yellow: '#e5c890', blue: '#8caaee', pink: '#f4b8e4', teal: '#81c8be' },
  macchiato: { base: '#24273a', mantle: '#1e2030', crust: '#181926', text: '#cad3f5', subtext0: '#a5adcb', subtext1: '#b8c0e0', surface0: '#363a4f', surface1: '#494d64', surface2: '#5b6078', rosewater: '#f4dbd6', mauve: '#c6a0f6', red: '#ed8796', green: '#a6da95', yellow: '#eed49f', blue: '#8aadf4', pink: '#f5bde6', teal: '#8bd5ca' },
  mocha: { base: '#1e1e2e', mantle: '#181825', crust: '#11111b', text: '#cdd6f4', subtext0: '#a6adc8', subtext1: '#bac2de', surface0: '#313244', surface1: '#45475a', surface2: '#585b70', rosewater: '#f5e0dc', mauve: '#cba6f7', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', pink: '#f5c2e7', teal: '#94e2d5' },
};

const LIST = [
  // TermCraft's own.
  theme('TermCraft Dark', 'TermCraft', true,
    { bg: '#20232a', panel: '#282c34', raised: '#2f343e', hover: '#3a404c', border: '#3b414d', fg: '#d7dae0', dim: '#8b929e', accent: '#4f8ff7', accentFg: '#ffffff', ok: '#4cc77f', warn: '#e5b04a', err: '#f0686f', sel: '#2f4a74' },
    { bg: '#1b1d23', fg: '#d7dae0', cursor: '#7fd1ff', sel: '#3a4a63' },
    ['#1b1d23', '#ef6b73', '#8bd49c', '#ebcb8b', '#5ec4ff', '#c792ea', '#70e1e8', '#d7dae0', '#5c6370', '#ff8087', '#a3e7b2', '#f8dc9f', '#8bd5ff', '#ddaaf5', '#9ef0f5', '#ffffff']),
  theme('TermCraft Light', 'TermCraft', false,
    { bg: '#f3f4f6', panel: '#ffffff', raised: '#e7e9ee', hover: '#dde1e8', border: '#cfd4dc', fg: '#1d2330', dim: '#5d6574', accent: '#2463d1', accentFg: '#ffffff', ok: '#1f9d55', warn: '#b7791f', err: '#c53030', sel: '#d6e4ff' },
    { bg: '#fbfbfc', fg: '#1d2330', cursor: '#2463d1', sel: '#cfe0ff' },
    ['#1d2330', '#c53030', '#1f8a4c', '#a86a0c', '#2463d1', '#8a3fbf', '#0f7f86', '#9aa1ad', '#5d6574', '#e04848', '#22a35a', '#c98a1c', '#3d7be0', '#a456d6', '#14979f', '#c9ced6']),

  catppuccin('Catppuccin Latte', false, CTP.latte),
  catppuccin('Catppuccin Frappé', true, CTP.frappe),
  catppuccin('Catppuccin Macchiato', true, CTP.macchiato),
  catppuccin('Catppuccin Mocha', true, CTP.mocha),

  // Nord (MIT)
  theme('Nord', 'Nord', true,
    { bg: '#2b303b', panel: '#2e3440', raised: '#3b4252', hover: '#434c5e', border: '#3b4252', fg: '#d8dee9', dim: '#a3abb9', accent: '#88c0d0', accentFg: '#2e3440', ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a', sel: '#434c5e' },
    { bg: '#2e3440', fg: '#d8dee9', cursor: '#d8dee9', sel: '#434c5e' },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),

  // Solarized (MIT)
  theme('Solarized Dark', 'Solarized', true,
    { bg: '#00212b', panel: '#002b36', raised: '#073642', hover: '#0b4251', border: '#073642', fg: '#93a1a1', dim: '#657b83', accent: '#268bd2', accentFg: '#fdf6e3', ok: '#859900', warn: '#b58900', err: '#dc322f', sel: '#073642' },
    { bg: '#002b36', fg: '#839496', cursor: '#93a1a1', sel: '#073642' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  theme('Solarized Light', 'Solarized', false,
    { bg: '#eee8d5', panel: '#fdf6e3', raised: '#eee8d5', hover: '#e4ddc8', border: '#ddd6c1', fg: '#586e75', dim: '#839496', accent: '#268bd2', accentFg: '#fdf6e3', ok: '#859900', warn: '#b58900', err: '#dc322f', sel: '#eee8d5' },
    // Text uses base01 (Solarized's emphasized-content tone): base00 is only 4.1:1 on base3.
    { bg: '#fdf6e3', fg: '#586e75', cursor: '#586e75', sel: '#eee8d5' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),

  // Dracula (MIT)
  theme('Dracula', 'Dracula', true,
    { bg: '#21222c', panel: '#282a36', raised: '#343746', hover: '#44475a', border: '#3a3c4e', fg: '#f8f8f2', dim: '#a5a9c6', accent: '#bd93f9', accentFg: '#282a36', ok: '#50fa7b', warn: '#f1fa8c', err: '#ff5555', sel: '#44475a' },
    { bg: '#282a36', fg: '#f8f8f2', cursor: '#f8f8f2', sel: '#44475a' },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),

  // Gruvbox (MIT)
  theme('Gruvbox Dark', 'Gruvbox', true,
    { bg: '#1d2021', panel: '#282828', raised: '#3c3836', hover: '#504945', border: '#3c3836', fg: '#ebdbb2', dim: '#a89984', accent: '#fabd2f', accentFg: '#282828', ok: '#b8bb26', warn: '#fe8019', err: '#fb4934', sel: '#504945' },
    { bg: '#282828', fg: '#ebdbb2', cursor: '#ebdbb2', sel: '#504945' },
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  theme('Gruvbox Light', 'Gruvbox', false,
    { bg: '#f2e5bc', panel: '#fbf1c7', raised: '#ebdbb2', hover: '#d5c4a1', border: '#d5c4a1', fg: '#3c3836', dim: '#7c6f64', accent: '#076678', accentFg: '#fbf1c7', ok: '#79740e', warn: '#af3a03', err: '#9d0006', sel: '#ebdbb2' },
    { bg: '#fbf1c7', fg: '#3c3836', cursor: '#3c3836', sel: '#ebdbb2' },
    ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836']),

  // Tokyo Night (Apache-2.0 palette)
  theme('Tokyo Night', 'Tokyo Night', true,
    { bg: '#16161e', panel: '#1a1b26', raised: '#292e42', hover: '#33384f', border: '#292e42', fg: '#c0caf5', dim: '#7a82a9', accent: '#7aa2f7', accentFg: '#1a1b26', ok: '#9ece6a', warn: '#e0af68', err: '#f7768e', sel: '#283457' },
    { bg: '#1a1b26', fg: '#c0caf5', cursor: '#c0caf5', sel: '#283457' },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  theme('Tokyo Night Storm', 'Tokyo Night', true,
    { bg: '#1f2335', panel: '#24283b', raised: '#292e42', hover: '#343a55', border: '#2f344d', fg: '#c0caf5', dim: '#7a82a9', accent: '#7aa2f7', accentFg: '#24283b', ok: '#9ece6a', warn: '#e0af68', err: '#f7768e', sel: '#2e3c64' },
    { bg: '#24283b', fg: '#c0caf5', cursor: '#c0caf5', sel: '#2e3c64' },
    ['#1d202f', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  theme('Tokyo Night Day', 'Tokyo Night', false,
    { bg: '#d0d5e3', panel: '#e1e2e7', raised: '#d5d8e2', hover: '#c4c8da', border: '#c4c8da', fg: '#3760bf', dim: '#6172b0', accent: '#2e7de9', accentFg: '#ffffff', ok: '#587539', warn: '#8c6c3e', err: '#f52a65', sel: '#b7c1e3' },
    { bg: '#e1e2e7', fg: '#3760bf', cursor: '#3760bf', sel: '#b7c1e3' },
    ['#e9e9ed', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#3760bf']),

  // One Dark / One Light (Atom, MIT)
  theme('One Dark', 'One', true,
    { bg: '#21252b', panel: '#282c34', raised: '#2c313a', hover: '#3e4451', border: '#333842', fg: '#abb2bf', dim: '#7f848e', accent: '#61afef', accentFg: '#282c34', ok: '#98c379', warn: '#e5c07b', err: '#e06c75', sel: '#3e4451' },
    { bg: '#282c34', fg: '#abb2bf', cursor: '#528bff', sel: '#3e4451' },
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  theme('One Light', 'One', false,
    { bg: '#eaeaeb', panel: '#fafafa', raised: '#e5e5e6', hover: '#dbdbdc', border: '#dbdbdc', fg: '#383a42', dim: '#696c77', accent: '#4078f2', accentFg: '#ffffff', ok: '#50a14f', warn: '#c18401', err: '#e45649', sel: '#e5e5e6' },
    { bg: '#fafafa', fg: '#383a42', cursor: '#526fff', sel: '#e5e5e6' },
    ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7', '#696c77', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#fafafa']),

  // Rosé Pine (MIT)
  theme('Rosé Pine', 'Rosé Pine', true,
    { bg: '#191724', panel: '#1f1d2e', raised: '#26233a', hover: '#403d52', border: '#26233a', fg: '#e0def4', dim: '#908caa', accent: '#c4a7e7', accentFg: '#191724', ok: '#9ccfd8', warn: '#f6c177', err: '#eb6f92', sel: '#403d52' },
    { bg: '#191724', fg: '#e0def4', cursor: '#524f67', sel: '#403d52' },
    ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']),
  theme('Rosé Pine Moon', 'Rosé Pine', true,
    { bg: '#232136', panel: '#2a273f', raised: '#393552', hover: '#44415a', border: '#393552', fg: '#e0def4', dim: '#908caa', accent: '#c4a7e7', accentFg: '#232136', ok: '#9ccfd8', warn: '#f6c177', err: '#eb6f92', sel: '#44415a' },
    { bg: '#232136', fg: '#e0def4', cursor: '#56526e', sel: '#44415a' },
    ['#393552', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4', '#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4']),
  theme('Rosé Pine Dawn', 'Rosé Pine', false,
    { bg: '#f2e9e1', panel: '#faf4ed', raised: '#fffaf3', hover: '#dfdad9', border: '#dfdad9', fg: '#575279', dim: '#797593', accent: '#907aa9', accentFg: '#faf4ed', ok: '#286983', warn: '#ea9d34', err: '#b4637a', sel: '#dfdad9' },
    { bg: '#faf4ed', fg: '#575279', cursor: '#cecacd', sel: '#dfdad9' },
    ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279']),

  // Everforest (MIT)
  theme('Everforest Dark', 'Everforest', true,
    { bg: '#272e33', panel: '#2d353b', raised: '#343f44', hover: '#3d484d', border: '#3d484d', fg: '#d3c6aa', dim: '#859289', accent: '#a7c080', accentFg: '#2d353b', ok: '#a7c080', warn: '#dbbc7f', err: '#e67e80', sel: '#475258' },
    { bg: '#2d353b', fg: '#d3c6aa', cursor: '#d3c6aa', sel: '#475258' },
    ['#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#7a8478', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa']),
  theme('Everforest Light', 'Everforest', false,
    { bg: '#efebd4', panel: '#fdf6e3', raised: '#f4f0d9', hover: '#e6e2cc', border: '#e0dcc7', fg: '#5c6a72', dim: '#939f91', accent: '#8da101', accentFg: '#fdf6e3', ok: '#8da101', warn: '#dfa000', err: '#f85552', sel: '#e6e2cc' },
    { bg: '#fdf6e3', fg: '#5c6a72', cursor: '#5c6a72', sel: '#e6e2cc' },
    ['#5c6a72', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#dfddc8', '#a6b0a0', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#fdf6e3']),

  // Kanagawa (MIT)
  theme('Kanagawa', 'Kanagawa', true,
    { bg: '#16161d', panel: '#1f1f28', raised: '#2a2a37', hover: '#363646', border: '#2a2a37', fg: '#dcd7ba', dim: '#727169', accent: '#7e9cd8', accentFg: '#1f1f28', ok: '#98bb6c', warn: '#e6c384', err: '#e82424', sel: '#2d4f67' },
    { bg: '#1f1f28', fg: '#dcd7ba', cursor: '#c8c093', sel: '#2d4f67' },
    ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba']),

  // GitHub (Primer, MIT)
  theme('GitHub Dark', 'GitHub', true,
    { bg: '#010409', panel: '#0d1117', raised: '#161b22', hover: '#21262d', border: '#30363d', fg: '#e6edf3', dim: '#7d8590', accent: '#2f81f7', accentFg: '#ffffff', ok: '#3fb950', warn: '#d29922', err: '#f85149', sel: '#1f3a5f' },
    { bg: '#0d1117', fg: '#e6edf3', cursor: '#2f81f7', sel: '#264f78' },
    ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff']),
  theme('GitHub Light', 'GitHub', false,
    { bg: '#f6f8fa', panel: '#ffffff', raised: '#f6f8fa', hover: '#eaeef2', border: '#d0d7de', fg: '#1f2328', dim: '#656d76', accent: '#0969da', accentFg: '#ffffff', ok: '#1a7f37', warn: '#9a6700', err: '#cf222e', sel: '#ddf4ff' },
    { bg: '#ffffff', fg: '#1f2328', cursor: '#0969da', sel: '#b6e3ff' },
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),

  // Tomorrow Night (MIT)
  theme('Tomorrow Night', 'Tomorrow', true,
    { bg: '#17181a', panel: '#1d1f21', raised: '#282a2e', hover: '#373b41', border: '#282a2e', fg: '#c5c8c6', dim: '#969896', accent: '#81a2be', accentFg: '#1d1f21', ok: '#b5bd68', warn: '#f0c674', err: '#cc6666', sel: '#373b41' },
    { bg: '#1d1f21', fg: '#c5c8c6', cursor: '#c5c8c6', sel: '#373b41' },
    ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff']),
];

export const THEMES = Object.fromEntries(LIST.map((t) => [t.name, t]));
export const THEME_NAMES = LIST.map((t) => t.name);
export const DEFAULT_DARK = 'TermCraft Dark';
export const DEFAULT_LIGHT = 'TermCraft Light';
export { ANSI_KEYS };

/** Resolve the settings value ('system', a theme name, or legacy 'dark'/'light') to a theme. */
export function resolveTheme(setting, prefersDark) {
  if (setting === 'dark') return THEMES[DEFAULT_DARK];
  if (setting === 'light') return THEMES[DEFAULT_LIGHT];
  if (THEMES[setting]) return THEMES[setting];
  return THEMES[prefersDark ? DEFAULT_DARK : DEFAULT_LIGHT];
}

/** CSS custom properties for a theme's UI colors. */
export function cssVars(t) {
  const u = t.ui;
  return {
    '--bg': u.bg, '--bg-2': u.panel, '--bg-3': u.raised, '--bg-hover': u.hover, '--border': u.border,
    '--fg': u.fg, '--fg-dim': u.dim, '--accent': u.accent, '--accent-fg': u.accentFg,
    '--ok': u.ok, '--warn': u.warn, '--err': u.err, '--sel': u.sel,
    '--phosphor': u.accent, '--term-bg': t.term.background,
  };
}
