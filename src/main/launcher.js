// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * "Launch Application" buttons. The command is split into a program and its arguments and run
 * without a shell, so characters like ; | & $( ) ` are passed to the program as plain text.
 * Each distinct command must be approved once in a native dialog; approvals live in a file
 * only the main process writes, so an imported button bar or a compromised page cannot skip it.
 */
const fs = require('fs');
const { spawn: nodeSpawn } = require('child_process');
const { buildArgv, safeJsonParse } = require('./security');

/** Split a button command into argv; throws a readable error if it can't be run. */
function launchArgv(command) {
  const text = String(command ?? '');
  if (/[\0\r\n]/.test(text)) throw new Error('The command contains a line break');
  const argv = buildArgv(text, {});
  if (!argv.length || !argv[0]) throw new Error('The command is empty');
  return argv;
}

class Launcher {
  /**
   * @param {string} file approvals file (JSON array of exact command strings)
   * @param {{ confirm: (argv: string[], command: string) => Promise<'once'|'always'|false>, spawn?: Function, platform?: string }} deps
   */
  constructor(file, deps) {
    this.file = file;
    this.confirm = deps.confirm;
    this.spawn = deps.spawn || nodeSpawn;
    this.platform = deps.platform || process.platform;
    let list = [];
    try { list = safeJsonParse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    this.approved = new Set(Array.isArray(list) ? list.filter((c) => typeof c === 'string') : []);
  }

  isApproved(command) { return this.approved.has(command); }

  _approve(command) {
    this.approved.add(command);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.approved], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Run a command; resolves false if the user declined, throws if the program can't start. */
  async run(command) {
    const argv = launchArgv(command);
    if (this.platform === 'win32' && /\.(bat|cmd)$/i.test(argv[0])) {
      throw new Error(`Batch files can't be started directly. Use: cmd /c ${command}`);
    }
    if (!this.isApproved(command)) {
      const answer = await this.confirm(argv, command);
      if (!answer) return false;
      if (answer === 'always') this._approve(command);
    }
    const child = this.spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', shell: false });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `Program not found: ${argv[0]}` : `Could not start ${argv[0]}: ${e.message}`)));
    });
    child.unref();
    return true;
  }
}

module.exports = { Launcher, launchArgv };
