// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * SCP protocol (the rcp-style protocol behind `scp -t` / `scp -f`) over an SSH exec channel.
 * Works with any server that has an scp binary, including network devices without SFTP.
 *
 * Wire format: control records end with "\n" and are acknowledged with a single byte:
 *   0 = OK, 1 = warning (message follows), 2 = fatal error (message follows).
 *   T<mtime> 0 <atime> 0   times for the next file/dir   (with -p)
 *   C<mode> <size> <name>  file; <size> bytes follow, then a 0 byte
 *   D<mode> 0 <name>       enter directory
 *   E                      leave directory
 */
const fs = require('fs');
const path = require('path');

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024; // pause the channel when this much is buffered

/**
 * Escape a remote path for the remote shell. Glob characters (* ? [ ]) stay active so
 * wildcard downloads work like OpenSSH scp; a leading ~/ stays expandable.
 */
function quoteRemote(p) {
  if (!p || p === '~') return '.';
  if (/[\n\r\0]/.test(p)) throw new ScpError('Remote path contains a line break');
  let prefix = '';
  if (p.startsWith('~/')) { prefix = '~/'; p = p.slice(2); }
  return prefix + p.replace(/[^A-Za-z0-9_\-.,:/@%+=*?[\]]/g, (c) => '\\' + c);
}

/** A remote-supplied file name must be a single, plain path component (blocks ../ traversal). */
function safeName(name) {
  return !!name && name !== '.' && name !== '..' && !/[/\\\0]/.test(name) && !/^[A-Za-z]:/.test(name);
}

class ScpError extends Error {}

/** Buffered async reader over a channel, with backpressure. */
class ChannelReader {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.length = 0;
    this.ended = false;
    this.stderr = '';
    this.waiter = null;
    stream.on('data', (d) => {
      this.chunks.push(d);
      this.length += d.length;
      if (this.length > HIGH_WATER) stream.pause();
      this._wake();
    });
    stream.stderr?.on('data', (d) => { this.stderr += d.toString(); });
    const end = () => { this.ended = true; this._wake(); };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', end);
  }

  _wake() { const w = this.waiter; this.waiter = null; w?.(); }

  async _need() {
    while (!this.length) {
      if (this.ended) throw new ScpError(this.stderr.trim() || 'Connection closed during transfer');
      await new Promise((r) => { this.waiter = r; });
    }
  }

  /** Take up to n bytes (at least 1). */
  async take(n) {
    await this._need();
    let out = this.chunks[0];
    if (out.length > n) {
      this.chunks[0] = out.subarray(n);
      out = out.subarray(0, n);
    } else {
      this.chunks.shift();
    }
    this.length -= out.length;
    if (this.length < HIGH_WATER / 2 && this.stream.isPaused?.()) this.stream.resume();
    return out;
  }

  async byte() { return (await this.take(1))[0]; }

  async line(max = 64 * 1024) {
    const bytes = [];
    for (;;) {
      const b = await this.byte();
      if (b === 10) return Buffer.from(bytes).toString('utf8');
      bytes.push(b);
      if (bytes.length > max) throw new ScpError('Protocol error: line too long');
    }
  }

  /** Read one acknowledgement byte; throws on warning/error replies. */
  async ack() {
    const b = await this.byte();
    if (b === 0) return;
    const msg = (await this.line()).trim();
    throw new ScpError(msg || (b === 1 ? 'Remote warning' : 'Remote error'));
  }
}

const writeAsync = (stream, data) => new Promise((resolve, reject) => {
  if (stream.destroyed) return reject(new ScpError('Transfer cancelled'));
  stream.write(data, (err) => (err ? reject(err) : resolve()));
});

/** Total bytes and file count under a local path (for progress). */
async function scanLocal(p) {
  const st = await fs.promises.stat(p);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const name of await fs.promises.readdir(p)) {
    const sub = await scanLocal(path.join(p, name));
    bytes += sub.bytes;
    files += sub.files;
  }
  return { bytes, files };
}

function modeOctal(mode, fallback) {
  const m = mode & 0o7777;
  return (m || fallback).toString(8).padStart(4, '0');
}

/**
 * Upload local files/directories to remoteDir.
 * @param {(cmd: string) => Promise<Duplex>} exec  opens an exec channel
 * @param {string[]} localPaths
 * @param {string} remoteDir
 * @param {{ preserve?: boolean, onProgress?: (p) => void, signal?: { cancelled: boolean, stream?: any } }} opts
 */
