// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Telnet protocol state machine (RFC 854) with option negotiation for BINARY(0), ECHO(1),
//! SGA(3), TTYPE(24), NAWS(31). Unknown options are refused.

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;
pub const BRK: u8 = 243;
pub const OPT_BINARY: u8 = 0;
pub const OPT_ECHO: u8 = 1;
pub const OPT_SGA: u8 = 3;
pub const OPT_TTYPE: u8 = 24;
pub const OPT_NAWS: u8 = 31;
const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Clone, Copy, PartialEq)]
enum State {
    Data,
    Iac,
    Opt,
    Sb,
    SbIac,
}

pub struct TelnetParser {
    term_type: String,
    state: State,
    sb_buf: Vec<u8>,
    pub naws_enabled: bool,
    pub remote_echo: bool,
    cmd: u8,
    pub cols: u16,
    pub rows: u16,
    /// Bytes to send to the socket (negotiation replies), drained by the caller.
    pub out: Vec<u8>,
}

impl TelnetParser {
    pub fn new(term_type: &str, cols: u16, rows: u16) -> Self {
        TelnetParser {
            term_type: term_type.to_string(),
            state: State::Data,
            sb_buf: Vec::new(),
            naws_enabled: false,
            remote_echo: false,
            cmd: 0,
            cols,
            rows,
            out: Vec::new(),
        }
    }

    /// Initial offers sent right after the TCP connection opens.
    pub fn start(&mut self) {
        self.send(WILL, OPT_TTYPE);
        self.send(WILL, OPT_NAWS);
        self.send(DO, OPT_SGA);
        self.send(DO, OPT_ECHO);
    }

    fn send(&mut self, cmd: u8, opt: u8) {
        self.out.extend_from_slice(&[IAC, cmd, opt]);
    }

    /// Escape IAC bytes in outgoing user data.
    pub fn escape(buf: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(buf.len());
        for &b in buf {
            out.push(b);
            if b == IAC {
                out.push(IAC);
            }
        }
        out
    }

    pub fn send_window_size(&mut self) {
        if !self.naws_enabled {
            return;
        }
        let bytes = [(self.cols >> 8) as u8, (self.cols & 255) as u8, (self.rows >> 8) as u8, (self.rows & 255) as u8];
        self.out.extend_from_slice(&[IAC, SB, OPT_NAWS]);
        for b in bytes {
            self.out.push(b);
            if b == IAC {
                self.out.push(IAC);
            }
        }
        self.out.extend_from_slice(&[IAC, SE]);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.send_window_size();
    }

    /// Feed bytes from the socket; returns the application data.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut data = Vec::with_capacity(chunk.len());
        for &b in chunk {
            match self.state {
                State::Data => {
                    if b == IAC {
                        self.state = State::Iac
                    } else {
                        data.push(b)
                    }
                }
                State::Iac => {
                    if b == IAC {
                        data.push(IAC);
                        self.state = State::Data;
                    } else if b == SB {
                        self.state = State::Sb;
                        self.sb_buf.clear();
                    } else if (WILL..=DONT).contains(&b) {
                        self.cmd = b;
                        self.state = State::Opt;
                    } else {
                        self.state = State::Data; // NOP, GA, AYT, etc.
                    }
                }
                State::Opt => {
                    self.negotiate(self.cmd, b);
                    self.state = State::Data;
                }
                State::Sb => {
                    if b == IAC {
                        self.state = State::SbIac
                    } else {
                        self.sb_buf.push(b)
                    }
                }
                State::SbIac => {
                    if b == SE {
                        let buf = std::mem::take(&mut self.sb_buf);
                        self.subneg(&buf);
                        self.state = State::Data;
                    } else {
                        self.sb_buf.push(b);
                        self.state = State::Sb;
                    }
                }
            }
        }
        data
    }

    fn negotiate(&mut self, cmd: u8, opt: u8) {
        match cmd {
            DO => {
                if opt == OPT_TTYPE || opt == OPT_BINARY || opt == OPT_SGA {
                    self.send(WILL, opt);
                } else if opt == OPT_NAWS {
                    self.naws_enabled = true;
                    self.send(WILL, opt);
                    self.send_window_size();
                } else {
                    self.send(WONT, opt);
                }
            }
            WILL => {
                if opt == OPT_ECHO {
                    self.remote_echo = true;
                    self.send(DO, opt);
                } else if opt == OPT_SGA || opt == OPT_BINARY {
                    self.send(DO, opt);
                } else {
                    self.send(DONT, opt);
                }
            }
            DONT => {
                if opt == OPT_NAWS {
                    self.naws_enabled = false;
                }
                self.send(WONT, opt);
            }
            WONT => {
                if opt == OPT_ECHO {
                    self.remote_echo = false;
                }
                self.send(DONT, opt);
            }
            _ => {}
        }
    }

    fn subneg(&mut self, buf: &[u8]) {
        if buf.first() == Some(&OPT_TTYPE) && buf.get(1) == Some(&TTYPE_SEND) {
            self.out.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            self.out.extend_from_slice(self.term_type.to_uppercase().as_bytes());
            self.out.extend_from_slice(&[IAC, SE]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn negotiation_ttype_naws_iac_escaping() {
        let mut p = TelnetParser::new("xterm", 100, 30);
        let data = p.feed(&[IAC, DO, OPT_NAWS, 65, 66, IAC, IAC, IAC, SB, OPT_TTYPE, 1, IAC, SE, 67]);
        assert_eq!(data, vec![65, 66, 255, 67]);
        assert!(contains(&p.out, &[IAC, WILL, OPT_NAWS]));
        assert!(contains(&p.out, &[IAC, SB, OPT_NAWS, 0, 100, 0, 30, IAC, SE]));
        assert!(contains(&p.out, b"XTERM"));
        assert_eq!(TelnetParser::escape(&[1, 255, 2]), vec![1, 255, 255, 2]);
    }

    #[test]
    fn sequences_split_across_chunks() {
        let mut p = TelnetParser::new("xterm", 80, 24);
        let mut data = p.feed(&[72, IAC]);
        data.extend(p.feed(&[WILL]));
        data.extend(p.feed(&[OPT_ECHO, 105]));
        assert_eq!(data, b"Hi");
        assert!(p.remote_echo);
    }
}
