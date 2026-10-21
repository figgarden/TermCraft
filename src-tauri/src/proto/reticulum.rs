// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Reticulum (RNS): the network engineer's tools, reached by destination hash instead of IP.
//!
//!   rnsh  ≈ ssh         a remote shell on a destination hash (protocol "rnsh", a terminal tab)
//!   rncp  ≈ scp         send a file to, or fetch one from, a destination hash
//!   rnx   ≈ ssh host cmd  run one remote command
//!   rnprobe ≈ ping, rnpath ≈ traceroute / route lookup, rnstatus ≈ show interfaces
//!
//! TermCraft runs the official Reticulum programs (pip/pipx packages `rns` and `rnsh`) in a
//! terminal, without a shell: every value goes in its own argument, destination hashes are
//! checked, and positionals follow `--`, so session values can't become options or commands.

use super::{Conn, EventTx, local::spawn_pty};
use crate::json::{bool_at, num_at, str_at};
use crate::util::{expand_tilde, home};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// The programs TermCraft may start.
pub const TOOLS: [&str; 7] = ["rnsh", "rncp", "rnx", "rnstatus", "rnpath", "rnprobe", "rnid"];

/// A destination or identity hash: 16 bytes as 32 hex digits. Accepts the forms people paste:
/// `<a1b2…>`, `rnsh://a1b2…`, with spaces or colons.
pub fn normalize_hash(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s.strip_prefix("rnsh://").or_else(|| s.strip_prefix("rns://")).unwrap_or(s);
    let h: String = s.chars().filter(|c| !matches!(c, '<' | '>' | ' ' | ':' | '/')).collect::<String>().to_lowercase();
    (h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(h)
}

fn hash_arg(s: &str) -> Result<String> {
    normalize_hash(s).ok_or_else(|| anyhow!("\"{s}\" is not a Reticulum destination hash (32 hex digits)"))
}

/// Folders where pip/pipx put the Reticulum programs (a desktop app doesn't get the shell's PATH).
fn search_dirs(bin_dir: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if !bin_dir.is_empty() {
        dirs.push(PathBuf::from(expand_tilde(bin_dir)));
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    let h = home();
    dirs.push(h.join(".local/bin"));
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    // pipx keeps each app in its own environment; `pipx install rnsh` puts rns's programs
    // (rncp, rnstatus…) there without exposing them.
    for base in [h.join(".local/pipx/venvs"), h.join(".local/share/pipx/venvs")] {
        for app in ["rnsh", "rns"] {
            dirs.push(base.join(app).join("bin"));
            dirs.push(base.join(app).join("Scripts"));
        }
    }
    // Python user installs: ~/Library/Python/3.x/bin (macOS), %APPDATA%\Python\Python3x\Scripts.
    for base in [h.join("Library/Python"), dirs::data_dir().unwrap_or_default().join("Python")] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            v.sort();
            for p in v.into_iter().rev() {
                dirs.push(p.join("bin"));
                dirs.push(p.join("Scripts"));
            }
        }
    }
    dirs
}

/// Find a Reticulum program.
pub fn find_tool(name: &str, bin_dir: &str) -> Result<PathBuf> {
    if !TOOLS.contains(&name) {
        bail!("Unknown Reticulum tool {name}");
    }
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    search_dirs(bin_dir).into_iter().map(|d| d.join(&exe)).find(|p| p.is_file()).ok_or_else(|| {
        anyhow!("{name} was not found. Install the Reticulum tools (pipx install rns, then pipx install rnsh), or set their folder in Settings → General → Reticulum.")
    })
}

/// Where each tool is (for the settings page): name → path or null.
pub fn tool_paths(bin_dir: &str) -> Value {
    Value::Object(TOOLS.iter().map(|t| (t.to_string(), json!(find_tool(t, bin_dir).ok().map(|p| p.to_string_lossy().into_owned())))).collect())
}

