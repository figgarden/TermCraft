// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Remote desktops.
 *
 * VNC: the renderer embeds noVNC, which speaks RFB over a WebSocket. VncBridge runs a private
 * WebSocket server on 127.0.0.1 (random port, random per-tab token) and pipes each connection to
 * the VNC server — directly, or through an SSH tunnel when the session says so.
 *
 * RDP: there is no GPL-compatible embeddable RDP client, so RdpService opens the optional SSH
 * tunnel and launches the platform's own client (Windows App / Microsoft Remote Desktop on macOS,
 * mstsc on Windows, xfreerdp on Linux) with a generated .rdp file or arguments.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { SshConnection } = require('./protocols/ssh');
const { buildArgv } = require('./security');

/**
 * Open the session's SSH tunnel, if it has one. Returns { ssh, via, dial(host, port) => Promise<Duplex> }.
 * Without a tunnel, dial() opens a plain TCP connection.
 */
async function openRoute(store, session, prompt) {
  const tunnelId = session.tunnel?.sshSessionId;
  if (!tunnelId) {
    return {
      via: '',
      ssh: null,
      dial: (host, port) => new Promise((resolve, reject) => {
        const sock = net.connect({ host, port }, () => { sock.removeListener('error', reject); resolve(sock); });
        sock.once('error', reject);
      }),
    };
  }
  const sshCfg = store.resolveSession(tunnelId);
  const ssh = new SshConnection({ ...sshCfg, forwards: [] }, { store, mode: 'tunnel', prompt });
  await ssh.connect();
  return {
    via: sshCfg.name || sshCfg.host,
    ssh,
    dial: (host, port) => new Promise((resolve, reject) =>
      ssh.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))),
  };
}

class VncBridge {
  /** @param {{ store, request, send }} deps */
  constructor(deps) {
    this.deps = deps;
    this.routes = new Map(); // token -> { tabId, route, host, port }
    this.server = null;
    this.port = 0;
  }

  async _ensureServer() {
    if (this.server) return;
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
      perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.port = this.server.address().port;
    this.server.on('connection', (ws, req) => this._onConnection(ws, req));
  }

