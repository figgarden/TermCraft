// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
use crate::json::{at, string};
use base64::Engine;
use chrono::{DateTime, Datelike, Local, Timelike};
use md5::Md5;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock as Lazy;

/// Expand backslash escape sequences used in button bar strings, logon actions and the command
/// window: \r \n \t \e \b \a \v \\ \0 \xHH (\p, the 1 s pause marker, is kept literal).
pub fn expand_escapes(s: &str) -> String {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\\(x[0-9a-fA-F]{2}|[rntebav\\0])").unwrap());
    RE.replace_all(s, |c: &regex::Captures| {
        let m = &c[1];
        if let Some(h) = m.strip_prefix('x') {
            return char::from(u8::from_str_radix(h, 16).unwrap()).to_string();
        }
        match m {
            "r" => "\r",
            "n" => "\n",
            "t" => "\t",
            "e" => "\x1b",
            "b" => "\x08",
            "a" => "\x07",
            "v" => "\x0b",
            "\\" => "\\",
            _ => "\0",
        }
        .to_string()
    })
    .into_owned()
}

/// CSI, OSC, DCS/SOS/PM/APC, and single-character escapes.
pub static ANSI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]").unwrap());

pub fn strip_ansi(s: &str) -> String {
    ANSI_RE.replace_all(s, "").into_owned()
}

fn pad(n: u32, w: usize) -> String {
    format!("{n:0w$}")
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `p.replace(/^~/, home)`.
pub fn expand_tilde(p: &str) -> String {
    match p.strip_prefix('~') {
        Some(rest) => format!("{}{}", home().display(), rest),
        None => p.to_string(),
    }
}

/// Lexically normalized absolute path, like Node's path.resolve (no symlink resolution).
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Substitute log-file name tokens:
///  %H host  %S session name  %Y year  %M month  %D day  %h hour  %m minute  %s second  %t millis  %P port  %U user  %% percent
pub fn expand_log_path(template: &str, session: &Value, now: DateTime<Local>) -> String {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"%([HSYMDhmstPU%])").unwrap());
    static UNSAFE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[\\/:*?"<>|]"#).unwrap());
    let safe = |s: String| UNSAFE.replace_all(&s, "_").into_owned();
    let p = RE
        .replace_all(template, |c: &regex::Captures| match &c[1] {
            "H" => {
                let host = string(at(session, &["host"]));
                let host = if host.is_empty() { string(at(session, &["serial", "path"])) } else { host };
                safe(if host.is_empty() { "local".into() } else { host })
            }
            "S" => {
                let n = string(at(session, &["name"]));
                safe(if n.is_empty() { "session".into() } else { n })
            }
            "Y" => now.year().to_string(),
            "M" => pad(now.month(), 2),
            "D" => pad(now.day(), 2),
            "h" => pad(now.hour(), 2),
            "m" => pad(now.minute(), 2),
            "s" => pad(now.second(), 2),
            "t" => pad(now.timestamp_subsec_millis(), 3),
            "P" => string(at(session, &["port"])),
            "U" => safe(string(at(session, &["username"]))),
            _ => "%".into(),
        })
        .into_owned();
    match p.strip_prefix('~') {
        Some(rest) => home().join(rest.trim_start_matches(['/', '\\'])).to_string_lossy().into_owned(),
        None => p,
    }
}

pub fn timestamp_at(now: DateTime<Local>) -> String {
    format!(
        "{}-{}-{} {}:{}:{}.{}",
        now.year(),
        pad(now.month(), 2),
        pad(now.day(), 2),
        pad(now.hour(), 2),
        pad(now.minute(), 2),
        pad(now.second(), 2),
        pad(now.timestamp_subsec_millis(), 3)
    )
}

pub fn timestamp() -> String {
    timestamp_at(Local::now())
}

