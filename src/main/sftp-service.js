// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SshConnection } = require('./protocols/ssh');
const { isSafeFileName } = require('./security');

const posix = path.posix;

function modeString(mode, isDir, isLink) {
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  const r = (m, s) => ((mode & m) ? s : '-');
  return t + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(0o4, 'r') + r(0o2, 'w') + r(0o1, 'x');
}

class SftpService {
  /** @param {{ store, request, send }} deps */
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map(); // sftpId -> { conn, sftp }
  }

  async open(sftpId, sessionRef) {
    const session = this.deps.store.resolveSession(sessionRef);
    if (session.protocol !== 'ssh2') throw new Error('SFTP requires an SSH2 session');
    const conn = new SshConnection({ ...session, forwards: [] }, {
      store: this.deps.store,
      mode: 'sftp',
      prompt: (req) => this.deps.request('prompt', { ...req, tabId: sftpId }),
    });
    conn.on('close', () => { this.sessions.delete(sftpId); this.deps.send('sftp:closed', sftpId); });
    conn.on('credentials', (creds) => {
      try {
        const saved = this.deps.store.saveCredentials(creds.target || sessionRef, creds);
        this.deps.send('session:saved', sftpId, { session: saved, forTab: !creds.target });
      } catch (e) { console.error('[sftp] save login failed:', e); }
    });
    await conn.connect();
    const sftp = await conn.sftp();
    this.sessions.set(sftpId, { conn, sftp });
    const home = await this._call(sftp, 'realpath', '.');
    return { home, host: session.host, username: conn.username };
  }

  close(sftpId) {
    const s = this.sessions.get(sftpId);
    if (s) { this.sessions.delete(sftpId); s.conn.close(); }
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }

  _get(sftpId) {
    const s = this.sessions.get(sftpId);
    if (!s) throw new Error('SFTP session is not connected');
    return s.sftp;
  }

  _call(sftp, method, ...args) {
    return new Promise((resolve, reject) => sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res))));
  }

  async listRemote(sftpId, dir) {
    const sftp = this._get(sftpId);
    const real = await this._call(sftp, 'realpath', dir);
    const entries = await this._call(sftp, 'readdir', real);
    return {
      path: real,
      entries: entries.map((e) => {
        const isDir = e.attrs.isDirectory();
        const isLink = e.attrs.isSymbolicLink();
        return {
          name: e.filename, isDir, isLink, size: e.attrs.size, mtime: e.attrs.mtime * 1000,
          mode: modeString(e.attrs.mode, isDir, isLink),
        };
      }),
    };
  }

  async listLocal(dir) {
    const real = path.resolve((dir || os.homedir()).replace(/^~/, os.homedir()));
    const names = await fs.promises.readdir(real);
    const entries = [];
    for (const name of names) {
      try {
        const st = await fs.promises.lstat(path.join(real, name));
        let isDir = st.isDirectory();
        if (st.isSymbolicLink()) { try { isDir = (await fs.promises.stat(path.join(real, name))).isDirectory(); } catch { /* dangling link */ } }
        entries.push({ name, isDir, isLink: st.isSymbolicLink(), size: st.size, mtime: st.mtimeMs, mode: modeString(st.mode, isDir, st.isSymbolicLink()) });
      } catch { /* unreadable entry */ }
    }
    return { path: real, entries, sep: path.sep, parent: path.dirname(real) };
  }

  async remoteOp(sftpId, op, a, b) {
    const sftp = this._get(sftpId);
    switch (op) {
      case 'mkdir': return this._call(sftp, 'mkdir', a);
      case 'rename': return this._call(sftp, 'rename', a, b);
      case 'delete': return this._removeRemote(sftp, a);
      case 'chmod': return this._call(sftp, 'chmod', a, parseInt(b, 8));
      default: throw new Error('Unknown op ' + op);
    }
  }

  async _removeRemote(sftp, p) {
    const st = await this._call(sftp, 'lstat', p);
    if (!st.isDirectory()) return this._call(sftp, 'unlink', p);
    for (const e of await this._call(sftp, 'readdir', p)) await this._removeRemote(sftp, posix.join(p, e.filename));
    return this._call(sftp, 'rmdir', p);
  }

  async localOp(op, a, b) {
    switch (op) {
      case 'mkdir': return fs.promises.mkdir(a, { recursive: true });
      case 'rename': return fs.promises.rename(a, b);
      case 'delete': return fs.promises.rm(a, { recursive: true, force: true });
      default: throw new Error('Unknown op ' + op);
    }
  }

  /** Download a remote file or directory tree. Reports progress via sftp:progress events. */
  async download(sftpId, transferId, remotePath, localDir) {
    const sftp = this._get(sftpId);
    const name = posix.basename(remotePath);
    // Names come from the server; one containing a separator could escape localDir (e.g. "..\\x" on Windows).
    if (!isSafeFileName(name)) throw new Error(`Refusing unsafe file name from server: "${name}"`);
    const target = path.join(localDir, name);
    const st = await this._call(sftp, 'stat', remotePath);
    if (st.isDirectory()) {
      await fs.promises.mkdir(target, { recursive: true });
      for (const e of await this._call(sftp, 'readdir', remotePath)) {
        if (!isSafeFileName(e.filename)) continue; // skip entries a hostile server crafted
        await this.download(sftpId, transferId, posix.join(remotePath, e.filename), target);
      }
      return target;
    }
    await new Promise((resolve, reject) => sftp.fastGet(remotePath, target, {
      step: (done, _chunk, total) => this.deps.send('sftp:progress', { transferId, file: name, done, total }),
    }, (err) => (err ? reject(err) : resolve())));
    this.deps.send('sftp:progress', { transferId, file: name, done: st.size, total: st.size });
    return target;
  }

  async upload(sftpId, transferId, localPath, remoteDir) {
    const sftp = this._get(sftpId);
    const name = path.basename(localPath);
    const target = posix.join(remoteDir, name);
    const st = await fs.promises.stat(localPath);
    if (st.isDirectory()) {
      try { await this._call(sftp, 'mkdir', target); } catch { /* already exists */ }
      for (const child of await fs.promises.readdir(localPath)) {
        await this.upload(sftpId, transferId, path.join(localPath, child), target);
      }
      return target;
    }
    await new Promise((resolve, reject) => sftp.fastPut(localPath, target, {
      step: (done, _chunk, total) => this.deps.send('sftp:progress', { transferId, file: name, done, total }),
    }, (err) => (err ? reject(err) : resolve())));
    this.deps.send('sftp:progress', { transferId, file: name, done: st.size, total: st.size });
    return target;
  }
}

module.exports = { SftpService };
