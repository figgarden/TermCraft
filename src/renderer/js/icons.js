// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// TermCraft's icon set: one family on a 24px grid, 1.75px round strokes, colored by the theme.

const P = {
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  rotate: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5',
  unplug: 'M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5M4 4l16 16',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  terminal: 'M4 5h16v14H4zM7.5 9.5 10.5 12l-3 2.5M12.5 15h4',
  transfer: 'M7 20V5m0 0L3.5 8.5M7 5l3.5 3.5M17 4v15m0 0-3.5-3.5M17 19l3.5-3.5',
  folderSync: 'M3.5 6.5h6l2 2h9v10.5h-17zM9 14.5h6m-2-2 2 2-2 2',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  record: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  play: 'M8 5.5v13l10-6.5-10-6.5Z',
  sliders: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4.5v5M7 14.5v5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  broadcast: 'M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9 9 0 0 1 0-13M18.5 5.5a9 9 0 0 1 0 13',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  plus: 'M12 5v14M5 12h14',
  folderPlus: 'M3.5 6.5h6l2 2h9v10.5h-17zM12 11.5v5M9.5 14h5',
  pencil: 'M15.5 5.5l3 3L9 18H6v-3l9.5-9.5Z',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7',
  chevronsLeft: 'M11 17l-5-5 5-5M18 17l-5-5 5-5',
  chevronsRight: 'M13 7l5 5-5 5M6 7l5 5-5 5',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z',
  auto: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 4v16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  buffer: 'M4 5h16v14H4zM4 13.5h16M7 16.5h6',
  folderOpen: 'M3.5 18.5V6.5h6l2 2h7v2.5M3.5 18.5l2.5-7.5h15l-2.5 7.5h-15Z',
  save: 'M12 4v11m0 0-4-4m4 4 4-4M5 16v3.5h14V16',
};

/** An inline SVG icon (decorative; give the button its own aria-label). */
export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', P[name] || P.close);
  svg.append(path);
  return svg;
}
