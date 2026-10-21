// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! The application menu. Items send their action to the page ("menu:action"); a few are
//! handled here (quit, full screen, developer tools, README).

use crate::json::{arr, bool_at, str_at, string};
use serde_json::Value;
use tauri::menu::{AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

const MAC: bool = cfg!(target_os = "macos");

/// On macOS Cmd shortcuts don't collide with the terminal; elsewhere Ctrl+Shift avoids stealing
/// Ctrl+C etc.
fn m(key: &str) -> String {
    if MAC { format!("Cmd+{key}") } else { format!("Ctrl+Shift+{key}") }
}

/// Menu item ids: "a:<action>" goes to the page, "r:<n>" is recent script n, "x:<name>" is
/// handled by the backend.
pub fn build<R: Runtime>(app: &AppHandle<R>, state: &Value, copyright: &str) -> tauri::Result<Menu<R>> {
    let item = |label: &str, action: &str, accel: Option<String>| {
        let mut b = MenuItemBuilder::with_id(format!("a:{action}"), label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let check = |label: &str, action: &str, key: &str, accel: Option<String>| {
        let mut b = CheckMenuItemBuilder::with_id(format!("a:{action}"), label).checked(bool_at(state, &[key]));
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let layout = |label: &str, value: &str, key: &str| {
        let current = Some(str_at(state, &["layout"])).filter(|l| !l.is_empty()).unwrap_or_else(|| "tabs".into());
        let mut b = CheckMenuItemBuilder::with_id(format!("a:layout:{value}"), label).checked(current == value);
        if MAC {
            b = b.accelerator(format!("Cmd+Alt+{key}"));
        }
        b.build(app)
    };
    let sep = || PredefinedMenuItem::separator(app);

    let menu = Menu::new(app)?;
    if MAC {
        let about = AboutMetadataBuilder::new().name(Some("TermCraft")).version(Some(env!("CARGO_PKG_VERSION"))).copyright(Some(copyright)).build();
        let app_menu = SubmenuBuilder::new(app, "TermCraft")
            .item(&PredefinedMenuItem::about(app, Some("About TermCraft"), Some(about))?)
            .separator()
            .item(&item("Settings…", "globalOptions", Some("Cmd+,".into()))?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&MenuItemBuilder::with_id("x:quit", "Quit TermCraft").accelerator("Cmd+Q").build(app)?)
            .build()?;
        menu.append(&app_menu)?;
    }

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("Quick Connect…", "quickConnect", Some(m("Q")))?)
        .item(&item("Connect…  (Session Manager)", "connectDialog", Some(m("O")))?)
        .item(&item("Connect in Tab…", "connectDialog#2", Some(m("T")))?)
        .item(&item("New Local Shell Tab", "localShell", Some(m("L")))?)
        .item(&item("Connect SFTP Tab", "sftpTab", Some(m("P")))?)
        .item(&item("SCP Transfer Manager", "scpTab", Some(m("U")))?)
        .item(&sep()?)
        .item(&item("Clone Session", "cloneTab", Some(m("D")))?)
        .item(&item("Reconnect", "reconnect", Some(m("R")))?)
        .item(&item("Reconnect All", "reconnectAll", None)?)
        .item(&item("Disconnect", "disconnect", None)?)
        .item(&item("Disconnect All", "disconnectAll", None)?)
        .item(&sep()?)
        .item(&check("Log Session", "toggleLog", "logging", None)?)
        .item(&item("Log Session As…", "logAs", None)?)
        .item(&item("Save Output As…", "saveOutput", None)?)
        .item(&sep()?)
        .item(&item("Close Tab", "closeTab", Some(if MAC { "Cmd+W".into() } else { "Ctrl+Shift+W".into() }))?);
    if !MAC {
        file = file.separator().item(&MenuItemBuilder::with_id("x:quit", "Exit").build(app)?);
    }
    menu.append(&file.build()?)?;

    menu.append(
        &SubmenuBuilder::new(app, "Edit")
            .item(&item("Copy", "copy", Some(m("C")))?)
            .item(&item("Paste", "paste", Some(m("V")))?)
            .item(&item("Copy and Paste", "copyPaste", None)?)
            .item(&item("Paste as Single Line", "pasteSingle", None)?)
            .item(&item("Select All", "selectAll", Some(m("A")))?)
            .item(&sep()?)
            .item(&item("Find…", "find", Some(m("F")))?)
            .item(&sep()?)
            .item(&item("Clear Scrollback", "clearScrollback", Some(m("K")))?)
            .item(&item("Clear Screen", "clearScreen", None)?)
            .item(&item("Clear Screen and Scrollback", "clearAll", None)?)
            .item(&item("Reset Terminal", "resetTerminal", None)?)
            .item(&sep()?)
            .item(&item("Send Break", "sendBreak", None)?)
            .build()?,
    )?;

    let mut view = SubmenuBuilder::new(app, "View")
        // Cmd+M is macOS "Minimize window", so the Session Manager uses Cmd+Shift+M there.
        .item(&check("Session Manager", "toggleSessionManager", "showSessionManager", Some(if MAC { "Cmd+Shift+M".into() } else { "Ctrl+Shift+M".into() }))?)
        .item(&check("Maximize Terminal Area", "focusMode", "focusMode", Some(if MAC { "Cmd+Shift+Enter".into() } else { "Ctrl+Shift+Enter".into() }))?)
        .item(&check("Button Bar", "toggleButtonBar", "showButtonBar", None)?)
        .item(&check("Command Buffer", "toggleCommandWindow", "showCommandWindow", Some(m("E")))?)
        .item(&check("Status Bar", "toggleStatusBar", "showStatusBar", None)?)
        .item(&sep()?)
        .item(&item("Increase Font Size", "fontBigger", Some(if MAC { "Cmd+=".into() } else { "Ctrl+=".into() }))?)
        .item(&item("Decrease Font Size", "fontSmaller", Some(if MAC { "Cmd+-".into() } else { "Ctrl+-".into() }))?)
        .item(&item("Reset Font Size", "fontReset", Some(if MAC { "Cmd+0".into() } else { "Ctrl+0".into() }))?)
        .item(&sep()?)
        .item(&MenuItemBuilder::with_id("x:fullscreen", "Toggle Full Screen").accelerator(if MAC { "Ctrl+Cmd+F" } else { "F11" }).build(app)?);
    if cfg!(debug_assertions) {
        view = view
            .item(&MenuItemBuilder::with_id("x:devtools", "Toggle Developer Tools").accelerator(if MAC { "Alt+Cmd+I" } else { "Ctrl+Shift+I" }).build(app)?);
    }
    menu.append(&view.build()?)?;

    menu.append(
        &SubmenuBuilder::new(app, "Options")
            .item(&item("Session Options…", "sessionOptions", Some(m("S")))?)
            .item(&item("Settings…", "globalOptions#2", if MAC { None } else { Some("Ctrl+,".into()) })?)
            .item(&sep()?)
            .item(&item("Edit Button Bar…", "editButtons", None)?)
            .item(&item("Keyword Highlighting…", "editHighlights", None)?)
            .item(&item("Keyboard Map…", "editKeymap", None)?)
            .item(&sep()?)
            .item(&check("Send Keystrokes to All Tabs", "toggleBroadcast", "broadcast", Some(m("B")))?)
            .build()?,
    )?;

    menu.append(
        &SubmenuBuilder::new(app, "Transfer")
            .item(&item("Connect SFTP Tab", "sftpTab#2", None)?)
            .item(&item("SCP Transfer Manager", "scpTab#2", None)?)
            .item(&item("TFTP Server", "tftpServer", None)?)
            .item(&sep()?)
            .item(&item("Send ASCII File…", "sendAscii", None)?)
            .item(&item("Send XMODEM…", "xmodemSend", None)?)
            .item(&item("Send XMODEM-1K…", "xmodemSend1k", None)?)
            .item(&item("Send YMODEM…", "ymodemSend", None)?)
            .item(&item("Send ZMODEM…", "zmodemSend", None)?)
            .item(&item("Receive XMODEM…", "xmodemReceive", None)?)
            .item(&item("Receive YMODEM…", "ymodemReceive", None)?)
            .item(&item("Receive ZMODEM…", "zmodemReceive", None)?)
            .items(&rns_transfer(app, state)?.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect::<Vec<_>>())
            .build()?,
    )?;

    let mut script = SubmenuBuilder::new(app, "Script")
        .item(&item("Run…", "runScript", Some(if MAC { "Cmd+Shift+J".into() } else { "Ctrl+Shift+J".into() }))?)
        .item(&item("Cancel Running Scripts", "cancelScripts", None)?)
        .item(&sep()?)
        .item(&item("Open Example Scripts Folder", "openExamples", None)?);
    let recent = arr(&state["recentScripts"]);
    if !recent.is_empty() {
        script = script.separator().item(&MenuItemBuilder::with_id("x:none", "Recent Scripts").enabled(false).build(app)?);
        for (i, f) in recent.iter().enumerate() {
            script = script.item(&MenuItemBuilder::with_id(format!("r:{i}"), string(f)).build(app)?);
        }
    }
    menu.append(&script.build()?)?;

    menu.append(
        &SubmenuBuilder::new(app, "Tools")
            .item(&item("Run Commands on Sessions…", "runCommands", if MAC { Some("Cmd+Shift+R".into()) } else { None })?)
            .item(&sep()?)
            .item(&item("Credentials…", "manageCredentials", None)?)
            .item(&item("SSH Keys…", "sshKeys", None)?)
            .item(&item("Install SSH Key on Server…", "installKey", None)?)
            .item(&item("Manage Known Hosts…", "knownHosts", None)?)
            .item(&sep()?)
            .item(&item("Import Hosts (CSV / list)…", "importHosts", None)?)
            .item(&item("Import ~/.ssh/config", "importSshConfig", None)?)
            .item(&item("Import Sessions…", "importSessions", None)?)
            .item(&item("Export Sessions…", "exportSessions", None)?)
            .item(&sep()?)
            .item(&item("Open Log Folder", "openLogFolder", None)?)
            .items(&rns_tools(app, state)?.iter().map(|i| i.as_ref()).collect::<Vec<_>>())
            .build()?,
    )?;

    let mut window = SubmenuBuilder::new(app, "Window")
        .item(&layout("Tabs", "tabs", "1")?)
        .item(&layout("Stacked (one above another)", "tile-h", "2")?)
        .item(&layout("Side by Side", "tile-v", "3")?)
        .item(&layout("Grid", "grid", "4")?)
        .item(&sep()?)
        .item(&item("Next Tab", "nextTab", Some(if MAC { "Cmd+Shift+]".into() } else { "Ctrl+Tab".into() }))?)
        .item(&item("Previous Tab", "prevTab", Some(if MAC { "Cmd+Shift+[".into() } else { "Ctrl+Shift+Tab".into() }))?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::minimize(app, None)?);
    if MAC {
        window = window.item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?);
    }
    menu.append(&window.build()?)?;

    let mut help: SubmenuBuilder<'_, R, AppHandle<R>> = SubmenuBuilder::new(app, "Help");
    if !MAC {
        help = help.item(&item("About TermCraft", "about", None)?).separator();
    }
    let help: Submenu<R> = help
        .item(&item("Keyboard Shortcuts", "shortcuts", None)?)
        .item(&item("Scripting Reference", "scriptHelp", None)?)
        .item(&item("License (GPL-2.0-or-later)", "license", None)?)
        .item(&MenuItemBuilder::with_id("x:readme", "Project README").build(app)?)
        .build()?;
    menu.append(&help)?;
    Ok(menu)
}

/// Reticulum items in the Transfer menu (only when Reticulum is turned on in Settings).
fn rns_transfer<R: Runtime>(app: &AppHandle<R>, state: &Value) -> tauri::Result<Vec<tauri::menu::MenuItem<R>>> {
    if !bool_at(state, &["reticulum"]) {
        return Ok(vec![]);
    }
    Ok(vec![
        MenuItemBuilder::with_id("a:rnsSend", "Send File over Reticulum (rncp)…").build(app)?,
        MenuItemBuilder::with_id("a:rnsFetch", "Fetch File over Reticulum (rncp)…").build(app)?,
    ])
}

/// The Tools → Reticulum submenu: the network engineer's tools, by destination hash.
fn rns_tools<R: Runtime>(app: &AppHandle<R>, state: &Value) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<R>>>> {
    if !bool_at(state, &["reticulum"]) {
        return Ok(vec![]);
    }
    let i = |id: &str, label: &str| MenuItemBuilder::with_id(format!("a:{id}"), label).build(app);
    let sub = SubmenuBuilder::new(app, "Reticulum")
        .item(&i("rnsConnect", "Connect to Destination Hash… (rnsh)")?)
        .item(&i("rnsExec", "Run Remote Command… (rnx)")?)
        .separator()
        .item(&i("rnsProbe", "Probe Destination… (rnprobe)")?)
        .item(&i("rnsPath", "Find Path to Destination… (rnpath)")?)
        .item(&i("rnsPaths", "Path Table (rnpath -t)")?)
        .item(&i("rnsStatus", "Interface Status (rnstatus)")?)
        .separator()
        .item(&i("rnsIdentity", "Show My rnsh Identity")?)
        .build()?;
    Ok(vec![Box::new(PredefinedMenuItem::separator(app)?), Box::new(sub)])
}

/// The action for a menu item id: ("page", action, arg) or ("backend", name).
pub enum Action {
    Page(String, Value),
    Backend(String),
}

pub fn action_for(id: &str, state: &Value) -> Option<Action> {
    if let Some(a) = id.strip_prefix("a:") {
        // "#2" distinguishes duplicate items (same action in two menus).
        let a = a.split('#').next().unwrap_or(a);
        return Some(Action::Page(a.to_string(), Value::Null));
    }
    if let Some(i) = id.strip_prefix("r:") {
        let f = arr(&state["recentScripts"]).get(i.parse::<usize>().ok()?)?.clone();
        return Some(Action::Page("runScript".into(), f));
    }
    id.strip_prefix("x:").map(|x| Action::Backend(x.to_string()))
}
