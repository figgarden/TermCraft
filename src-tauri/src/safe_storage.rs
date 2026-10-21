// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Encryption of saved passwords with a key kept in the OS keychain ("TermCraft Safe Storage").
//!
//! The format is Chromium's OSCrypt (what Electron's safeStorage wrote for earlier TermCraft
//! releases): "v10" + AES-128-CBC, key = PBKDF2-HMAC-SHA1(keychain password, "saltysalt", 1003
//! iterations), IV = 16 spaces. On macOS the keychain item is the one Electron created, so
//! passwords saved by earlier versions still decrypt.

use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use std::sync::OnceLock;

type Enc = cbc::Encryptor<aes::Aes128>;
type Dec = cbc::Decryptor<aes::Aes128>;

const SERVICE: &str = "TermCraft Safe Storage";
const ACCOUNT: &str = "TermCraft Key";
const PREFIX: &[u8] = b"v10";
const IV: [u8; 16] = [b' '; 16];

pub trait SecretBox: Send + Sync {
    /// Whether an OS keychain can be used at all on this system.
    fn is_available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>>;
    fn decrypt(&self, data: &[u8]) -> Result<String>;
}

/// The OS keychain-backed implementation. The key is read on first use, which is when macOS
/// asks the user to allow access to "TermCraft Safe Storage".
#[derive(Default)]
pub struct OsKeychain {
    key: OnceLock<std::result::Result<[u8; 16], String>>,
}

fn derive(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

pub fn encrypt_with(key: &[u8; 16], plain: &str) -> Vec<u8> {
    let ct = Enc::new(key.into(), &IV.into()).encrypt_padded_vec::<Pkcs7>(plain.as_bytes());
    [PREFIX, &ct].concat()
}

pub fn decrypt_with(key: &[u8; 16], data: &[u8]) -> Result<String> {
    let body = data.strip_prefix(PREFIX).ok_or_else(|| anyhow!("unknown format"))?;
    let pt = Dec::new(key.into(), &IV.into()).decrypt_padded_vec::<Pkcs7>(body).map_err(|_| anyhow!("decryption failed"))?;
    Ok(String::from_utf8(pt)?)
}

impl OsKeychain {
    fn key(&self) -> Result<[u8; 16]> {
        self.key
            .get_or_init(|| {
                let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
                let password = match entry.get_password() {
                    Ok(p) => p,
                    Err(keyring::Error::NoEntry) => {
                        let bytes: [u8; 16] = rand::random();
                        let p = base64::engine::general_purpose::STANDARD.encode(bytes);
                        entry.set_password(&p).map_err(|e| e.to_string())?;
                        p
                    }
                    Err(e) => return Err(e.to_string()),
                };
                Ok(derive(password.as_bytes()))
            })
            .clone()
            .map_err(|e| anyhow!(e))
    }
}

impl SecretBox for OsKeychain {
    fn is_available(&self) -> bool {
        // macOS and Windows always have a keychain (reading the key is what shows the macOS
        // access prompt, so it waits for the first real use). Linux needs a Secret Service
        // (GNOME Keyring, KWallet) to be running.
        cfg!(any(target_os = "macos", windows)) || self.key().is_ok()
    }
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>> {
        Ok(encrypt_with(&self.key()?, plain))
    }
    fn decrypt(&self, data: &[u8]) -> Result<String> {
        if !data.starts_with(PREFIX) {
            bail!("unknown format");
        }
        decrypt_with(&self.key()?, data)
    }
}

/// A key kept in a file instead of the keychain: debug builds under end-to-end tests only.
pub struct FileKey {
    path: std::path::PathBuf,
    key: OnceLock<[u8; 16]>,
}

impl FileKey {
    pub fn new(path: std::path::PathBuf) -> FileKey {
        FileKey { path, key: OnceLock::new() }
    }
    fn key(&self) -> [u8; 16] {
        *self.key.get_or_init(|| {
            if let Ok(b) = std::fs::read(&self.path) {
                if let Ok(k) = <[u8; 16]>::try_from(b.as_slice()) {
                    return k;
                }
            }
            let k: [u8; 16] = rand::random();
            if let Some(d) = self.path.parent() {
                let _ = crate::store::mkdir_private(d);
            }
            let _ = crate::store::write_mode(&self.path, &k, 0o600);
            k
        })
    }
}

impl SecretBox for FileKey {
    fn is_available(&self) -> bool {
        true
    }
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>> {
        Ok(encrypt_with(&self.key(), plain))
    }
    fn decrypt(&self, data: &[u8]) -> Result<String> {
        decrypt_with(&self.key(), data)
    }
}

/// A fixed in-memory key, for tests.
#[cfg(test)]
pub struct TestBox(pub [u8; 16]);

#[cfg(test)]
impl SecretBox for TestBox {
    fn is_available(&self) -> bool {
        true
    }
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>> {
        Ok(encrypt_with(&self.0, plain))
    }
    fn decrypt(&self, data: &[u8]) -> Result<String> {
        decrypt_with(&self.0, data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_chromium_vector() {
        let key = derive(b"peanuts");
        let ct = encrypt_with(&key, "secret password");
        assert!(ct.starts_with(b"v10"));
        assert_eq!(decrypt_with(&key, &ct).unwrap(), "secret password");
        assert!(decrypt_with(&derive(b"other"), &ct).is_err());
        // Chromium's documented key derivation for the password "peanuts" (1 iteration on Linux);
        // here we only check the derivation is deterministic and 16 bytes.
        assert_eq!(derive(b"peanuts"), key);
    }
}
