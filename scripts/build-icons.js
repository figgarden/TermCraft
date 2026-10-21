// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Render the TermCraft artwork to every icon format the installers need.
 * Run:  npm run icons   (rasterizes with resvg through `cargo run --example render_svg`)
 *
 * Outputs:
 *   build/icon.svg, build/icon.png (1024)   source + generic
 *   build/icon.icns                          macOS (via iconutil, macOS only)
 *   build/icon.ico                           Windows (16–256, PNG-compressed entries)
 *   build/icons/<n>x<n>.png                  Linux (hicolor sizes)
 *   src/renderer/assets/{logo.svg,icon.png}  in-app logo and window icon
 *   docs/banner.svg, docs/banner.png         README / social preview
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { iconSvg, markSvg, bannerSvg, previewSvg } = require('./icon-art');

const root = path.join(__dirname, '..');
const out = (...p) => path.join(root, ...p);

/** Rasterize SVGs at exact pixel sizes, keeping transparency: [{ svg, out, width, height }]. */
function renderAll(jobs) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-icons-')), 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(jobs));
  execFileSync('cargo', ['run', '-q', '--release', '--example', 'render_svg', '--', file], { cwd: out('src-tauri'), stdio: 'inherit' });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

/** Windows .ico with PNG-compressed images (supported since Vista). */
function writeIco(file, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, dir, ...pngs.map((p) => p.data)]));
}

function main() {
  for (const d of ['build', 'build/icons', 'src/renderer/assets', 'docs']) fs.mkdirSync(out(d), { recursive: true });
  const full = iconSvg({ variant: 'full' });
  const mac = iconSvg({ variant: 'mac' });
  const small = iconSvg({ variant: 'small' });
  // Small sizes use the simplified art so the prompt stays legible.
  const pick = (n, big) => (n <= 32 ? small : big);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-iconset-'));
  const png = (svg, n, file) => ({ svg, out: file, width: n, height: n });
  const jobs = [png(full, 1024, out('build/icon.png'))];

  fs.writeFileSync(out('build/icon.svg'), full);
  // Linux hicolor sizes.
  for (const n of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) jobs.push(png(pick(n, full), n, out('build/icons', `${n}x${n}.png`)));
  // Windows (assembled below).
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  for (const n of icoSizes) jobs.push(png(pick(n, full), n, path.join(tmp, `ico-${n}.png`)));
  // macOS.
  const iconset = out('build/icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  for (const n of [16, 32, 128, 256, 512]) {
    jobs.push(png(n <= 16 ? small : mac, n, path.join(iconset, `icon_${n}x${n}.png`)));
    jobs.push(png(n <= 16 ? small : mac, n * 2, path.join(iconset, `icon_${n}x${n}@2x.png`)));
  }
  // In-app assets, review sheet and banner.
  jobs.push(png(full, 512, out('src/renderer/assets/icon.png')));
  jobs.push({ svg: previewSvg(), out: out('docs/icon-preview.png'), width: 1100, height: 520 });
  jobs.push({ svg: bannerSvg(), out: out('docs/banner.png'), width: 1280, height: 400 });
  renderAll(jobs);

  writeIco(out('build/icon.ico'), icoSizes.map((n) => ({ size: n, data: fs.readFileSync(path.join(tmp, `ico-${n}.png`)) })));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out('build/icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
  } else {
    console.warn('iconutil is macOS-only; left build/icon.iconset for conversion on a Mac');
  }
  fs.writeFileSync(out('src/renderer/assets/logo.svg'), markSvg());
  fs.writeFileSync(out('docs/banner.svg'), bannerSvg());
  console.log('Icons written to build/, src/renderer/assets/ and docs/');
}

main();
