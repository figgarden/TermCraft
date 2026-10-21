// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Assembles the web UI (src/renderer plus the browser libraries it imports from node_modules)
//! into src-tauri/web. The libraries go to web/vendor (Tauri won't bundle a folder named
//! node_modules), and the copied pages' "node_modules/" paths are pointed there.

use std::fs;
use std::path::{Path, PathBuf};

/// Packages the page loads, from node_modules (installed by `npm ci`).
const PACKAGES: &[&str] = &[
    "@xterm/xterm",
    "@xterm/addon-fit",
    "@xterm/addon-image",
    "@xterm/addon-search",
    "@xterm/addon-unicode11",
    "@xterm/addon-web-links",
    "@fontsource/jetbrains-mono",
    "@novnc/novnc",
];

fn skip(name: &str) -> bool {
    name == "src" || name == "typings" || name == "node_modules" || name.ends_with(".map") || name.ends_with(".ts")
}

/// Copy a folder; in .html/.js/.css files, rewrite "node_modules/" references to "vendor/".
fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap_or_else(|e| panic!("{}: {e}", from.display())) {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if skip(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            copy_dir(&path, &to.join(&name));
        } else if name.ends_with(".html") || name.ends_with(".js") || name.ends_with(".css") || name.ends_with(".mjs") {
            let text = fs::read_to_string(&path).unwrap();
            fs::write(to.join(&name), text.replace("node_modules/", "vendor/")).unwrap();
        } else {
            fs::copy(&path, to.join(&name)).unwrap();
        }
    }
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web");
    let _ = fs::remove_dir_all(&web);
    copy_dir(&root.join("src/renderer"), &web.join("src/renderer"));
    for pkg in PACKAGES {
        let src = root.join("node_modules").join(pkg);
        assert!(src.exists(), "{} is missing: run `npm ci` first", src.display());
        copy_dir(&src, &web.join("vendor").join(pkg));
    }
    println!("cargo:rerun-if-changed=../src/renderer");
    println!("cargo:rerun-if-changed=../package-lock.json");
    let rustc = std::process::Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=TERMCRAFT_RUSTC={}", rustc.trim_start_matches("rustc ").split(' ').next().unwrap_or(""));
    tauri_build::build();
}
