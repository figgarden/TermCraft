// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
const { SshConnection } = require('./protocols/ssh');
const { parseConnectString } = require('./util');
const scp = require('./scp');

/**
 * Backs the SCP Transfer Manager: one SSH connection per manager tab (optionally through a
 * jump host), with each transfer running on its own exec channel so several can run at once.
 */
class ScpService {
  /** @param {{ store, request, send }} deps */
  constructor(deps) {
    this.deps = deps;
    this.conns = new Map(); // tabId -> SshConnection
    this.jobs = new Map(); // jobId -> cancel signal
  }

  /**
   * @param {string} tabId
   * @param {string|object} targetRef  saved session id or ad-hoc session object
   * @param {{ mode: 'default'|'none'|'session'|'adhoc', id?: string, target?: string }} jump
   */
  async open(tabId, targetRef, jump = { mode: 'default' }) {
    this.close(tabId);
    const session = this.deps.store.resolveSession(targetRef);
    if (session.protocol !== 'ssh2') throw new Error('SCP needs an SSH2 session');
    session.forwards = [];
    session.ssh = { ...(session.ssh || {}) };
    delete session.ssh.jumpSession;
    let via = session.ssh.jumpSessionId ? this.deps.store.getSession(session.ssh.jumpSessionId)?.name : '';
    if (jump.mode === 'none') {
      session.ssh.jumpSessionId = '';
      via = '';
    } else if (jump.mode === 'session') {
      const j = this.deps.store.getSession(jump.id);
      if (!j) throw new Error('Jump host session not found');
      session.ssh.jumpSessionId = j.id;
      via = j.name;
    } else if (jump.mode === 'adhoc') {
      const parsed = parseConnectString(jump.target || '');
      if (!parsed || parsed.protocol !== 'ssh2') throw new Error(`Invalid jump host "${jump.target}" — use user@host[:port]`);
      session.ssh.jumpSessionId = '';
      session.ssh.jumpSession = { ...parsed, name: jump.target };
      via = jump.target;
    }

    const conn = new SshConnection(session, {
      store: this.deps.store,
      mode: 'tunnel',
      prompt: (req) => this.deps.request('prompt', { ...req, tabId }),
    });
    conn.on('info', (msg) => this.deps.send('scp:log', tabId, msg));
    conn.on('credentials', (creds) => {
      try {
        const saved = this.deps.store.saveCredentials(creds.target || targetRef, creds);
        this.deps.send('session:saved', tabId, { session: saved, forTab: !creds.target });
      } catch (e) { this.deps.send('scp:log', tabId, `Could not save login: ${e.message}`); }
    });
    conn.on('close', () => {
      if (this.conns.get(tabId) === conn) { this.conns.delete(tabId); this.deps.send('scp:closed', tabId); }
    });
    await conn.connect();
    this.conns.set(tabId, conn);
    let home = '';
    try { home = (await this._execText(conn, 'pwd')).trim().split('\n').pop(); } catch { /* not a POSIX shell (e.g. a router) */ }
    return { host: session.host, port: session.port, username: conn.username, via, home };
  }

  _execText(conn, cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd).then((st) => {
        let out = '';
        const timer = setTimeout(() => { st.close?.(); reject(new Error('timeout')); }, timeoutMs);
        st.on('data', (d) => { out += d; });
        st.on('close', () => { clearTimeout(timer); resolve(out); });
      }, reject);
    });
  }

  _conn(tabId) {
    const c = this.conns.get(tabId);
    if (!c) throw new Error('Not connected — click Connect first');
    return c;
  }

  _progress(jobId) {
    let last = 0;
    return (p) => {
      const now = Date.now();
      if (p.file && now - last < 100) return; // throttle; always send the final update
      last = now;
      this.deps.send('scp:progress', { jobId, ...p });
    };
  }

  async _run(jobId, fn) {
    const signal = { cancelled: false };
    this.jobs.set(jobId, signal);
    try {
      return await fn(signal);
    } catch (e) {
      throw new Error(signal.cancelled ? 'Cancelled' : e.message);
    } finally {
      this.jobs.delete(jobId);
    }
  }

  upload(tabId, jobId, localPaths, remoteDir, opts = {}) {
    const conn = this._conn(tabId);
    return this._run(jobId, (signal) => scp.upload((c) => conn.exec(c), localPaths, remoteDir || '.', {
      preserve: opts.preserve !== false, signal, onProgress: this._progress(jobId),
    }));
  }

  download(tabId, jobId, remotePath, localDir, opts = {}) {
    const conn = this._conn(tabId);
    return this._run(jobId, (signal) => scp.download((c) => conn.exec(c), remotePath, localDir, {
      preserve: opts.preserve !== false, signal, onProgress: this._progress(jobId),
    }));
  }

  cancel(jobId) {
    const s = this.jobs.get(jobId);
    if (!s) return;
    s.cancelled = true;
    try { s.stream?.close?.(); s.stream?.destroy?.(); } catch { /* already closed */ }
  }

  close(tabId) {
    const c = this.conns.get(tabId);
    if (c) { this.conns.delete(tabId); c.close(); }
  }

  closeAll() { for (const id of [...this.conns.keys()]) this.close(id); }
}

module.exports = { ScpService };
