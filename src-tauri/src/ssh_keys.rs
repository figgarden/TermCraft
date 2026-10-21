// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! SSH key tools: create a key pair in ~/.ssh, list public keys, and install a public key on a
//! server (what ssh-copy-id does) so later logins need no password.

use crate::store::{mkdir_private, write_mode};
use crate::util::home;
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use regex::Regex;
use russh::keys::ssh_key::{
    Algorithm, EcdsaCurve, LineEnding, PrivateKey,
    private::{KeypairData, RsaKeypair},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// One OpenSSH public key line. The comment can't contain quotes or newlines (it goes into a
/// shell command).
static PUBKEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+) ([A-Za-z0-9+/]+={0,3})(?: ([^'\x22\\\n\r`$]{0,200}))?$").unwrap());

fn ssh_dir(home_dir: Option<&Path>) -> PathBuf {
    home_dir.map(Path::to_path_buf).unwrap_or_else(home).join(".ssh")
}

/// SHA256 fingerprint, as shown by ssh-keygen -l.
fn fingerprint(b64: &str) -> String {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
    format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(raw)))
}

pub fn parse_public_key(text: &str) -> Option<Value> {
    let m = PUBKEY_RE.captures(text.trim())?;
    let comment = m.get(3).map(|c| c.as_str()).unwrap_or("");
    let line = if comment.is_empty() { format!("{} {}", &m[1], &m[2]) } else { format!("{} {} {}", &m[1], &m[2], comment) };
    Some(json!({ "line": line, "type": &m[1], "comment": comment, "fingerprint": fingerprint(&m[2]) }))
}

fn generate(kind: &str, comment: &str, passphrase: &str) -> Result<(String, String)> {
    let mut rng = rand::rng();
    let mut key = match kind {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519)?,
        "ecdsa-256" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 })?,
        "rsa-4096" | "rsa-3072" => {
            let bits = if kind == "rsa-4096" { 4096 } else { 3072 };
            PrivateKey::new(KeypairData::from(RsaKeypair::random(&mut rng, bits)?), comment)?
        }
        _ => bail!("Unknown key type {kind}"),
    };
    key.set_comment(comment);
    let public = key.public_key().to_openssh()?;
    if !passphrase.is_empty() {
        key = key.encrypt(&mut rng, passphrase)?;
    }
    let private = key.to_openssh(LineEnding::LF)?.to_string();
    // Read it back, as a check that what is written to disk can be used.
    let parsed = PrivateKey::from_openssh(&private)?;
    let parsed = if passphrase.is_empty() { parsed } else { parsed.decrypt(passphrase)? };
    if parsed.public_key().to_openssh()? != public {
        bail!("Could not create a valid key. Please try again.");
    }
    Ok((private, public))
}

/// Create a key pair. `name` is a file name inside ~/.ssh (no paths); existing files are never
/// replaced.
pub fn generate_key(opts: &Value, home_dir: Option<&Path>) -> Result<Value> {
    let name = crate::json::str_at(opts, &["name"]);
    let kind = crate::json::str_at(opts, &["kind"]);
    let kind = if kind.is_empty() { "ed25519".to_string() } else { kind };
    let passphrase = crate::json::str_at(opts, &["passphrase"]);
    let comment = crate::json::str_at(opts, &["comment"]);
    if !["ed25519", "rsa-4096", "rsa-3072", "ecdsa-256"].contains(&kind.as_str()) {
        bail!("Unknown key type {kind}");
    }
    if !Regex::new(r"^[A-Za-z0-9._-]{1,64}$").unwrap().is_match(&name) || name.starts_with('.') {
        bail!("Use a simple file name such as id_ed25519_work (letters, digits, . _ -)");
    }
    if comment.contains(['\n', '\r', '\'', '"', '`', '$', '\\']) {
        bail!("The comment cannot contain quotes, $ or backslashes");
    }
    let dir = ssh_dir(home_dir);
    let private_key = dir.join(&name);
    let public_key = PathBuf::from(format!("{}.pub", private_key.display()));
    if private_key.exists() || public_key.exists() {
        bail!("{} already exists. Choose another name.", private_key.display());
    }
    mkdir_private(&dir)?;
    let comment =
        if comment.is_empty() { format!("{}@{}", whoami::username(), whoami::fallible::hostname().unwrap_or_else(|_| "localhost".into())) } else { comment };
    let (private, public) = generate(&kind, &comment, &passphrase)?;
    create_new(&private_key, private.as_bytes(), 0o600)?;
    create_new(&public_key, format!("{public}\n").as_bytes(), 0o644)?;
    let parsed = parse_public_key(&public).ok_or_else(|| anyhow!("Could not create a valid key"))?;
    Ok(json!({
        "privateKey": private_key.to_string_lossy(),
        "publicKey": public_key.to_string_lossy(),
        "line": parsed["line"],
        "fingerprint": parsed["fingerprint"],
    }))
}

