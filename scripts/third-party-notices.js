// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Write THIRD-PARTY-NOTICES.md: every third-party package built into TermCraft — the UI's
 * browser libraries (npm) and the Rust crates the app is compiled from, on every platform —
 * with its license and full license text (MIT/BSD/ISC/Apache require the notice to ship with
 * copies). The system web view (WebKit, WebView2) is part of the operating system, not bundled.
 *
 * Run: npm run notices   (needs cargo)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    texts: licenseFile ? [fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim()] : [],
  });
  for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) walk(dep, dir);
}

for (const dep of Object.keys({ ...(rootPkg.dependencies || {}), ...(rootPkg.optionalDependencies || {}) })) walk(dep, root);

// Rust crates: the normal (not build-only or dev) dependency graph of the app, on all platforms.
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')], { maxBuffer: 1 << 28 }));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const runtime = new Set();
for (const stack = [meta.resolve.root]; stack.length;) {
  const id = stack.pop();
  if (runtime.has(id)) continue;
  runtime.add(id);
  for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
}
for (const p of meta.packages) {
  if (!runtime.has(p.id) || p.id === meta.resolve.root) continue;
  const dir = path.dirname(p.manifest_path);
  const files = fs.readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f)).sort();
  seen.set(`crate:${p.name}@${p.version}`, {
    name: p.name,
    version: p.version,
    license: p.license || (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'),
    homepage: p.repository || p.homepage || '',
    texts: files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()),
    crate: true,
  });
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = entries.filter((e) => !e.texts.length);
const lines = [
  '# Third-Party Notices',
  '',
  'TermCraft is licensed under the GNU General Public License, version 2 or (at your option) any later version. See [LICENSE](LICENSE).',
  '',
  'It is built from the following third-party packages, each under its own license: the UI\'s browser libraries (npm) and the Rust crates the app is compiled from. All are compatible with the GPL: permissive licenses (MIT, BSD, ISC, Zlib, Unlicense), MPL-2.0 for noVNC (via its secondary-license clause; its source ships unmodified with the app), and Apache-2.0 for some Rust crates (compatible with GPL version 3, which TermCraft\'s "or any later version" terms allow). Where a crate offers a choice (e.g. "MIT OR Apache-2.0"), TermCraft uses it under the MIT or BSD option.',
  'The system web view (WebKit on macOS and Linux, WebView2 on Windows) is part of the operating system and is not bundled.',
  '',
  '| Package | Version | License |',
  '|---|---|---|',
  ...entries.map((e) => `| ${e.crate ? `${e.name} (Rust)` : e.name} | ${e.version} | ${e.license} |`),
  '',
  '---',
  '',
];
// Each distinct license text once, with the packages it covers (identical texts, such as the
// Apache-2.0 license, are shared by many crates).
const label = (e) => `${e.crate ? `${e.name} (Rust)` : e.name} ${e.version}`;
const byText = new Map();
for (const e of entries) {
  for (const key of e.texts.length ? e.texts : [`__none__${e.license}`]) {
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(e);
  }
}
for (const [key, group] of byText) {
  lines.push(`## ${group.map(label).join(', ')}`, '', `License: ${[...new Set(group.map((e) => e.license))].join('; ')}`, '');
  const sites = [...new Set(group.map((e) => e.homepage).filter(Boolean))].slice(0, 5);
  if (sites.length) lines.push(`Source: ${sites.map((h) => h.replace(/^git\+/, '')).join(' · ')}`, '');
  lines.push(key.startsWith('__none__') ? '_No license file is included in these packages; see the license identifier above._' : '```text\n' + key + '\n```', '');
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
