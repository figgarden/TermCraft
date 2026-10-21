// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// A host key for the end-to-end tests' SSH servers. ssh2's generator occasionally (about 1 in 200
// Ed25519 keys) writes a private key it cannot read back, so a key is only used once it parses.
const { utils } = require('ssh2');

function testHostKey() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(pair.private);
    if (parsed && !(parsed instanceof Error)) return pair.private;
  }
  throw new Error('Could not create a test host key');
}

module.exports = { testHostKey };
