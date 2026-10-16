// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Answers in-band "Username:" / "Password:" prompts for Telnet, Rlogin and serial consoles
 * (routers, switches, console servers) with the session's login or its shared credential.
 * Each prompt is answered once, and only during the first two minutes of the connection, so a
 * later "Password:" (e.g. from passwd or enable) is never answered automatically.
 */
const USER_PROMPT = /(?:^|[\s\r\n])(?:user ?name|login|user)\s*:\s*$/i;
const PASS_PROMPT = /(?:^|[\s\r\n])pass(?:word|code)?\s*:\s*$/i;
const PROTOCOLS = new Set(['telnet', 'rlogin', 'serial']);
const WINDOW_MS = 120000;

/** @returns {null | { feed(plainText: string): string | null }} */
function createAutoLogin(session, now = Date.now) {
  if (!PROTOCOLS.has(session.protocol) || session.auth?.autoLogin === false) return null;
  const username = session.username || '';
  const password = session.auth?.password || '';
  if (!username && !password) return null;
  const until = now() + WINDOW_MS;
  // Rlogin sends the username in its handshake, so only the password prompt applies there.
  let userDone = !username || session.protocol === 'rlogin';
  let passDone = !password;
  let tail = '';
  return {
    get done() { return (userDone && passDone) || now() > until; },
    /** Feed ANSI-stripped output; returns text to send, or null. */
    feed(text) {
      if (this.done) return null;
      tail = (tail + text).slice(-200);
      if (!userDone && USER_PROMPT.test(tail)) { userDone = true; tail = ''; return username + '\r'; }
      if (!passDone && PASS_PROMPT.test(tail)) { passDone = true; tail = ''; return password + '\r'; }
      return null;
    },
  };
}

module.exports = { createAutoLogin };
