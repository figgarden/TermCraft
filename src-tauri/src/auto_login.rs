// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Answers in-band "Username:" / "Password:" prompts for Telnet, Rlogin and serial consoles
//! (routers, switches, console servers) with the session's login or its shared credential.
//! Each prompt is answered once, and only during the first two minutes of the connection, so a
//! later "Password:" (e.g. from passwd or enable) is never answered automatically.

use crate::json::{at, str_at};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

static USER_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[\s\r\n])(?:user ?name|login|user)\s*:\s*$").unwrap());
static PASS_PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[\s\r\n])pass(?:word|code)?\s*:\s*$").unwrap());
const WINDOW: Duration = Duration::from_secs(120);

pub struct AutoLogin {
    username: String,
    password: String,
    until: Instant,
    user_done: bool,
    pass_done: bool,
    tail: String,
}

impl AutoLogin {
    pub fn new(session: &Value) -> Option<AutoLogin> {
        let protocol = str_at(session, &["protocol"]);
        if !["telnet", "rlogin", "serial"].contains(&protocol.as_str()) || at(session, &["auth", "autoLogin"]) == false {
            return None;
        }
        let username = str_at(session, &["username"]);
        let password = str_at(session, &["auth", "password"]);
        if username.is_empty() && password.is_empty() {
            return None;
        }
        Some(AutoLogin {
            // Rlogin sends the username in its handshake, so only the password prompt applies there.
            user_done: username.is_empty() || protocol == "rlogin",
            pass_done: password.is_empty(),
            username,
            password,
            until: Instant::now() + WINDOW,
            tail: String::new(),
        })
    }

    pub fn done(&self) -> bool {
        (self.user_done && self.pass_done) || Instant::now() > self.until
    }

    /// Feed ANSI-stripped output; returns text to send, or None.
    pub fn feed(&mut self, text: &str) -> Option<String> {
        if self.done() {
            return None;
        }
        self.tail.push_str(text);
        let n = self.tail.chars().count();
        if n > 200 {
            self.tail = self.tail.chars().skip(n - 200).collect();
        }
        if !self.user_done && USER_PROMPT.is_match(&self.tail) {
            self.user_done = true;
            self.tail.clear();
            return Some(format!("{}\r", self.username));
        }
        if !self.pass_done && PASS_PROMPT.is_match(&self.tail) {
            self.pass_done = true;
            self.tail.clear();
            return Some(format!("{}\r", self.password));
        }
        None
    }

    #[cfg(test)]
    pub fn expire(&mut self) {
        self.until = Instant::now() - Duration::from_secs(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_each_prompt_once() {
        let mut a = AutoLogin::new(&json!({ "protocol": "telnet", "username": "admin", "auth": { "password": "pw" } })).unwrap();
        assert_eq!(a.feed("\r\nUser Access Verification\r\n\r\nUsername: "), Some("admin\r".into()));
        assert_eq!(a.feed("Password: "), Some("pw\r".into()));
        assert!(a.done());
        assert_eq!(a.feed("Password: "), None);
    }

    #[test]
    fn rlogin_only_answers_password_and_ssh_never() {
        let mut a = AutoLogin::new(&json!({ "protocol": "rlogin", "username": "u", "auth": { "password": "pw" } })).unwrap();
        assert_eq!(a.feed("login: "), None);
        assert_eq!(a.feed("Password:"), Some("pw\r".into()));
        assert!(AutoLogin::new(&json!({ "protocol": "ssh2", "username": "u", "auth": { "password": "pw" } })).is_none());
        assert!(AutoLogin::new(&json!({ "protocol": "telnet", "username": "u", "auth": { "autoLogin": false } })).is_none());
        assert!(AutoLogin::new(&json!({ "protocol": "telnet" })).is_none());
    }

    #[test]
    fn stops_after_the_window() {
        let mut a = AutoLogin::new(&json!({ "protocol": "serial", "username": "u", "auth": { "password": "pw" } })).unwrap();
        a.expire();
        assert_eq!(a.feed("Password: "), None);
    }
}