fn create_new(path: &Path, data: &[u8], mode: u32) -> Result<()> {
    if path.exists() {
        bail!("{} already exists", path.display());
    }
    write_mode(path, data, mode)
}

/// Public keys in ~/.ssh.
pub fn list_public_keys(home_dir: Option<&Path>) -> Vec<Value> {
    let dir = ssh_dir(home_dir);
    let Ok(rd) = fs::read_dir(&dir) else { return vec![] };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(".pub")).collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|f| {
            let text = fs::read_to_string(dir.join(&f)).ok()?;
            let mut k = parse_public_key(text.split('\n').next().unwrap_or(""))?;
            let private = dir.join(&f[..f.len() - 4]);
            k["file"] = json!(dir.join(&f).to_string_lossy());
            k["privateKey"] = json!(if private.exists() { private.to_string_lossy().into_owned() } else { String::new() });
            Some(k)
        })
        .collect()
}

/// Shell command that appends the key to ~/.ssh/authorized_keys once, with safe permissions.
pub fn install_command(pub_line: &str) -> Result<String> {
    let k = parse_public_key(pub_line).ok_or_else(|| anyhow!("Not a valid OpenSSH public key"))?;
    let q = format!("'{}'", k["line"].as_str().unwrap()); // PUBKEY_RE rules out quotes, so single-quoting is safe
    Ok(format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && if grep -qF {q} ~/.ssh/authorized_keys; then echo TERMCRAFT_KEY_PRESENT; else printf '%s\\n' {q} >> ~/.ssh/authorized_keys && echo TERMCRAFT_KEY_ADDED; fi"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_list_and_safe_install_command() {
        let home_dir = crate::store::tests::tmp("home");
        let k =
            generate_key(&json!({ "name": "id_ed25519_test", "kind": "ed25519", "passphrase": "secret pw", "comment": "me@laptop" }), Some(&home_dir)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(k["privateKey"].as_str().unwrap()).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(home_dir.join(".ssh")).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let private = fs::read_to_string(k["privateKey"].as_str().unwrap()).unwrap();
        assert!(private.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(PrivateKey::from_openssh(&private).unwrap().decrypt("secret pw").is_ok());
        assert!(generate_key(&json!({ "name": "id_ed25519_test" }), Some(&home_dir)).unwrap_err().to_string().contains("already exists"));
        assert!(generate_key(&json!({ "name": "../evil" }), Some(&home_dir)).unwrap_err().to_string().contains("simple file name"));
        let list = list_public_keys(Some(&home_dir));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["comment"], "me@laptop");
        assert!(Regex::new(r"^SHA256:[A-Za-z0-9+/]{43}$").unwrap().is_match(list[0]["fingerprint"].as_str().unwrap()));
        let cmd = install_command(list[0]["line"].as_str().unwrap()).unwrap();
        assert!(cmd.contains(&format!("'{}'", list[0]["line"].as_str().unwrap())));
        assert!(install_command("ssh-ed25519 AAAA x'; rm -rf ~; echo '").is_err());
        assert!(install_command("ssh-ed25519 AAAA $(id)").is_err());
    }

    #[test]
    fn every_generated_key_reads_back() {
        for _ in 0..200 {
            let (private, _) = generate("ed25519", "t@x", "").unwrap();
            assert!(PrivateKey::from_openssh(&private).is_ok());
        }
        let (private, _) = generate("ecdsa-256", "t@x", "pw").unwrap();
        assert!(PrivateKey::from_openssh(&private).unwrap().decrypt("pw").is_ok());
    }
}