/// rnsh's option for the Reticulum config folder: `--rnsconfig` in the rnsh that ships with rns
/// 1.x (where `-c` is rnsh's own config), `-c` in the older standalone rnsh. Asked once per program.
fn rnsh_config_flag(program: &Path) -> &'static str {
    static SEEN: LazyLock<parking_lot::Mutex<std::collections::HashMap<PathBuf, bool>>> = LazyLock::new(Default::default);
    if let Some(&new) = SEEN.lock().get(program) {
        return if new { "--rnsconfig" } else { "-c" };
    }
    let new = std::process::Command::new(program)
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("--rnsconfig") || String::from_utf8_lossy(&o.stderr).contains("--rnsconfig"))
        .unwrap_or(false);
    SEEN.lock().insert(program.to_path_buf(), new);
    if new { "--rnsconfig" } else { "-c" }
}

/// Reticulum settings that apply to every tool: { configDir, identity, binDir }.
struct Global {
    bin_dir: String,
    config_dir: String,
    identity: String,
}

impl Global {
    fn from(settings: &Value) -> Global {
        Global {
            bin_dir: str_at(settings, &["reticulum", "binDir"]),
            config_dir: str_at(settings, &["reticulum", "configDir"]).trim().to_string(),
            identity: str_at(settings, &["reticulum", "identity"]).trim().to_string(),
        }
    }
    /// The config folder option: rnsh spells it -c, the rns utilities --config.
    fn config(&self, flag: &str, args: &mut Vec<String>) {
        if !self.config_dir.is_empty() {
            args.push(flag.into());
            args.push(expand_tilde(&self.config_dir));
        }
    }
}

fn timeout(v: &Value, path: &[&str]) -> String {
    (num_at(v, path, 30.0).clamp(1.0, 3600.0) as u64).to_string()
}

static FULL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$").unwrap());

/// Program and arguments for an rnsh session (protocol "rnsh"; `host` is the destination hash).
pub fn rnsh_argv(session: &Value, settings: &Value) -> Result<(PathBuf, Vec<String>)> {
    let g = Global::from(settings);
    let dest = hash_arg(&str_at(session, &["host"]))?;
    let program = find_tool("rnsh", &g.bin_dir)?;
    let mut args = Vec::new();
    g.config(rnsh_config_flag(&program), &mut args);
    let identity = Some(str_at(session, &["reticulum", "identity"])).filter(|s| !s.trim().is_empty()).unwrap_or(g.identity.clone());
    if !identity.trim().is_empty() {
        args.extend(["-i".into(), expand_tilde(identity.trim())]);
    }
    args.extend(["-w".into(), timeout(session, &["reticulum", "timeout"])]);
    if bool_at(session, &["reticulum", "noId"]) {
        args.push("-N".into());
    }
    args.push(dest);
    let command = str_at(session, &["reticulum", "command"]);
    if !command.trim().is_empty() {
        let argv = crate::security::build_argv(&command, &Default::default())?;
        if !argv.is_empty() {
            args.push("--".into());
            args.extend(argv);
        }
    }
    Ok((program, args))
}