  async _onConnection(ws, req) {
    const token = (req.url || '').replace(/^\/vnc\//, '');
    const entry = this.routes.get(token);
    if (!entry) { ws.close(1008, 'Unknown session'); return; }
    let sock;
    try {
      sock = await entry.route.dial(entry.host, entry.port);
    } catch (e) {
      this.deps.send('remote:status', entry.tabId, { error: `Cannot reach ${entry.host}:${entry.port}: ${e.message}` });
      ws.close(1011, 'Connection failed');
      return;
    }
    entry.sockets.add(sock);
    sock.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on('message', (d) => sock.write(d));
    const done = () => { entry.sockets.delete(sock); try { sock.destroy(); } catch { /* closed */ } try { ws.close(); } catch { /* closed */ } };
    sock.on('close', done);
    sock.on('error', done);
    ws.on('close', done);
    ws.on('error', done);
  }

  /**
   * Prepare a VNC connection for a tab. Returns the WebSocket URL for noVNC plus the stored
   * login (noVNC performs RFB authentication in the renderer).
   */
  async open(tabId, sessionRef) {
    this.close(tabId);
    const session = this.deps.store.resolveSession(sessionRef);
    if (session.protocol !== 'vnc') throw new Error('Not a VNC session');
    await this._ensureServer();
    const route = await openRoute(this.deps.store, session, (req) => this.deps.request('prompt', { ...req, tabId }));
    const token = crypto.randomBytes(24).toString('hex');
    const port = Number(session.port) || 5900;
    this.routes.set(token, { tabId, route, host: session.host, port, sockets: new Set() });
    return {
      url: `ws://127.0.0.1:${this.port}/vnc/${token}`,
      host: session.host,
      port,
      via: route.via,
      username: session.username || '',
      password: session.auth?.password || '',
    };
  }

  close(tabId) {
    for (const [token, e] of this.routes) {
      if (e.tabId !== tabId) continue;
      for (const s of e.sockets) s.destroy();
      e.route.ssh?.close();
      this.routes.delete(token);
    }
  }

  closeAll() {
    for (const e of this.routes.values()) e.route.ssh?.close();
    this.routes.clear();
    this.server?.close();
    this.server = null;
  }
}

// ---- RDP ------------------------------------------------------------------------------

/** Contents of a .rdp file for the given target and options. */
function rdpFile({ host, port, username, domain, rdp = {} }) {
  const lines = [
    `full address:s:${host}:${port}`,
    username ? `username:s:${domain ? `${domain}\\${username}` : username}` : null,
    `screen mode id:i:${rdp.fullscreen ? 2 : 1}`,
    rdp.fullscreen ? null : `desktopwidth:i:${Number(rdp.width) || 1600}`,
    rdp.fullscreen ? null : `desktopheight:i:${Number(rdp.height) || 1000}`,
    `use multimon:i:${rdp.multimon ? 1 : 0}`,
    `administrative session:i:${rdp.admin ? 1 : 0}`,
    'session bpp:i:32',
    'dynamic resolution:i:1',
    'redirectclipboard:i:1',
    'prompt for credentials:i:0',
    'authentication level:i:2',
  ];
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}

/** xfreerdp arguments. The password, if any, is sent on stdin (/from-stdin), never on the command line. */
function freerdpArgs({ host, port, username, domain, rdp = {} }, hasPassword) {
  const args = [`/v:${host}:${port}`, '/cert:tofu', '+clipboard', '/dynamic-resolution'];
  if (username) args.push(`/u:${username}`);
  if (domain) args.push(`/d:${domain}`);
  if (rdp.fullscreen) args.push('/f');
  else args.push(`/size:${Number(rdp.width) || 1600}x${Number(rdp.height) || 1000}`);
  if (rdp.multimon) args.push('/multimon');
  if (rdp.admin) args.push('/admin');
  if (hasPassword) args.push('/from-stdin');
  return args;
}

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

/** Find the platform's RDP client. */
function findRdpClient() {
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Windows App.app', '/Applications/Microsoft Remote Desktop.app']) {
      if (fs.existsSync(app)) return { kind: 'mac-app', app, name: path.basename(app, '.app') };
    }
    return null;
  }
  if (process.platform === 'win32') return { kind: 'mstsc', cmd: 'mstsc.exe', name: 'Remote Desktop Connection (mstsc)' };
  for (const c of ['xfreerdp3', 'xfreerdp', 'wlfreerdp']) {
    const p = which(c);
    if (p) return { kind: 'freerdp', cmd: p, name: c };
  }
  const remmina = which('remmina');
  if (remmina) return { kind: 'remmina', cmd: remmina, name: 'Remmina' };
  return null;
}