/// Key type and SHA256/MD5 fingerprints of a raw SSH public key blob.
pub fn host_key_info(key: &[u8]) -> Value {
    let mut ty = "unknown".to_string();
    if key.len() >= 4 {
        let len = u32::from_be_bytes([key[0], key[1], key[2], key[3]]) as usize;
        if key.len() >= 4 + len {
            ty = String::from_utf8_lossy(&key[4..4 + len]).into_owned();
        }
    }
    let fp = base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key));
    let md5 = Md5::digest(key).iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":");
    json!({ "type": ty, "fingerprint": format!("SHA256:{fp}"), "md5": md5 })
}

pub fn new_id(prefix: &str) -> String {
    let bytes: [u8; 8] = rand::random();
    format!("{prefix}{}", hex::encode(bytes))
}

pub fn default_port(protocol: &str) -> Option<u16> {
    match protocol {
        "ssh2" => Some(22),
        "telnet" => Some(23),
        "rlogin" => Some(513),
        "raw" => Some(23),
        "vnc" => Some(5900),
        "rdp" => Some(3389),
        _ => None,
    }
}

/// Parse a quick-connect string: [protocol://][user@]host[:port]
/// e.g. "admin@10.0.0.1:2222", "telnet://router", "ssh://me@box".
pub fn parse_connect_string(s: &str) -> Option<Value> {
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)^(?:(ssh2?|telnet|rlogin|raw|vnc|rdp)://)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$").unwrap());
    let m = RE.captures(s.trim())?;
    let mut protocol = m.get(1).map(|x| x.as_str().to_lowercase()).unwrap_or_else(|| "ssh2".into());
    if protocol == "ssh" {
        protocol = "ssh2".into();
    }
    let host = m[3].trim_start_matches('[').trim_end_matches(']').to_string();
    let port = match m.get(4) {
        Some(p) => p.as_str().parse::<u64>().ok().map(Value::from).unwrap_or(Value::Null),
        None => default_port(&protocol).map(Value::from).unwrap_or(Value::Null),
    };
    Some(json!({
        "protocol": protocol,
        "username": m.get(2).map(|x| x.as_str()).unwrap_or(""),
        "host": host,
        "port": port,
    }))
}

/// Node-style platform name, as the page expects.
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn expand_escapes_handles_sequences() {
        assert_eq!(expand_escapes(r"ls\r"), "ls\r");
        assert_eq!(expand_escapes(r"a\tb\x41\\"), "a\tbA\\");
        assert_eq!(expand_escapes(r"\e[0m"), "\x1b[0m");
        assert_eq!(expand_escapes(""), "");
    }

    #[test]
    fn strip_ansi_removes_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text");
        assert_eq!(strip_ansi("a\x1b(Bb"), "ab");
    }

    #[test]
    fn expand_log_path_tokens() {
        let now = Local.with_ymd_and_hms(2024, 3, 5, 7, 8, 9).unwrap();
        let p = expand_log_path("/logs/%S-%H-%Y%M%D-%h%m%s.log", &json!({ "name": "r1/x", "host": "10.0.0.1" }), now);
        assert_eq!(p, "/logs/r1_x-10.0.0.1-20240305-070809.log");
    }

    #[test]
    fn parse_connect_string_variants() {
        assert_eq!(parse_connect_string("admin@10.0.0.1:2222").unwrap(), json!({ "protocol": "ssh2", "username": "admin", "host": "10.0.0.1", "port": 2222 }));
        let t = parse_connect_string("telnet://router").unwrap();
        assert_eq!(t["protocol"], "telnet");
        assert_eq!(t["port"], 23);
        assert_eq!(parse_connect_string("ssh://me@[::1]:22").unwrap()["host"], "::1");
        assert!(parse_connect_string("bad host").is_none());
    }

    #[test]
    fn host_key_info_parses_type() {
        let mut blob = vec![0, 0, 0, 11];
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&[0; 36]);
        let info = host_key_info(&blob);
        assert_eq!(info["type"], "ssh-ed25519");
        assert!(info["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
        assert_eq!(info["md5"].as_str().unwrap().split(':').count(), 16);
    }

    #[test]
    fn resolve_normalizes() {
        let base = resolve(std::env::temp_dir());
        assert_eq!(resolve(base.join("a/b/../c/./d")), base.join("a").join("c").join("d"));
    }
}