/// Program and arguments for a one-shot tool tab (protocol "rntool"; `rntool` describes it).
pub fn tool_argv(spec: &Value, settings: &Value) -> Result<(PathBuf, Vec<String>)> {
    let g = Global::from(settings);
    let mut args: Vec<String> = Vec::new();
    let identity = |args: &mut Vec<String>| {
        if !g.identity.is_empty() {
            args.extend(["-i".to_string(), expand_tilde(&g.identity)]);
        }
    };
    let tool = match str_at(spec, &["tool"]).as_str() {
        // show interfaces
        "status" => {
            g.config("--config", &mut args);
            if bool_at(spec, &["all"]) {
                args.push("-a".into());
            }
            "rnstatus"
        }
        // the routing table
        "paths" => {
            g.config("--config", &mut args);
            args.push("-t".into());
            "rnpath"
        }
        // route lookup: request a path and show the hop count and interface
        "path" => {
            g.config("--config", &mut args);
            args.extend(["-w".into(), timeout(spec, &["timeout"]), "--".into(), hash_arg(&str_at(spec, &["dest"]))?]);
            "rnpath"
        }
        // ping
        "probe" => {
            g.config("--config", &mut args);
            let name = Some(str_at(spec, &["fullName"])).filter(|n| !n.is_empty()).unwrap_or_else(|| "rnstransport.probe".into());
            if !FULL_NAME.is_match(&name) {
                bail!("Use a destination name like rnstransport.probe or rnsh");
            }
            let n = num_at(spec, &["probes"], 4.0).clamp(1.0, 100.0) as u32;
            args.extend(["-n".into(), n.to_string(), "-t".into(), timeout(spec, &["timeout"]), "--".into(), name, hash_arg(&str_at(spec, &["dest"]))?]);
            "rnprobe"
        }
        // the identity listeners must allow (rnsh -l -a <hash>)
        "identity" => {
            g.config(rnsh_config_flag(&find_tool("rnsh", &g.bin_dir)?), &mut args);
            identity(&mut args);
            args.push("-p".into());
            "rnsh"
        }
        // scp to: send a local file
        "send" => {
            let file = str_at(spec, &["file"]);
            if !Path::new(&file).is_absolute() {
                bail!("Choose the file to send");
            }
            g.config("--config", &mut args);
            identity(&mut args);
            args.extend(["-w".into(), timeout(spec, &["timeout"]), "--".into(), file, hash_arg(&str_at(spec, &["dest"]))?]);
            "rncp"
        }
        // scp from: fetch a file from a listener started with rncp -l -F
        "fetch" => {
            let remote = str_at(spec, &["remotePath"]);
            if remote.trim().is_empty() || remote.contains(['\n', '\r', '\0']) {
                bail!("Enter the remote file to fetch");
            }
            g.config("--config", &mut args);
            identity(&mut args);
            args.extend(["-w".into(), timeout(spec, &["timeout"]), "-f".into()]);
            let save = str_at(spec, &["saveDir"]);
            if !save.is_empty() {
                args.extend(["-s".into(), save]);
            }
            args.extend(["--".into(), remote, hash_arg(&str_at(spec, &["dest"]))?]);
            "rncp"
        }
        // ssh host command: run one command on an rnx listener
        "exec" => {
            let command = str_at(spec, &["command"]);
            if command.trim().is_empty() || command.contains('\0') {
                bail!("Enter the command to run");
            }
            g.config("--config", &mut args);
            identity(&mut args);
            args.extend(["-w".into(), timeout(spec, &["timeout"]), "-d".into(), "--".into(), hash_arg(&str_at(spec, &["dest"]))?, command]);
            "rnx"
        }
        t => bail!("Unknown Reticulum tool \"{t}\""),
    };
    Ok((find_tool(tool, &g.bin_dir)?, args))
}