async function upload(exec, localPaths, remoteDir, opts = {}) {
  const { preserve = true, onProgress = () => {}, signal = {} } = opts;
  let total = 0;
  for (const p of localPaths) total += (await scanLocal(p)).bytes;
  const anyDir = (await Promise.all(localPaths.map((p) => fs.promises.stat(p)))).some((s) => s.isDirectory());
  const flags = `${anyDir ? ' -r' : ''}${preserve ? ' -p' : ''}`;
  const stream = await exec(`scp${flags} -t -- ${quoteRemote(remoteDir)}`);
  signal.stream = stream;
  const rd = new ChannelReader(stream);
  let done = 0;
  const report = (file) => onProgress({ done, total, file });

  const check = () => { if (signal.cancelled) throw new ScpError('Transfer cancelled'); };

  const sendTimes = async (st) => {
    if (!preserve) return;
    await writeAsync(stream, `T${Math.floor(st.mtimeMs / 1000)} 0 ${Math.floor(st.atimeMs / 1000)} 0\n`);
    await rd.ack();
  };

  const sendFile = async (p, st) => {
    const name = path.basename(p);
    await sendTimes(st);
    await writeAsync(stream, `C${modeOctal(st.mode, 0o644)} ${st.size} ${name}\n`);
    await rd.ack();
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let left = st.size;
      while (left > 0) {
        check();
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, left), null);
        if (!bytesRead) throw new ScpError(`${name}: file shrank during upload`);
        await writeAsync(stream, Buffer.from(buf.subarray(0, bytesRead)));
        left -= bytesRead;
        done += bytesRead;
        report(name);
      }
    } finally {
      await fh.close();
    }
    await writeAsync(stream, Buffer.from([0]));
    await rd.ack();
  };

  const sendDir = async (p, st) => {
    await sendTimes(st);
    await writeAsync(stream, `D${modeOctal(st.mode, 0o755)} 0 ${path.basename(p)}\n`);
    await rd.ack();
    for (const child of (await fs.promises.readdir(p)).sort()) {
      check();
      const cp = path.join(p, child);
      const cst = await fs.promises.stat(cp);
      if (cst.isDirectory()) await sendDir(cp, cst);
      else if (cst.isFile()) await sendFile(cp, cst);
    }
    await writeAsync(stream, 'E\n');
    await rd.ack();
  };

  try {
    await rd.ack(); // remote scp is ready
    for (const p of localPaths) {
      check();
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) await sendDir(p, st);
      else await sendFile(p, st);
    }
    report('');
  } finally {
    stream.end();
  }
  return { bytes: done, total };
}

/**
 * Download a remote file or directory (recursively) into localDir.
 * Remote-supplied names are validated so a malicious server can't write outside localDir.
 */
async function download(exec, remotePath, localDir, opts = {}) {
  const { preserve = true, onProgress = () => {}, signal = {} } = opts;
  const stream = await exec(`scp -r${preserve ? ' -p' : ''} -f -- ${quoteRemote(remotePath)}`);
  signal.stream = stream;
  const rd = new ChannelReader(stream);
  const ok = () => writeAsync(stream, Buffer.from([0]));
  const dirs = [path.resolve(localDir)];
  let times = null;
  let done = 0;
  let total = 0;
  let files = 0;
  const top = path.posix.basename(remotePath.replace(/\/+$/, '')) || remotePath;
  // With wildcards the server legitimately sends names other than the one requested.
  const expectTop = /[*?[\]{}]/.test(top) || top === '~' || top === '.' ? null : top;
  let dirsCreated = 0;

  try {
    await ok();
    for (;;) {
      if (signal.cancelled) throw new ScpError('Transfer cancelled');
      let type;
      try {
        type = await rd.byte();
      } catch (e) {
        if (rd.ended && dirs.length === 1) break; // remote finished at top level: normal end
        throw e;
      }
      if (type === 1 || type === 2) {
        const msg = (await rd.line()).trim();
        throw new ScpError(msg || 'Remote error');
      }
      const line = (await rd.line()).trim();
      const cur = dirs[dirs.length - 1];
      if (type === 0x54 /* T */) {
        const m = /^(\d+) \d+ (\d+) \d+$/.exec(line);
        if (!m) throw new ScpError(`Protocol error: bad time record "T${line}"`);
        times = { mtime: Number(m[1]), atime: Number(m[2]) };
        await ok();
      } else if (type === 0x44 /* D */) {
        const m = /^([0-7]{3,4}) \d+ (.+)$/.exec(line);
        if (!m || !safeName(m[2])) throw new ScpError(`Refusing unsafe directory name from server: "${m ? m[2] : line}"`);
        if (dirs.length === 1 && expectTop && m[2] !== expectTop) throw new ScpError(`Server sent unexpected directory "${m[2]}" (asked for "${top}")`);
        const dir = path.join(cur, m[2]);
        await fs.promises.mkdir(dir, { recursive: true });
        dirs.push(dir);
        dirsCreated++;
        if (times && preserve) await fs.promises.utimes(dir, times.atime, times.mtime).catch(() => {});
        times = null;
        await ok();
      } else if (type === 0x45 /* E */) {
        if (dirs.length === 1) throw new ScpError('Protocol error: unbalanced directory end');
        dirs.pop();
        await ok();
      } else if (type === 0x43 /* C */) {
        const m = /^([0-7]{3,4}) (\d+) (.+)$/.exec(line);
        if (!m || !safeName(m[3])) throw new ScpError(`Refusing unsafe file name from server: "${m ? m[3] : line}"`);
        if (dirs.length === 1 && expectTop && m[3] !== expectTop) throw new ScpError(`Server sent unexpected file "${m[3]}" (asked for "${top}")`);
        const size = Number(m[2]);
        const mode = parseInt(m[1], 8);
        const file = path.join(cur, m[3]);
        total += size;
        await ok();
        const out = fs.createWriteStream(file);
        try {
          let left = size;
          while (left > 0) {
            if (signal.cancelled) throw new ScpError('Transfer cancelled');
            const chunk = await rd.take(Math.min(left, CHUNK));
            left -= chunk.length;
            done += chunk.length;
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            onProgress({ done, total, file: m[3], fileSize: size });
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
        await rd.ack(); // trailing 0 after file data
        if (preserve) {
          if (process.platform !== 'win32') await fs.promises.chmod(file, mode & 0o777).catch(() => {});
          if (times) await fs.promises.utimes(file, times.atime, times.mtime).catch(() => {});
        }
        times = null;
        files++;
        await ok();
      } else {
        throw new ScpError(`Protocol error: unexpected record "${String.fromCharCode(type)}${line}"`);
      }
    }
  } finally {
    stream.end();
  }
  if (!files && !dirsCreated) throw new ScpError(rd.stderr.trim() || 'Nothing was downloaded');
  onProgress({ done, total, file: '' });
  return { bytes: done, files };
}

module.exports = { upload, download, quoteRemote, safeName, ScpError };
