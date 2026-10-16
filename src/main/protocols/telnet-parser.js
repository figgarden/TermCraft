// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
'use strict';
/**
 * Telnet protocol state machine (RFC 854) with option negotiation for
 * BINARY(0), ECHO(1), SGA(3), TTYPE(24), NAWS(31). Unknown options are refused.
 */
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 };
const TTYPE_IS = 0, TTYPE_SEND = 1;

class TelnetParser {
  /**
   * @param {object} opts
   * @param {(buf: Buffer) => void} opts.send   raw bytes to the socket
   * @param {(buf: Buffer) => void} opts.data   decoded application data
   * @param {string} opts.termType
   * @param {() => [number, number]} opts.size  [cols, rows]
   */
  constructor({ send, data, termType = 'xterm', size = () => [80, 24] }) {
    this.sendRaw = send;
    this.emitData = data;
    this.termType = termType;
    this.size = size;
    this.state = 'data';
    this.sbBuf = [];
    this.nawsEnabled = false;
    this.remoteEcho = false;
    this.cmd = 0;
  }

  /** Initial offers sent right after the TCP connection opens. */
  start() {
    this._send(WILL, OPT.TTYPE);
    this._send(WILL, OPT.NAWS);
    this._send(DO, OPT.SGA);
    this._send(DO, OPT.ECHO);
  }

  _send(cmd, opt) { this.sendRaw(Buffer.from([IAC, cmd, opt])); }

  /** Escape IAC bytes in outgoing user data. */
  static escape(buf) {
    if (!buf.includes(IAC)) return buf;
    const out = [];
    for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC); }
    return Buffer.from(out);
  }

  sendWindowSize() {
    if (!this.nawsEnabled) return;
    const [cols, rows] = this.size();
    const bytes = [cols >> 8, cols & 255, rows >> 8, rows & 255];
    const body = [];
    for (const b of bytes) { body.push(b); if (b === IAC) body.push(IAC); }
    this.sendRaw(Buffer.from([IAC, SB, OPT.NAWS, ...body, IAC, SE]));
  }

  feed(chunk) {
    const out = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else out.push(b);
          break;
        case 'iac':
          if (b === IAC) { out.push(IAC); this.state = 'data'; }
          else if (b === SB) { this.state = 'sb'; this.sbBuf = []; }
          else if (b >= WILL && b <= DONT) { this.cmd = b; this.state = 'opt'; }
          else this.state = 'data'; // NOP, GA, AYT, etc.
          break;
        case 'opt':
          this._negotiate(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sbiac';
          else this.sbBuf.push(b);
          break;
        case 'sbiac':
          if (b === SE) { this._subneg(this.sbBuf); this.state = 'data'; }
          else { this.sbBuf.push(b); this.state = 'sb'; }
          break;
      }
    }
    if (out.length) this.emitData(Buffer.from(out));
  }

  _negotiate(cmd, opt) {
    if (cmd === DO) {
      if (opt === OPT.TTYPE || opt === OPT.BINARY || opt === OPT.SGA) this._send(WILL, opt);
      else if (opt === OPT.NAWS) { this.nawsEnabled = true; this._send(WILL, opt); this.sendWindowSize(); }
      else this._send(WONT, opt);
    } else if (cmd === WILL) {
      if (opt === OPT.ECHO) { this.remoteEcho = true; this._send(DO, opt); }
      else if (opt === OPT.SGA || opt === OPT.BINARY) this._send(DO, opt);
      else this._send(DONT, opt);
    } else if (cmd === DONT) {
      if (opt === OPT.NAWS) this.nawsEnabled = false;
      this._send(WONT, opt);
    } else if (cmd === WONT) {
      if (opt === OPT.ECHO) this.remoteEcho = false;
      this._send(DONT, opt);
    }
  }

  _subneg(buf) {
    if (buf[0] === OPT.TTYPE && buf[1] === TTYPE_SEND) {
      this.sendRaw(Buffer.concat([
        Buffer.from([IAC, SB, OPT.TTYPE, TTYPE_IS]),
        Buffer.from(this.termType.toUpperCase(), 'ascii'),
        Buffer.from([IAC, SE]),
      ]));
    }
  }
}

module.exports = { TelnetParser, IAC, DO, DONT, WILL, WONT, SB, SE, OPT };
