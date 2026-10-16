// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Write THIRD-PARTY-NOTICES.md: every production dependency bundled with TermCraft, its
 * license, and its full license text (MIT/BSD/ISC require the notice to ship with copies).
 * Electron/Chromium's own notices ship separately in the app bundle (LICENSES.chromium.html).
 *
 * Run: npm run notices
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function resolvePkg(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) return null;
  }
}

const seen = new Map();
function walk(name, fromDir) {
  const pj = resolvePkg(name, fromDir);
  if (!pj) return; // optional dependency not installed on this platform
  const dir = path.dirname(pj);
  if (seen.has(dir)) return;
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  seen.set(dir, {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type).join(' OR ') || 'UNKNOWN',
    homepage: pkg.homepage || (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) || '',
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : '',
  });
  for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) walk(dep, dir);
}

for (const dep of Object.keys({ ...(rootPkg.dependencies || {}), ...(rootPkg.optionalDependencies || {}) })) walk(dep, root);

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = entries.filter((e) => !e.text);
const lines = [
  '# Third-Party Notices',
  '',
  'TermCraft is licensed under the GNU General Public License, version 2 or (at your option) any later version. See [LICENSE](LICENSE).',
  '',
  'It bundles the following third-party packages, each under its own license. All are compatible with the GPL: permissive licenses (MIT, BSD, Unlicense) and, for noVNC, MPL-2.0 (via its secondary-license clause; its source ships unmodified with the app).',
  'The Electron runtime and Chromium notices ship with the app in its `licenses/` resource folder (`LICENSE.electron.txt`, `LICENSES.chromium.html`).',
  '',
  '| Package | Version | License |',
  '|---|---|---|',
  ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} |`),
  '',
  '---',
  '',
];
for (const e of entries) {
  lines.push(`## ${e.name} ${e.version}`, '', `License: ${e.license}${e.homepage ? ` · ${e.homepage.replace(/^git\+/, '')}` : ''}`, '');
  lines.push(e.text ? '```text\n' + e.text + '\n```' : '_No license file is included in this package; see the license identifier above._', '');
}
// Color palettes used by the built-in themes (color values only, no code from these projects).
const PALETTES = [
  ['Catppuccin', 'MIT', 'https://github.com/catppuccin/catppuccin'],
  ['Nord', 'MIT', 'https://github.com/nordtheme/nord'],
  ['Solarized (Ethan Schoonover)', 'MIT', 'https://github.com/altercation/solarized'],
  ['Dracula', 'MIT', 'https://github.com/dracula/dracula-theme'],
  ['Gruvbox (Pavel Pertsev)', 'MIT', 'https://github.com/morhetz/gruvbox'],
  ['Tokyo Night (Folke Lemaitre)', 'Apache-2.0', 'https://github.com/folke/tokyonight.nvim'],
  ['One Dark / One Light (Atom)', 'MIT', 'https://github.com/atom/atom'],
  ['Rosé Pine', 'MIT', 'https://github.com/rose-pine/rose-pine-theme'],
  ['Everforest (Sainnhe Park)', 'MIT', 'https://github.com/sainnhe/everforest'],
  ['Kanagawa (Tommaso Laurenzi)', 'MIT', 'https://github.com/rebelot/kanagawa.nvim'],
  ['GitHub themes (Primer)', 'MIT', 'https://github.com/primer/github-vscode-theme'],
  ['Tomorrow (Chris Kempson)', 'MIT', 'https://github.com/chriskempson/tomorrow-theme'],
  ['Monokai (Wimer Hazenberg)', 'free to use', 'https://monokai.pro'],
];
lines.splice(lines.indexOf('---'), 0,
  '## Color palettes',
  '',
  'The built-in themes use the published color values of these open-source palettes (no code from them is included). Thanks to their authors.',
  '',
  '| Palette | License | Source |',
  '|---|---|---|',
  ...PALETTES.map(([n, l, u]) => `| ${n} | ${l} | ${u} |`),
  '');
fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'));
console.log(`Wrote THIRD-PARTY-NOTICES.md (${entries.length} packages${missing.length ? `, ${missing.length} without a license file: ${missing.map((m) => m.name).join(', ')}` : ''})`);
const licenses = [...new Set(entries.map((e) => e.license))].sort();
console.log('Licenses:', licenses.join(', '));
