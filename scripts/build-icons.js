// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Render the TermCraft artwork to every icon format the installers need.
 * Run with Electron (it renders the SVGs):  npm run icons
 *
 * Outputs:
 *   build/icon.svg, build/icon.png (1024)   source + generic
 *   build/icon.icns                          macOS (via iconutil, macOS only)
 *   build/icon.ico                           Windows (16–256, PNG-compressed entries)
 *   build/icons/<n>x<n>.png                  Linux (hicolor sizes)
 *   src/renderer/assets/{logo.svg,icon.png}  in-app logo and window icon
 *   docs/banner.svg, docs/banner.png         README / social preview
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { iconSvg, markSvg, bannerSvg, previewSvg } = require('./icon-art');

const root = path.join(__dirname, '..');
const out = (...p) => path.join(root, ...p);

let renderer = null;

/** Hidden window used as a canvas: rasterizes SVG at an exact pixel size, keeping transparency. */
async function getRenderer() {
  if (renderer) return renderer;
  renderer = new BrowserWindow({ show: false, width: 200, height: 200 });
  const tmp = path.join(require('os').tmpdir(), `termcraft-icon-${process.pid}.html`);
  fs.writeFileSync(tmp, '<!doctype html><title>render</title>');
  try { await renderer.loadFile(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  return renderer;
}

async function render(svg, width, height) {
  const win = await getRenderer();
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${width}; c.height = ${height};
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${width}, ${height});
    return c.toDataURL('image/png');
  })()`);
  return nativeImage.createFromDataURL(dataUrl);
}

/** Downscale a large render to n×n (renders big then shrinks for clean antialiasing). */
const sized = (img, n) => (img.getSize().width === n ? img : img.resize({ width: n, height: n, quality: 'best' })).toPNG();

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

async function main() {
  for (const d of ['build', 'build/icons', 'src/renderer/assets', 'docs']) fs.mkdirSync(out(d), { recursive: true });

  const full = await render(iconSvg({ variant: 'full' }), 1024, 1024);
  const mac = await render(iconSvg({ variant: 'mac' }), 1024, 1024);
  const small = await render(iconSvg({ variant: 'small' }), 1024, 1024);
  // Small sizes use the simplified art so the prompt stays legible.
  const pick = (n, big) => (n <= 32 ? small : big);

  fs.writeFileSync(out('build/icon.svg'), iconSvg({ variant: 'full' }));
  fs.writeFileSync(out('build/icon.png'), full.toPNG());

  // Linux hicolor sizes.
  for (const n of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(out('build/icons', `${n}x${n}.png`), sized(pick(n, full), n));
  }

  // Windows.
  writeIco(out('build/icon.ico'), [16, 24, 32, 48, 64, 128, 256].map((n) => ({ size: n, data: sized(pick(n, full), n) })));

  // macOS.
  const iconset = out('build/icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  for (const n of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${n}x${n}.png`), sized(n <= 16 ? small : mac, n));
    fs.writeFileSync(path.join(iconset, `icon_${n}x${n}@2x.png`), sized(n <= 16 ? small : mac, n * 2));
  }
  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out('build/icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
  } else {
    console.warn('iconutil is macOS-only; left build/icon.iconset for conversion on a Mac');
  }

  // In-app assets.
  fs.writeFileSync(out('src/renderer/assets/logo.svg'), markSvg());
  fs.writeFileSync(out('src/renderer/assets/icon.png'), sized(full, 512));

  // Review sheet: the icon at Dock and taskbar sizes.
  fs.writeFileSync(out('docs/icon-preview.png'), (await render(previewSvg(), 1100, 520)).toPNG());

  // Banner.
  fs.writeFileSync(out('docs/banner.svg'), bannerSvg());
  fs.writeFileSync(out('docs/banner.png'), (await render(bannerSvg(), 1280, 400)).toPNG());

  renderer?.destroy();
  console.log('Icons written to build/, src/renderer/assets/ and docs/');
}

app.whenReady().then(main).then(() => app.quit(), (e) => { console.error(e); app.exit(1); });
