// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * SSH key tools: create a key pair in ~/.ssh, list public keys, and install a public key on a
 * server (what ssh-copy-id does) so later logins need no password.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils } = require('ssh2');

const KEY_TYPES = { ed25519: { type: 'ed25519' }, 'rsa-4096': { type: 'rsa', bits: 4096 }, 'rsa-3072': { type: 'rsa', bits: 3072 }, 'ecdsa-256': { type: 'ecdsa', bits: 256 } };
// One OpenSSH public key line. The comment can't contain quotes or newlines (it goes into a shell command).
const PUBKEY_RE = /^((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+) ([A-Za-z0-9+/]+={0,3})(?: ([^'"\\\n\r`$]{0,200}))?$/;

const sshDir = (home = os.homedir()) => path.join(home, '.ssh');

/** SHA256 fingerprint, as shown by ssh-keygen -l. */
function fingerprint(b64) {
  return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
}

function parsePublicKey(text) {
  const m = PUBKEY_RE.exec(String(text).trim());
  if (!m) return null;
  return { line: m[3] ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${m[2]}`, type: m[1], comment: m[3] || '', fingerprint: fingerprint(m[2]) };
}

/**
 * Create a key pair. `name` is a file name inside ~/.ssh (no paths); existing files are never replaced.
 * @returns {{ privateKey: string, publicKey: string, line: string, fingerprint: string }}
 */
function generateKey({ name, kind = 'ed25519', passphrase = '', comment = '' }, home) {
  const spec = KEY_TYPES[kind];
  if (!spec) throw new Error(`Unknown key type ${kind}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name || '') || name.startsWith('.')) throw new Error('Use a simple file name such as id_ed25519_work (letters, digits, . _ -)');
  if (/[\n\r'"`$\\]/.test(comment)) throw new Error('The comment cannot contain quotes, $ or backslashes');
  const dir = sshDir(home);
  const privateKey = path.join(dir, name);
  const publicKey = `${privateKey}.pub`;
  if (fs.existsSync(privateKey) || fs.existsSync(publicKey)) throw new Error(`${privateKey} already exists. Choose another name.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const opts = { comment: comment || `${os.userInfo().username}@${os.hostname()}` };
  if (spec.bits) opts.bits = spec.bits;
  if (passphrase) Object.assign(opts, { passphrase, cipher: 'aes256-ctr', rounds: 16 });
  const pair = utils.generateKeyPairSync(spec.type, opts);
  fs.writeFileSync(privateKey, pair.private, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(publicKey, pair.public + '\n', { mode: 0o644, flag: 'wx' });
  const parsed = parsePublicKey(pair.public);
  return { privateKey, publicKey, line: parsed.line, fingerprint: parsed.fingerprint };
}

/** Public keys in ~/.ssh. */
function listPublicKeys(home) {
  const dir = sshDir(home);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.pub')); } catch { return []; }
  return names.flatMap((f) => {
    try {
      const k = parsePublicKey(fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0]);
      if (!k) return [];
      const priv = path.join(dir, f.slice(0, -4));
      return [{ file: path.join(dir, f), privateKey: fs.existsSync(priv) ? priv : '', ...k }];
    } catch { return []; }
  });
}

/** Shell command that appends the key to ~/.ssh/authorized_keys once, with safe permissions. */
function installCommand(pubLine) {
  const k = parsePublicKey(pubLine);
  if (!k) throw new Error('Not a valid OpenSSH public key');
  const q = `'${k.line}'`; // PUBKEY_RE rules out quotes, so single-quoting is safe
  return `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && `
    + `if grep -qF ${q} ~/.ssh/authorized_keys; then echo TERMCRAFT_KEY_PRESENT; else printf '%s\\n' ${q} >> ~/.ssh/authorized_keys && echo TERMCRAFT_KEY_ADDED; fi`;
}

module.exports = { generateKey, listPublicKeys, parsePublicKey, installCommand, KEY_TYPES };
