// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Bulk host import: a CSV with a header row, or a plain list of hosts (one per line, optionally
//! "name host" or "name,host"). Typical source: an inventory/IPAM export or a spreadsheet of devices.

use crate::json::{number, string};
use crate::util::default_port;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::LazyLock;

fn protocol_alias(p: &str) -> Option<&'static str> {
    Some(match p {
        "ssh" | "ssh2" => "ssh2",
        "telnet" => "telnet",
        "rlogin" => "rlogin",
        "raw" => "raw",
        "serial" => "serial",
        "vnc" => "vnc",
        "rdp" => "rdp",
        "rnsh" | "reticulum" | "rns" => "rnsh",
        _ => return None,
    })
}

/// Header names people actually use in inventory exports, mapped to session fields.
const HEADER_ALIASES: &[(&str, &[&str])] = &[
    ("name", &["name", "session", "label", "device", "devicename", "device name"]),
    ("host", &["host", "address", "ip", "ipaddress", "ip address", "mgmt ip", "management ip", "fqdn"]),
    ("port", &["port"]),
    ("protocol", &["protocol", "proto", "type"]),
    ("username", &["username", "user", "login"]),
    ("folder", &["folder", "group", "site", "location", "path"]),
    ("credential", &["credential", "credentials", "cred"]),
    ("jump", &["jump", "jumphost", "jump host", "bastion", "proxyjump", "via"]),
    ("notes", &["notes", "description", "comment", "comments", "model", "role"]),
];
static HOST_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(\[[0-9a-f:.]+\]|[a-z0-9_.:-]+)$").unwrap());
static ADDR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$").unwrap());

/// Split one CSV line (RFC 4180 quotes, comma / semicolon / tab separated).
pub fn split_csv_line(line: &str, sep: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if q {
            if c == '"' && chars.get(i + 1) == Some(&'"') {
                cur.push('"');
                i += 1;
            } else if c == '"' {
                q = false;
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            q = true;
        } else if c == sep {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(c);
        }
        i += 1;
    }
    out.push(cur.trim().to_string());
    out
}

fn detect_separator(line: &str) -> Option<char> {
    let mut best = (',', 0usize);
    for c in [',', ';', '\t'] {
        let n = split_csv_line(line, c).len();
        if n > best.1 {
            best = (c, n);
        }
    }
    (best.1 > 1).then_some(best.0)
}

/// Map header cells to field names; None when the first row isn't a header.
fn map_header(cells: &[String]) -> Option<BTreeMap<&'static str, usize>> {
    let mut map = BTreeMap::new();
    let keys: Vec<String> = cells.iter().map(|c| Regex::new(r"[_-]+").unwrap().replace_all(&c.to_lowercase(), " ").trim().to_string()).collect();
    for (i, key) in keys.iter().enumerate() {
        if let Some((field, _)) = HEADER_ALIASES.iter().find(|(f, aliases)| aliases.contains(&key.as_str()) && !map.contains_key(f)) {
            map.insert(*field, i);
        }
    }
    // "hostname" is the address in some exports and the device name in others.
    if let Some(hn) = keys.iter().position(|k| k == "hostname") {
        if !map.contains_key("host") {
            map.insert("host", hn);
        } else if !map.contains_key("name") {
            map.insert("name", hn);
        }
    }
    map.contains_key("host").then_some(map)
}

/// Parse hosts text into rows. Never fails on bad lines; they come back in `errors`.
pub fn parse_hosts(text: &str, defaults: &Value) -> Value {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let Some(first) = lines.iter().position(|l| !l.trim().is_empty() && !l.trim().starts_with('#')) else {
        return json!({ "rows": rows, "errors": errors });
    };
    let sep = detect_separator(lines[first]);
    let header = sep.and_then(|s| map_header(&split_csv_line(lines[first], s)));
    let def_proto = protocol_alias(&{
        let p = string(&defaults["protocol"]);
        if p.is_empty() { "ssh2".to_string() } else { p.to_lowercase() }
    })
    .unwrap_or("ssh2");

    for (i, raw) in lines.iter().enumerate().skip(if header.is_some() { first + 1 } else { first }) {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut r: BTreeMap<&str, String> = BTreeMap::new();
        if let Some(h) = &header {
            let cells = split_csv_line(line, sep.unwrap());
            for (field, idx) in h {
                r.insert(field, cells.get(*idx).cloned().unwrap_or_default());
            }
        } else {
            let cells: Vec<String> = match sep {
                Some(s) => split_csv_line(line, s),
                None => line.split_whitespace().map(String::from).collect(),
            };
            if cells.len() >= 2 {
                r.insert("name", cells[0].clone());
                r.insert("host", cells[1].clone());
            } else {
                r.insert("host", cells[0].clone());
            }
        }
        let get = |k: &str| r.get(k).cloned().unwrap_or_default();
        // Reticulum: the host column holds a destination hash (any pasted form).
        if protocol_alias(&get("protocol").to_lowercase()).unwrap_or(def_proto) == "rnsh" {
            let Some(hash) = crate::proto::reticulum::normalize_hash(&get("host")) else {
                errors.push(format!("Line {}: \"{}\" has no valid destination hash", i + 1, line.chars().take(60).collect::<String>()));
                continue;
            };
            let name = get("name");
            rows.push(json!({
                "name": (if name.is_empty() { format!("rnsh {}…{}", &hash[..4], &hash[28..]) } else { name }).trim().chars().take(200).collect::<String>(),
                "host": hash, "port": 0, "protocol": "rnsh", "username": "",
                "folder": get("folder").trim().replace('\\', "/"), "credential": "", "jump": "", "notes": get("notes").trim(),
            }));
            continue;
        }
        // Accept user@host:port in the host column.
        let host_field = get("host");
        let m = ADDR_RE.captures(host_field.trim());
        let Some(m) = m.filter(|m| HOST_RE.is_match(&m[2])) else {
            errors.push(format!("Line {}: \"{}\" has no valid host", i + 1, line.chars().take(60).collect::<String>()));
            continue;
        };
        let protocol = protocol_alias(&get("protocol").to_lowercase()).unwrap_or(def_proto);
        let port_s = m.get(3).map(|x| x.as_str().to_string()).unwrap_or_else(|| get("port"));
        let mut port = number(&json!(port_s)).filter(|p| *p != 0.0 && !p.is_nan()).unwrap_or(0.0);
        if port == 0.0 {
            port = number(&defaults["port"]).filter(|p| *p != 0.0 && !p.is_nan()).unwrap_or(0.0);
        }
        if port == 0.0 {
            port = default_port(protocol).unwrap_or(22) as f64;
        }
        if !(port > 0.0 && port < 65536.0) {
            errors.push(format!("Line {}: invalid port", i + 1));
            continue;
        }
        let name = get("name");
        let username = m
            .get(1)
            .map(|x| x.as_str().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| Some(get("username")).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| string(&defaults["username"]));
        rows.push(json!({
            "name": (if name.is_empty() { m[2].to_string() } else { name }).trim().chars().take(200).collect::<String>(),
            "host": m[2].trim_start_matches('[').trim_end_matches(']'),
            "port": port as u64,
            "protocol": protocol,
            "username": username.trim(),
            "folder": get("folder").trim().replace('\\', "/"),
            "credential": get("credential").trim(),
            "jump": get("jump").trim(),
            "notes": get("notes").trim(),
        }));
    }
    json!({ "rows": rows, "errors": errors })
}