class RdpService {
  /** @param {{ store, request, send }} deps */
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map(); // tabId -> { server, route, child, file }
    this.dir = path.join(os.tmpdir(), 'termcraft-rdp');
  }

  /** Open the tunnel (if any) and launch the RDP client. */
  async launch(tabId, sessionRef) {
    this.close(tabId);
    const session = this.deps.store.resolveSession(sessionRef);
    if (session.protocol !== 'rdp') throw new Error('Not an RDP session');
    const custom = (this.deps.store.getSettings().rdpClient || '').trim();
    const client = custom ? { kind: 'custom', name: 'custom command' } : findRdpClient();
    if (!client) {
      throw new Error({
        darwin: 'No RDP client found. Install "Windows App" from the Mac App Store (it replaces Microsoft Remote Desktop), or set a custom RDP client in Global Options.',
        linux: 'No RDP client found. Install FreeRDP (e.g. "sudo apt install freerdp3-x11" or "freerdp2-x11") or Remmina, or set a custom RDP client in Global Options.',
      }[process.platform] || 'No RDP client found. Set a custom RDP client in Global Options.');
    }

    const entry = { server: null, route: null, child: null, file: null };
    this.sessions.set(tabId, entry);
    const remotePort = Number(session.port) || 3389; // the RDP host's port (never reassigned)
    let host = session.host;
    let port = remotePort; // what the client connects to: the host, or the local end of the tunnel
    let via = '';
    if (session.tunnel?.sshSessionId) {
      // Local listener → SSH → RDP host. The client connects to 127.0.0.1:<local port>.
      entry.route = await openRoute(this.deps.store, session, (req) => this.deps.request('prompt', { ...req, tabId }));
      via = entry.route.via;
      entry.server = net.createServer(async (sock) => {
        try {
          const remote = await entry.route.dial(session.host, remotePort);
          // pipe() ends each side when the other ends, flushing data in flight; only errors tear down hard.
          sock.pipe(remote).pipe(sock);
          const abort = () => { sock.destroy(); remote.destroy?.(); };
          sock.on('error', abort);
          remote.on('error', abort);
        } catch (e) {
          sock.destroy();
          this.deps.send('remote:status', tabId, { error: `Tunnel to ${session.host}:${remotePort} failed: ${e.message}` });
        }
      });
      await new Promise((resolve, reject) => entry.server.listen(0, '127.0.0.1', resolve).once('error', reject));
      host = '127.0.0.1';
      port = entry.server.address().port;
    }

    const target = { host, port, username: session.username, domain: session.rdp?.domain || '', rdp: session.rdp || {} };
    const password = session.auth?.password || '';
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    entry.file = path.join(this.dir, `${tabId}.rdp`);
    fs.writeFileSync(entry.file, rdpFile(target), { mode: 0o600 });

    let note = '';
    if (client.kind === 'custom') {
      // No shell: the template is split into argv first, so host/user values can't inject commands.
      const argv = buildArgv(custom, { file: entry.file, host, port, user: session.username || '' });
      if (!argv.length) throw new Error('The custom RDP client command is empty');
      entry.child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    } else if (client.kind === 'mac-app') {
      entry.child = spawn('open', ['-a', client.app, entry.file], { stdio: 'ignore' });
      note = `${client.name} will ask for the password (it does not accept one from other apps) and can save it in your keychain.`;
    } else if (client.kind === 'mstsc') {
      entry.child = spawn(client.cmd, [entry.file], { detached: true, stdio: 'ignore' });
      note = 'Remote Desktop Connection will ask for the password and can remember it.';
    } else if (client.kind === 'freerdp') {
      entry.child = spawn(client.cmd, freerdpArgs(target, !!password), { stdio: ['pipe', 'ignore', 'pipe'] });
      if (password) entry.child.stdin.end(password + '\n');
      else entry.child.stdin.end();
      let errText = '';
      entry.child.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
      entry.child.on('exit', (code) => this.deps.send('remote:status', tabId, { exited: true, code, error: code ? errText.trim().split('\n').pop() : '' }));
    } else if (client.kind === 'remmina') {
      entry.child = spawn(client.cmd, ['-c', entry.file], { detached: true, stdio: 'ignore' });
    }
    entry.child?.on('error', (e) => this.deps.send('remote:status', tabId, { error: `Could not start ${client.name}: ${e.message}` }));
    entry.child?.unref?.();
    return { client: client.name, host: session.host, port: remotePort, localPort: entry.server ? port : null, via, username: session.username, note };
  }

  close(tabId) {
    const e = this.sessions.get(tabId);
    if (!e) return;
    this.sessions.delete(tabId);
    e.server?.close();
    e.route?.ssh?.close();
    if (e.child && e.child.exitCode == null && process.platform === 'linux') { try { e.child.kill(); } catch { /* gone */ } }
    if (e.file) fs.rm(e.file, { force: true }, () => {});
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}

module.exports = { VncBridge, RdpService, rdpFile, freerdpArgs, findRdpClient, openRoute };