fn term_of(session: &Value) -> String {
    Some(str_at(session, &["terminal", "termType"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "xterm-256color".into())
}

/// An rnsh session in a terminal tab.
pub fn connect_rnsh(session: &Value, settings: &Value, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    let (program, args) = rnsh_argv(session, settings)?;
    let dest = hash_arg(&str_at(session, &["host"]))?;
    spawn_pty(
        &program.to_string_lossy(),
        &args,
        &home().to_string_lossy(),
        &term_of(session),
        cols,
        rows,
        ev,
        json!({ "via": "Reticulum", "rns": dest }),
        String::new(),
    )
}

/// A Reticulum tool (status, path, probe, rncp, rnx…) in a terminal tab.
pub fn connect_tool(session: &Value, settings: &Value, cols: u16, rows: u16, ev: EventTx) -> Result<Conn> {
    let (program, args) = tool_argv(&session["rntool"], settings)?;
    let name = program.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    spawn_pty(
        &program.to_string_lossy(),
        &args,
        &home().to_string_lossy(),
        &term_of(session),
        cols,
        rows,
        ev,
        json!({ "shell": format!("{name} {}", args.join(" ")) }),
        String::new(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "b72e9a9afb54b7d19d1930f81e7674a4";

    #[test]
    fn hashes_in_every_pasted_form() {
        for s in [H, "<b72e9a9afb54b7d19d1930f81e7674a4>", "rnsh://B72E9A9AFB54B7D19D1930F81E7674A4", " b7:2e:9a:9a:fb:54:b7:d1:9d:19:30:f8:1e:76:74:a4 "] {
            assert_eq!(normalize_hash(s).as_deref(), Some(H), "{s}");
        }
        for bad in ["", "10.0.0.1", "b72e9a9afb54b7d19d1930f81e7674a", "b72e9a9afb54b7d19d1930f81e7674a4ff", "zz2e9a9afb54b7d19d1930f81e7674a4", "-c /tmp/evil"]
        {
            assert!(normalize_hash(bad).is_none(), "{bad}");
        }
    }

    /// Argument lists without needing the programs installed.
    fn args_of(r: Result<(PathBuf, Vec<String>)>) -> Vec<String> {
        match r {
            Ok((_, a)) => a,
            Err(e) => {
                let msg = e.to_string();
                assert!(msg.contains("was not found"), "{msg}");
                vec![]
            }
        }
    }

    fn settings() -> Value {
        // A bin folder with fake tools, so the argument lists are built.
        let dir = crate::store::tests::tmp("rnsbin");
        for t in TOOLS {
            let p = dir.join(if cfg!(windows) { format!("{t}.exe") } else { t.to_string() });
            std::fs::write(&p, "").unwrap();
        }
        json!({ "reticulum": { "binDir": dir.to_string_lossy(), "configDir": "/etc/rns", "identity": "" } })
    }

    #[test]
    fn rnsh_arguments() {
        let s = settings();
        let a = args_of(rnsh_argv(
            &json!({ "host": format!("<{H}>"), "reticulum": { "identity": "/k/id", "timeout": 15, "noId": true, "command": "show \"interfaces brief\"" } }),
            &s,
        ));
        assert_eq!(a, vec!["-c", "/etc/rns", "-i", "/k/id", "-w", "15", "-N", H, "--", "show", "interfaces brief"]);
        assert!(rnsh_argv(&json!({ "host": "-c /tmp/x" }), &s).unwrap_err().to_string().contains("not a Reticulum destination hash"));
    }

    #[test]
    fn tool_arguments_keep_values_out_of_options() {
        let s = settings();
        let file = std::env::temp_dir().join("a.cfg").to_string_lossy().into_owned();
        assert_eq!(args_of(tool_argv(&json!({ "tool": "status", "all": true }), &s)), vec!["--config", "/etc/rns", "-a"]);
        assert_eq!(args_of(tool_argv(&json!({ "tool": "path", "dest": H }), &s)), vec!["--config", "/etc/rns", "-w", "30", "--", H]);
        assert_eq!(
            args_of(tool_argv(&json!({ "tool": "probe", "dest": H, "probes": 3 }), &s)),
            vec!["--config", "/etc/rns", "-n", "3", "-t", "30", "--", "rnstransport.probe", H]
        );
        assert!(tool_argv(&json!({ "tool": "probe", "dest": H, "fullName": "x; rm -rf ~" }), &s).is_err());
        assert_eq!(
            args_of(tool_argv(&json!({ "tool": "send", "dest": H, "file": file.as_str() }), &s)),
            vec!["--config", "/etc/rns", "-w", "30", "--", file.as_str(), H]
        );
        assert!(tool_argv(&json!({ "tool": "send", "dest": H, "file": "--listen" }), &s).is_err());
        assert_eq!(
            args_of(tool_argv(&json!({ "tool": "fetch", "dest": H, "remotePath": "-l", "saveDir": "/tmp/in" }), &s)),
            vec!["--config", "/etc/rns", "-w", "30", "-f", "-s", "/tmp/in", "--", "-l", H],
            "a remote path that looks like an option stays a positional"
        );
        assert_eq!(
            args_of(tool_argv(&json!({ "tool": "exec", "dest": H, "command": "uptime; id" }), &s)),
            vec!["--config", "/etc/rns", "-w", "30", "-d", "--", H, "uptime; id"]
        );
        assert!(tool_argv(&json!({ "tool": "rm" }), &s).is_err());
        assert!(find_tool("bash", "").is_err(), "only Reticulum programs");
    }
}
