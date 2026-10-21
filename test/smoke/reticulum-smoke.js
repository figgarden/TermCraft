// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Reticulum (RNS) end-to-end, with the real tools on a private network built for the test:
// a transport node running an rnsh listener, an rncp listener on a second node, and a client
// config for TermCraft. Needs the Reticulum tools (pipx install rns rnsh); set TERMCRAFT_RNS_BIN to
// their folder if they're not on PATH. Run: npm run test:e2e -- reticulum
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBin() {
  const dirs = [process.env.TERMCRAFT_RNS_BIN, ...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.local', 'pipx', 'venvs', 'rnsh', 'bin')].filter(Boolean);
  return dirs.find((d) => fs.existsSync(path.join(d, 'rnsh')) && fs.existsSync(path.join(d, 'rncp')));
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function config(dir, iface) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config'), `[reticulum]\n  enable_transport = ${iface.server ? 'Yes' : 'No'}\n${iface.server ? '  respond_to_probes = Yes\n' : ''}  share_instance = No\n  panic_on_interface_error = No\n[logging]\n  loglevel = ${iface.server ? 4 : 2}\n[interfaces]\n${iface.server
    ? `  [[Test Server]]\n    type = TCPServerInterface\n    enabled = yes\n    listen_ip = 127.0.0.1\n    listen_port = ${iface.port}\n`
    : `  [[Test Client]]\n    type = TCPClientInterface\n    enabled = yes\n    target_host = 127.0.0.1\n    target_port = ${iface.port}\n`}`);
}

module.exports = async function smoke(win, { store, control }) {
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? JSON.stringify(r) : r))`);
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const rejected = (expr) => js(`(${expr}).then(() => '', (e) => e.message)`);
  const screen = () => js(`window.termcraft.active.screenLines().join('\\n')`);
  const waitScreen = async (re, ms = 40000) => { for (let i = 0; i < ms / 200; i++) { if (re.test(await screen())) return true; await sleep(200); } return false; };
  const modalTitle = () => js(`document.querySelector('.modal-header span')?.textContent || ''`);
  const waitModal = async (re) => { for (let i = 0; i < 50; i++) { if (re.test(await modalTitle())) return true; await sleep(100); } return false; };
  /** Fill the open "destination hash" dialog and press its main button. */
  const answer = async (fields) => {
    await js(`(() => { const f = ${JSON.stringify(fields)}; for (const [k, v] of Object.entries(f)) { const el = document.querySelector('.modal [data-path="' + k + '"]'); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } document.querySelector('.modal-footer .primary').click(); })()`);
  };

  if (process.platform === 'win32') { console.log('[smoke] PASS skipped on Windows (uses a POSIX shell listener)'); return; }
  const bin = findBin();
  if (!bin) { console.log('[smoke] PASS skipped: Reticulum tools not installed (pipx install rns && pipx install rnsh, or set TERMCRAFT_RNS_BIN)'); return; }

  // ---- a private Reticulum network ----------------------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termcraft-rns-'));
  const port = await freePort();
  config(path.join(root, 'server'), { server: true, port });
  config(path.join(root, 'files'), { port });
  config(path.join(root, 'client'), { port });
  config(path.join(root, 'exec'), { port });
  config(path.join(root, 'auth-shell'), { port });
  config(path.join(root, 'auth-files'), { port });
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'router1.cfg'), 'hostname router1\n');
  const procs = [];
  try {
    // Each listener gets an identity made with rnid, and its destination hash is computed from
    // it: the newer tools print nothing when their output isn't a terminal.
    const rnid = path.join(bin, 'rnid');
    const identities = {};
    const ident = (name) => {
      const f = path.join(root, `${name}.identity`);
      const r = spawnSync(rnid, ['-g', f], { encoding: 'utf8' });
      identities[f] = (/New identity <([0-9a-f]{32})>/.exec(`${r.stdout}${r.stderr}`) || [])[1];
      return f;
    };
    const destOf = (idFile, aspects) => {
      const r = spawnSync(rnid, ['-i', idFile, '-H', aspects], { encoding: 'utf8', timeout: 30000 });
      const m = /destination for this Identity is <([0-9a-f]{32})>/.exec(`${r.stdout}${r.stderr}`);
      if (!m) throw new Error(`rnid could not hash ${aspects}: ${r.stdout}${r.stderr}`);
      return m[1];
    };
    const start = (tool, args) => { const p = spawn(path.join(bin, tool), args, { stdio: 'ignore', env: { ...process.env, PYTHONUNBUFFERED: '1' } }); procs.push(p); return p; };
    // rns 1.x's rnsh takes the Reticulum config as --rnsconfig (-c is its own config); older rnsh uses -c.
    const rnshHelp = spawnSync(path.join(bin, 'rnsh'), ['--help'], { encoding: 'utf8' });
    const newRnsh = /--rnsconfig/.test(`${rnshHelp.stdout}${rnshHelp.stderr}`);
    const rnshConfigFor = (cfg) => (newRnsh ? ['--rnsconfig', path.join(root, cfg), '-c', path.join(root, `rnsh-${cfg}`)] : ['-c', path.join(root, cfg)]);
    const rnshConfig = rnshConfigFor('server');
    const shellId = ident('shell');
    const filesId = ident('files');
    const execId = ident('exec');
    start('rnsh', ['-l', ...rnshConfig, '-i', shellId, '-n', '-b', '5', '--', '/bin/sh']);
    start('rncp', ['--config', path.join(root, 'files'), '-i', filesId, '-l', '-n', '-F', '-j', inbox, '-s', inbox, '-b', '5']);
    // Listeners that only let in one identity (the usual setup), not anyone (-n).
    const clientId = ident('client');
    const clientHash = identities[clientId];
    const authShellId = ident('auth-shell');
    const authFilesId = ident('auth-files');
    const authInbox = path.join(root, 'auth-inbox');
    fs.mkdirSync(authInbox);
    start('rnsh', ['-l', ...rnshConfigFor('auth-shell'), '-i', authShellId, '-a', clientHash, '-b', '5', '--', '/bin/sh']);
    start('rncp', ['--config', path.join(root, 'auth-files'), '-i', authFilesId, '-l', '-a', clientHash, '-s', authInbox, '-b', '5']);
    const authShell = destOf(authShellId, 'rnsh');
    const authFiles = destOf(authFilesId, 'rncp.receive');
    const shell = { hash: destOf(shellId, 'rnsh') };
    const files = { hash: destOf(filesId, 'rncp.receive') };
    const exec = { hash: destOf(execId, 'rnx.execute') };
    // The transport node answers probes (rnprobe ≈ ping) on a destination of its own identity.
    const transportId = path.join(root, 'server', 'storage', 'transport_identity');
    for (let i = 0; i < 100 && !fs.existsSync(transportId); i++) await sleep(100);
    const probeHash = fs.existsSync(transportId) ? destOf(transportId, 'rnstransport.probe') : '';
    // rnx announces only once, at start: start it once the transport node is listening.
    await sleep(2000);
    start('rnx', ['--config', path.join(root, 'exec'), '-i', execId, '-l', '-n']);
    await sleep(4000); // let the listeners come up and announce
    const HASH = shell.hash;

    // ---- off by default: nothing Reticulum shows or runs ---------------------------------------
    await win.setSize(1280, 800);
    await sleep(500);
    check('Reticulum is off by default', (await store.getSettings()).reticulum?.enabled === false);
    await js(`void window.termcraft.sm.newSession('')`);
    await sleep(400);
    check('no RNSH protocol in the session editor while it is off', !(await js(`[...document.querySelectorAll('[data-path="protocol"] option')].some((o) => o.value === 'rnsh')`)));
    await js(`document.querySelector('.modal-footer button').click()`);
    await sleep(200);
    await js(`void window.termcraft.openSession({ name: 'x', protocol: 'rnsh', host: '${HASH}' })`);
    check('an rnsh session refuses to start while it is off', await waitScreen(/Reticulum is turned off/, 10000) || console.log('[debug]', await screen()));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);

    // ---- the inconspicuous toggle in Settings → General -------------------------------------------
    await js(`void window.termcraft.dispatch('globalOptions')`);
    await waitModal(/^Settings/);
    check('Settings → General has the Reticulum toggle, details hidden', await js(`!!document.querySelector('[data-path="reticulum.enabled"]') && document.querySelector('.rns-only').hidden`));
    await js(`(() => { const b = document.querySelector('[data-path="reticulum.enabled"]'); b.checked = true; b.dispatchEvent(new Event('change')); const d = document.querySelector('[data-path="reticulum.binDir"]'); d.value = ${JSON.stringify(bin)}; d.dispatchEvent(new Event('change')); document.querySelector('[data-path="reticulum.configDir"]').value = ${JSON.stringify(path.join(root, 'client'))}; })()`);
    let found = '';
    for (let i = 0; i < 30 && !/Found: rnsh/.test(found); i++) { await sleep(200); found = await js(`document.querySelector('.rns-tools').textContent`); }
    check(`turning it on shows which tools were found (${found})`, /Found: rnsh, rncp, rnx, rnstatus, rnpath, rnprobe/.test(found));
    await js(`document.querySelector('.modal-footer .primary').click()`);
    await sleep(400);
    check('the setting is saved', (await store.getSettings()).reticulum?.enabled === true);
    check('quick connect now mentions hashes', /destination hash/.test(await js(`document.querySelector('.quick-host').placeholder`)));

    // ---- rnsh ≈ ssh: quick connect by hash ------------------------------------------------------
    await js(`(() => { const q = document.querySelector('.quick-host'); q.value = '<${HASH}>'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    let state = '';
    for (let i = 0; i < 100 && state !== 'connected'; i++) { await sleep(200); state = await js(`window.termcraft.active.state`); }
    check('quick connect by destination hash opens an rnsh tab', state === 'connected' && (await js(`window.termcraft.active.cfg.protocol`)) === 'rnsh');
    // Wait for the remote shell, then use it like an SSH session.
    for (let i = 0; i < 6 && !(await waitScreen(/rns-42/, 5000)); i++) await js(`window.termcraft.active.send("echo rns-$((6*7))\\r")`);
    check('typing in the rnsh tab runs commands on the remote shell', /rns-42/.test(await screen()));
    check('status bar shows the destination', (await js(`document.querySelector('.status-bar')?.textContent || ''`)).includes(HASH));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);

    // ---- saved RNSH session from the editor ----------------------------------------------------------
    await js(`void window.termcraft.sm.newSession('')`);
    await sleep(400);
    check('RNSH appears in the session editor', await js(`[...document.querySelectorAll('[data-path="protocol"] option')].some((o) => o.value === 'rnsh')`));
    await js(`(() => { const p = document.querySelector('[data-path="protocol"]'); p.value = 'rnsh'; p.dispatchEvent(new Event('change')); document.querySelector('[data-path="name"]').value = 'mesh node'; document.querySelector('[data-path="host"]').value = 'rnsh://${HASH.toUpperCase()}'; })()`);
    check('the host field becomes "Destination hash"', /Destination hash/.test(await js(`document.querySelector('[data-path="host"]').closest('.field').textContent`)));
    await js(`document.querySelector('.modal-footer .primary').click()`);
    await sleep(500);
    const saved = (await store.getTree()).sessions.find((s) => s.name === 'mesh node');
    check('saved with the hash normalized and no port', saved?.protocol === 'rnsh' && saved.host === HASH && saved.port === 0);
    check('the Session Manager marks it RNS', /RNS/.test(await js(`[...document.querySelectorAll('.node.session')].find((n) => n.textContent.includes('mesh node'))?.textContent || ''`)));

    // ---- tools: show interfaces, route lookup, identity -----------------------------------------------
    await js(`void window.termcraft.dispatch('rnsStatus')`);
    check('rnstatus shows the interfaces', await waitScreen(/Test Client[\s\S]*Status\s*:\s*Up/));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    await js(`void window.termcraft.dispatch('rnsPath')`);
    await waitModal(/rnpath/);
    await answer({ dest: HASH });
    check('rnpath finds the route and hop count', await waitScreen(/1 hop away/));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    await js(`void window.termcraft.dispatch('rnsIdentity')`);
    check('Show My rnsh Identity prints the identity hash', await waitScreen(/Identity\s*:\s*<[0-9a-f]{32}>/));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    await js(`void window.termcraft.dispatch('rnsPath')`);
    await waitModal(/rnpath/);
    await js(`(() => { document.querySelector('.modal [data-path="dest"]').value = '10.0.0.1'; document.querySelector('.modal-footer .primary').click(); })()`);
    await sleep(200);
    check('an IP is refused where a destination hash is needed', /32 hex digits/.test(await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ')`)) && /rnpath/.test(await modalTitle()));
    await js(`[...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === 'Cancel').click()`);

    // ---- rnx ≈ "ssh host command", rnprobe ≈ ping ----------------------------------------------------
    await js(`void window.termcraft.dispatch('rnsExec')`);
    await waitModal(/rnx/);
    await answer({ dest: exec.hash, command: 'echo rnx-ok' });
    const rnxOk = await waitScreen(/rnx-ok/);
    check('Run Remote Command (rnx) shows the remote output', rnxOk);
    if (!rnxOk) console.log('[debug] rnx screen:', JSON.stringify((await screen()).replace(/\s+/g, ' ').slice(-600)));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    if (probeHash) {
      await js(`void window.termcraft.dispatch('rnsProbe')`);
      await waitModal(/rnprobe/);
      await answer({ dest: probeHash, probes: 2 });
      check('Probe Destination (rnprobe) gets replies with round-trip times', await waitScreen(/Valid reply[\s\S]*Round-trip time/i));
      await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    } else check('the test transport node announced a probe responder', false);

    // ---- rncp ≈ scp: send and fetch -----------------------------------------------------------------
    const outFile = path.join(root, 'backup.cfg');
    fs.writeFileSync(outFile, 'interface Gi0/1\n description uplink\n');
    await control.mockDialogs([outFile]);
    await js(`void window.termcraft.dispatch('rnsSend')`);
    await waitModal(/rncp/);
    await answer({ dest: files.hash });
    for (let i = 0; i < 150 && !fs.existsSync(path.join(inbox, 'backup.cfg')); i++) await sleep(200);
    check('Send File over Reticulum delivers the file', fs.existsSync(path.join(inbox, 'backup.cfg')) && fs.readFileSync(path.join(inbox, 'backup.cfg'), 'utf8').includes('uplink'));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    const saveDir = path.join(root, 'fetched');
    fs.mkdirSync(saveDir);
    await control.mockDialogs([saveDir]);
    await js(`void window.termcraft.dispatch('rnsFetch')`);
    await waitModal(/rncp/);
    await js(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Browse…').click()`);
    await sleep(300);
    await answer({ dest: files.hash, remotePath: path.join(inbox, 'router1.cfg') });
    for (let i = 0; i < 150 && !fs.existsSync(path.join(saveDir, 'router1.cfg')); i++) await sleep(200);
    check('Fetch File over Reticulum saves into the chosen folder', fs.existsSync(path.join(saveDir, 'router1.cfg')));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);

    // ---- Run Commands works on RNSH sessions -------------------------------------------------------------
    const runs = path.join(root, 'runs');
    fs.mkdirSync(runs);
    await control.mockDialogs([runs]);
    const chosen = await js(`window.api.dialog.openDir({ title: 'x' })`);
    await js(`void window.termcraft.openBatch({ sessionIds: ['${saved?.id}'], commands: ['echo batch-$((2+2))'], concurrency: 1, timeoutSec: 30, outputDir: ${JSON.stringify(chosen)} })`);
    let report = '';
    for (let i = 0; i < 300 && !report; i++) {
      await sleep(200);
      const dir = fs.readdirSync(runs).map((d) => path.join(runs, d))[0];
      const f = dir && fs.readdirSync(dir).find((x) => x.endsWith('.txt'));
      if (f) report = fs.readFileSync(path.join(dir, f), 'utf8');
    }
    check('Run Commands on an RNSH session saves its output', /batch-4/.test(report) && report.includes(`rnsh ${HASH}`));

    // ---- identities and allow lists ------------------------------------------------------------------
    const waitState = async (want, ms = 60000) => { for (let i = 0; i < ms / 250; i++) { if (want.test(await js(`window.termcraft.active.state`))) return true; await sleep(250); } return false; };
    const authSession = await store.saveSession({ name: 'locked node', protocol: 'rnsh', host: authShell, port: 0, reticulum: { identity: clientId, timeout: 30 } });
    await js(`window.termcraft.reloadTree()`);
    await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.id === '${authSession.id}'))`);
    await waitState(/connected/);
    for (let i = 0; i < 6 && !(await waitScreen(/auth-ok/, 5000)); i++) await js(`window.termcraft.active.send("echo auth-$((1+0))k | tr 1 o\\r")`);
    check('a listener that allows only my identity lets the session identity in', /auth-ok/.test(await screen()));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    const strangerId = ident('stranger');
    await js(`void window.termcraft.openSession({ name: 'stranger', protocol: 'rnsh', host: '${authShell}', port: 0, reticulum: { identity: ${JSON.stringify(strangerId)}, timeout: 20 } })`);
    for (let i = 0; i < 3; i++) await js(`window.termcraft.active.send("echo should-not-run-$((40+2))\\r")`).catch(() => {});
    const refused = await waitState(/disconnected|failed/, 70000);
    check('an identity the listener does not allow is turned away (no remote shell)', refused && !/should-not-run-42/.test(await screen()));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);

    // ---- session options: remote command, logging ----------------------------------------------------
    const logFile = path.join(root, 'rnsh.log');
    await js(`void window.termcraft.openSession({ name: 'one command', protocol: 'rnsh', host: '${HASH}', port: 0, reticulum: { command: 'echo remote-command-ok', timeout: 30 }, logging: { enabled: true, path: ${JSON.stringify(logFile)} } })`);
    check('a session with a remote command runs it instead of a shell', await waitScreen(/remote-command-ok/));
    await waitState(/disconnected/, 30000);
    await sleep(300);
    check('…and the tab closes when it finishes, with the output logged', /remote-command-ok/.test(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);

    // ---- rncp with the identity from Settings to a listener that allows only it -------------------------
    await js(`window.termcraft.saveSettings({ reticulum: { identity: ${JSON.stringify(clientId)} } })`);
    const authFile = path.join(root, 'switch.cfg');
    fs.writeFileSync(authFile, 'hostname core-sw\n');
    await control.mockDialogs([authFile]);
    await js(`void window.termcraft.dispatch('rnsSend')`);
    await waitModal(/rncp/);
    await answer({ dest: authFiles });
    for (let i = 0; i < 150 && !fs.existsSync(path.join(authInbox, 'switch.cfg')); i++) await sleep(200);
    check('rncp uses the identity set in Settings (accepted by an allow-listed listener)', fs.existsSync(path.join(authInbox, 'switch.cfg')));
    await js(`window.termcraft.closeTab(window.termcraft.active, true)`);
    await js(`window.termcraft.saveSettings({ reticulum: { identity: '' } })`);

    // ---- host import --------------------------------------------------------------------------------------
    const parsed = JSON.parse(await js(`window.api.store.parseHosts(${JSON.stringify(`name,host,protocol\nmesh-a,<${HASH}>,rnsh\nmesh-bad,10.1.1.1,rnsh`)}, {})`));
    check('Import Hosts reads RNSH rows by destination hash and rejects IPs for them', parsed.rows.length === 1 && parsed.rows[0].host === HASH && parsed.errors.length === 1);

    // ---- security ------------------------------------------------------------------------------------------
    check('rncp cannot send a file that was not chosen', /not chosen/.test(await rejected(`window.api.conn.open('evil', { protocol: 'rntool', rntool: { tool: 'send', file: '/etc/hosts', dest: '${files.hash}' } }, 80, 24)`)));
    check('rncp fetch cannot save outside a chosen folder', /Choose the folder/.test(await rejected(`window.api.conn.open('evil2', { protocol: 'rntool', rntool: { tool: 'fetch', remotePath: 'x', saveDir: '/tmp', dest: '${files.hash}' } }, 80, 24)`)));
    // A tool tab that names some other program fails to start (the backend runs only Reticulum's).
    await js(`void window.termcraft.openSession({ name: 'evil', protocol: 'rntool', rntool: { tool: 'bash' } })`);
    check('only Reticulum programs can be started', await waitScreen(/Unknown Reticulum tool/, 5000));
    // ---- turning it off again -----------------------------------------------------------------------------
    await js(`window.termcraft.saveSettings({ reticulum: { enabled: false } })`);
    await js(`void window.termcraft.openSession({ name: 'off again', protocol: 'rnsh', host: '${HASH}', port: 0 })`);
    check('turning Reticulum off stops RNSH sessions again', await waitScreen(/Reticulum is turned off/, 10000));
  } finally {
    for (const p of procs) p.kill('SIGKILL'); // rncp ignores SIGTERM
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};

