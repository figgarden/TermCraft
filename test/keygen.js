// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
// A host key for test servers. Uses the checked generator, because ssh2's own occasionally
// produces an unreadable Ed25519 key (see src/main/ssh-keys.js).
const { generatePair } = require('../src/main/ssh-keys');

module.exports = { testHostKey: () => generatePair('ed25519').private };
