// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Security helpers. TermCraft handles untrusted remote content (terminal output, server-supplied
//! file names, imported session files), so everything received from the page or from servers is
//! treated as untrusted input.

use crate::util::resolve;
use anyhow::{Result, bail};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Keys that must never be merged/assigned from untrusted JSON (prototype pollution in the page).
pub const UNSAFE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

pub fn is_unsafe_key(k: &str) -> bool {
    UNSAFE_KEYS.contains(&k)
}

/// Remove prototype-polluting keys at every level.
pub fn sanitize_json(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| !is_unsafe_key(k));
            for x in m.values_mut() {
                sanitize_json(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(sanitize_json),
        _ => {}
    }
}

/// JSON.parse that drops prototype-polluting keys.
pub fn safe_json_parse(text: &str) -> Result<Value> {
    let mut v: Value = serde_json::from_str(text)?;
    sanitize_json(&mut v);
    Ok(v)
}

/// Only http(s) URLs may be handed to the OS browser.
pub fn is_safe_external_url(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    match tauri::Url::parse(url) {
        Ok(u) => u.scheme() == "http" || u.scheme() == "https",
        Err(_) => false,
    }
}

/// A remote-supplied file name must be one plain path component (no traversal, no separators).
pub fn is_safe_file_name(name: &str) -> bool {
    let b = name.as_bytes();
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0']) && !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// Split a command template into argv without a shell, honouring "double" and 'single' quotes,
/// then substitute {tokens} inside individual arguments. Values can never break out of their
/// argument, so a hostile host or user name cannot inject shell syntax.
pub fn build_argv(template: &str, values: &HashMap<&str, String>) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for ch in template.chars() {
        if let Some(q) = quote {
            if ch == q { quote = None } else { cur.push(ch) }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            any = true;
        } else if ch.is_whitespace() {
            if !cur.is_empty() || any {
                args.push(std::mem::take(&mut cur));
                any = false;
            }
        } else {
            cur.push(ch);
        }
    }
    if quote.is_some() {
        bail!("Unbalanced quote in command");
    }
    if !cur.is_empty() || any {
        args.push(cur);
    }
    let re = regex::Regex::new(r"\{(\w+)\}").unwrap();
    Ok(args
        .into_iter()
        .map(|a| re.replace_all(&a, |c: &regex::Captures| values.get(&c[1]).cloned().unwrap_or_else(|| c[0].to_string())).into_owned())
        .collect())
}

/// Paths the user has explicitly chosen (file dialogs) or browsed (SFTP local pane). Page requests
/// that touch the local file system are only honoured for these, so a compromised page cannot read
/// or delete arbitrary files.
#[derive(Default)]
pub struct ApprovedPaths {
    files: HashSet<PathBuf>,
    dirs: HashSet<PathBuf>,
    /// Folders picked in a native folder dialog.
    chosen: HashSet<PathBuf>,
}

impl ApprovedPaths {
    pub fn approve_file(&mut self, p: &str) {
        if !p.is_empty() {
            self.files.insert(resolve(p));
        }
    }
    pub fn approve_dir(&mut self, p: &str) {
        if !p.is_empty() {
            self.dirs.insert(resolve(p));
        }
    }
    /// A folder the user picked in a native dialog (not one the page merely browsed).
    pub fn choose_dir(&mut self, p: &str) {
        if !p.is_empty() {
            self.approve_dir(p);
            self.chosen.insert(resolve(p));
        }
    }
    pub fn is_chosen_dir(&self, p: &str) -> bool {
        !p.is_empty() && self.chosen.contains(&resolve(p))
    }
    pub fn is_approved_file(&self, p: &str) -> bool {
        !p.is_empty() && self.files.contains(&resolve(p))
    }
    /// True when `p` is a browsed directory or directly inside one.
    pub fn is_in_approved_dir(&self, p: &str) -> bool {
        if p.is_empty() {
            return false;
        }
        let abs = resolve(p);
        self.dirs.contains(&abs) || abs.parent().is_some_and(|d| self.dirs.contains(d))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prototype_keys_are_dropped() {
        let v =
            safe_json_parse(r#"{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}, "theme": "light", "a": [{"prototype": 1, "b": 2}]}"#)
                .unwrap();
        assert_eq!(v["theme"], "light");
        assert!(v.get("__proto__").is_none());
        assert!(v.get("constructor").is_none());
        assert!(v["a"][0].get("prototype").is_none());
        assert_eq!(v["a"][0]["b"], 2);
    }

    #[test]
    fn external_links_only_http() {
        for ok in ["https://example.com", "http://x.org/a?b", "HTTPS://EXAMPLE.COM"] {
            assert!(is_safe_external_url(ok), "{ok}");
        }
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "ms-msdt:/id", "vbscript:x", " https://x", "data:text/html,x", ""] {
            assert!(!is_safe_external_url(bad), "{bad}");
        }
    }

    #[test]
    fn unsafe_file_names() {
        for bad in ["..", ".", "a/b", "a\\b", "C:x", "", "x\0y"] {
            assert!(!is_safe_file_name(bad), "{bad:?}");
        }
        assert!(is_safe_file_name("ok.txt"));
    }

    #[test]
    fn argv_values_stay_in_their_argument() {
        let mut v = HashMap::new();
        v.insert("user", "a\"; touch /tmp/PWNED; \"".to_string());
        v.insert("host", "$(id)".to_string());
        assert_eq!(build_argv(r#"client --user "{user}" {host}"#, &v).unwrap(), vec!["client", "--user", "a\"; touch /tmp/PWNED; \"", "$(id)"]);
        assert!(build_argv("client \"unclosed", &HashMap::new()).unwrap_err().to_string().contains("Unbalanced quote"));
        assert_eq!(build_argv("a '' b", &HashMap::new()).unwrap(), vec!["a", "", "b"]);
    }

    #[test]
    fn approved_paths() {
        let mut a = ApprovedPaths::default();
        a.approve_file("/home/u/import.json");
        a.approve_dir("/home/u/projects");
        assert!(a.is_approved_file("/home/u/import.json"));
        assert!(!a.is_approved_file("/etc/passwd"));
        assert!(a.is_in_approved_dir("/home/u/projects/notes.txt"));
        assert!(a.is_in_approved_dir("/home/u/projects"));
        assert!(!a.is_in_approved_dir("/home/u/projects/../.ssh/id_ed25519"));
        assert!(!a.is_in_approved_dir("/home/u/projects/sub/deep.txt"), "only direct children");
        assert!(!a.is_in_approved_dir("/"));
        assert!(!a.is_chosen_dir("/home/u/projects"));
        a.choose_dir("/data");
        assert!(a.is_chosen_dir("/data/"));
    }
}
