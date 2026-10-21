// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// End-to-end: connect to a local SSH server, save the login at the prompts, reconnect with no prompts.
// Run: npm run test:e2e -- save-login
'use strict';
const fs = require('fs');
const path = require('path');
const { Server, utils } = require('ssh2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const server = new Server({ hostKeys: [require('../keygen').testHostKey()] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a && a());
      session.on('window-change', (a) => a && a());
      session.on('shell', (a) => { const st = a(); st.write('Welcome, tester\r\n$ '); st.on('data', (d) => st.write(d)); });
    }));
    client.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = async function smoke(win, { store, control }) {
  const out = process.env.TERMCRAFT_SHOTS || path.join(require('os').tmpdir(), 'termcraft-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(`Promise.resolve(${code}).then((r) => (r && typeof r === 'object' ? null : r))`);
  const shot = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('[smoke] shot', name); };
  const check = (label, ok) => console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  const modalTitle = () => js(`document.querySelector('.modal-header span')?.textContent || ''`);
  const waitModal = async (re) => { for (let i = 0; i < 50; i++) { if (re.test(await modalTitle())) return true; await sleep(100); } return false; };

  const server = await startServer();
  const port = server.address().port;
  win.setSize(1280, 800);
  await sleep(800);
  await js(`localStorage.removeItem('termcraft.saveLogin')`);
  await js(`void window.termcraft.openSession({ name: '127.0.0.1', protocol: 'ssh2', host: '127.0.0.1', port: ${port}, auth: { methods: ['password'], useAgent: false } })`);

  check('username prompt shown', await waitModal(/Username/));
  await js(`(() => { const i = document.querySelector('.modal input[type=text]'); i.value = 'tester'; })()`);
  check('username prompt has no save option', !(await js(`!!document.querySelector('.save-login')`)));
  await shot('01-username');
  await js(`document.querySelector('.modal-footer .primary').click()`);

  check('host key prompt shown', await waitModal(/Host Key/));
  await js(`document.querySelector('.modal-footer .primary').click()`);

  check('password prompt shown', await waitModal(/Password/));
  check('password prompt offers "Save login"', /Save login/.test(await js(`document.querySelector('.save-login')?.textContent || ''`)));
  await js(`document.querySelector('.save-login input').click()`);
  await js(`document.querySelector('.modal input[type=password]').value = 'secret'`);
  await shot('02-password-save');
  await js(`document.querySelector('.modal-footer .primary').click()`);
  await sleep(1500);

  check('connected', (await js(`window.termcraft.active.state`)) === 'connected');
  const saved = (await store.getTree()).sessions.find((s) => s.host === '127.0.0.1' && s.port === port);
  check('session saved with username', saved?.username === 'tester');
  check('password saved', saved?.auth.hasPassword === true);
  const raw = fs.readFileSync(store.files.sessions, 'utf8');
  // Linux without a keyring (e.g. CI) uses the documented fallback; everywhere else it must be the keychain.
  const keyring = process.platform !== 'linux' || (await control.ipc('app:info')).encryption;
  check(`password ${keyring ? 'encrypted with the keychain' : 'stored with the no-keyring fallback'} and not in plain text`,
    raw.includes(keyring ? '"enc:' : '"b64:') && !raw.includes('secret'));
  check('tab now uses saved session', (await js(`window.termcraft.active.session.id`)) === saved?.id);
  await shot('03-connected-saved');

  // Reconnect: must not prompt for anything.
  await js(`window.termcraft.active.disconnect()`);
  await sleep(500);
  await js(`void window.termcraft.active.connect()`);
  await sleep(1500);
  check('reconnected without any prompt', (await modalTitle()) === '' && (await js(`window.termcraft.active.state`)) === 'connected');

  // A brand-new tab from the Session Manager entry also connects silently.
  await js(`void window.termcraft.openSession(window.termcraft.tree.sessions.find((s) => s.id === '${saved?.id}'))`);
  await sleep(1500);
  check('new tab from saved session connects silently', (await modalTitle()) === '' && (await js(`window.termcraft.active.state`)) === 'connected');
  await shot('04-second-tab');
  server.close();
};
