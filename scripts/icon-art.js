// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * TermCraft mark, mid-century modernist and dark: dots and lines,
 * flat warm inks on a grained charcoal card.
 *
 * The idea: the prompt ">" is a connection path. Its top arm (mustard) is you, its bottom arm
 * (teal) is the remote server, and they meet at a vermilion joint: the hop or jump host. The
 * cream "_" cursor beside it says: connected, ready. One line weight, round ends throughout.
 *
 *   iconSvg({ variant })  'mac' (macOS grid + shadow) | 'full' (Windows/Linux) | 'small' (16–32px)
 *   markSvg()             the icon, for in-app use
 *   bannerSvg()           README banner
 *   previewSvg()          the icon at several sizes, for review
 */

const C = {
  charcoal: '#1d1c1a',
  charcoalLift: '#2a2825',
  cream: '#efe5cf',
  vermilion: '#e0532c',
  mustard: '#e2a93b',
  teal: '#2e8b85',
};

const SANS = "Futura, 'Futura PT', 'Avenir Next', 'Century Gothic', 'Helvetica Neue', Arial, sans-serif";

function defs(id) {
  return `
  <defs>
    <radialGradient id="${id}-bg" cx="0.45" cy="0.35" r="0.85">
      <stop offset="0" stop-color="${C.charcoalLift}"/>
      <stop offset="1" stop-color="${C.charcoal}"/>
    </radialGradient>
    <!-- Printed-paper grain over the whole card. -->
    <filter id="${id}-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 0.96  0 0 0 0 0.88  0 0 0 0.55 -0.18"/>
    </filter>
    <filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>`;
}

/**
 * The mark in a 1000×1000 box: the prompt ">" drawn as a connection path — a wire through
 * three nodes: you (mustard) → the hop / jump host (vermilion) → the server (teal) — and a
 * cream "_" cursor: connected, ready. `simple` thickens everything for tiny sizes.
 */
function scene(id, simple) {
  // One system: a single line weight W, round ends everywhere, everything on shared lines.
  const W = simple ? 150 : 124;
  const dx = -30; // optical centring of the whole group
  const you = [285 + dx, 262];
  const hop = [630 + dx, 500];
  const server = [285 + dx, 738];
  const hopR = W * 0.78;
  const arm = (a, b, color) => `<path d="M${a[0]} ${a[1]} L${b[0]} ${b[1]}" stroke="${color}" stroke-width="${W}" stroke-linecap="round"/>`;
  // The cursor: a pill of the same weight, on the server's baseline.
  const cur = { x1: 715 + dx, x2: 875 + dx, y: server[1] };
  return `
  ${arm(you, hop, C.mustard)}
  ${arm(hop, server, C.teal)}
  <circle cx="${hop[0]}" cy="${hop[1]}" r="${hopR}" fill="${C.vermilion}"/>
  <circle cx="${hop[0]}" cy="${hop[1]}" r="${hopR * 0.34}" fill="${C.cream}"/>
  <path d="M${cur.x1} ${cur.y} H${cur.x2}" stroke="${C.cream}" stroke-width="${W}" stroke-linecap="round"/>`;
}

function tile(id, x, y, size, radius, simple, shadow) {
  const k = size / 1000;
  return `
  <clipPath id="${id}-tile"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}"/></clipPath>
  <g${shadow ? ` filter="url(#${id}-shadow)"` : ''}>
    <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}" fill="url(#${id}-bg)"/>
  </g>
  <g clip-path="url(#${id}-tile)">
    <g transform="translate(${x} ${y}) scale(${k.toFixed(5)})">${scene(id, simple)}
    </g>
    ${simple ? '' : `<rect x="${x}" y="${y}" width="${size}" height="${size}" filter="url(#${id}-grain)" opacity="0.5"/>`}
  </g>
  <rect x="${x + 1.5}" y="${y + 1.5}" width="${size - 3}" height="${size - 3}" rx="${radius - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="${simple ? 0.22 : 0.08}" stroke-width="${simple ? 24 : 3}"/>`;
}

function iconSvg({ variant = 'full' } = {}) {
  const id = `tc-${variant}`;
  let body;
  if (variant === 'mac') body = tile(id, 100, 100, 824, 185, false, true);
  else if (variant === 'small') body = tile(id, 24, 24, 976, 200, true, false);
  else body = tile(id, 40, 40, 944, 200, false, false);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${defs(id)}${body}
</svg>`;
}

function markSvg() {
  const id = 'tc-mark';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="TermCraft: the prompt >_ drawn as a connection — you, a jump host and a server joined by a wire">${defs(id)}${tile(id, 40, 40, 944, 200, false, false)}
</svg>`;
}

/** README banner: the mark and a lowercase geometric wordmark on charcoal. */
function bannerSvg() {
  const id = 'tc-banner';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="400" viewBox="0 0 1280 400" role="img" aria-label="termcraft — a craft for the command line">${defs(id)}
  <rect width="1280" height="400" fill="url(#${id}-bg)"/>
  ${tile(id, 110, 80, 240, 54, false, true)}
  <text x="420" y="214" font-family="${SANS}" font-size="104" font-weight="600" letter-spacing="-1" fill="${C.cream}">term<tspan fill="${C.vermilion}">craft</tspan></text>
  <path d="M429 249 H483" stroke="${C.teal}" stroke-width="10" stroke-linecap="round"/>
  <text x="506" y="254" font-family="${SANS}" font-size="22" letter-spacing="4" fill="${C.mustard}">A CRAFT FOR THE COMMAND LINE</text>
  ${[[C.mustard, 'you'], [C.vermilion, 'jump host'], [C.teal, 'server']].map(([c, t], i) => {
    const x = 432 + [0, 110, 312][i];
    return `<circle cx="${x}" cy="306" r="11" fill="${c}"/><text x="${x + 22}" y="314" font-family="${SANS}" font-size="22" fill="${C.cream}" opacity="0.85">${t}</text>`;
  }).join('')}
  <path d="M500 306 H520" stroke="${C.mustard}" stroke-width="7" stroke-linecap="round"/>
  <path d="M680 306 H718" stroke="${C.teal}" stroke-width="7" stroke-linecap="round"/>
  <rect width="1280" height="400" filter="url(#${id}-grain)" opacity="0.35"/>
</svg>`;
}

/** Review sheet: the icon at Dock size and at taskbar sizes on light and dark. */
function previewSvg() {
  const inner = (v) => iconSvg({ variant: v }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="520" viewBox="0 0 1100 520">
  <rect width="1100" height="520" fill="#e9e6df"/>
  <svg x="30" y="30" width="460" height="460" viewBox="0 0 1024 1024">${inner('mac')}</svg>
  ${[256, 128, 64, 32, 16].map((n, i) => `<svg x="${540 + [0, 270, 410, 490, 540][i]}" y="${40 + (256 - n) / 2}" width="${n}" height="${n}" viewBox="0 0 1024 1024">${inner(n <= 32 ? 'small' : 'full')}</svg>`).join('')}
  <rect x="520" y="330" width="560" height="160" rx="14" fill="#1e1e22"/>
  ${[64, 48, 32, 24, 16].map((n, i) => `<svg x="${550 + [0, 90, 165, 225, 275][i]}" y="${410 - n / 2}" width="${n}" height="${n}" viewBox="0 0 1024 1024">${inner(n <= 32 ? 'small' : 'full')}</svg>`).join('')}
</svg>`;
}

module.exports = { iconSvg, markSvg, bannerSvg, previewSvg, COLORS: C };
