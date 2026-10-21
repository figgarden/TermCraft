<p align="center">
  <img src="docs/banner.png" alt="TermCraft — free and open-source SSH, Telnet and serial terminal" width="100%">
</p>

<p align="center">
  <a href="https://github.com/figgarden/TermCraft/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/figgarden/TermCraft/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/figgarden/TermCraft/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/figgarden/TermCraft?color=e0532c"></a>
  <a href="LICENSE"><img alt="License: GPL-2.0-or-later" src="https://img.shields.io/badge/license-GPL--2.0--or--later-2e8b85"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-e2a93b">
</p>

**TermCraft** is a free and open-source terminal and session manager for people who live on remote machines. It handles SSH, Telnet, serial consoles, SFTP/SCP transfers, VNC and RDP, organized in one place, with jump hosts, port forwarding, button bars and scripting.

<p align="center">
  <img src="docs/screenshots/stacked-sessions.png" alt="Three sessions stacked: a web server, a database and a network switch, with the Network Devices button bar" width="100%">
</p>

## Download

Get the latest version from **[Releases](https://github.com/figgarden/TermCraft/releases/latest)**:

| Platform | File |
|---|---|
| **macOS** (Apple silicon & Intel) | `.dmg` (or `.zip`) |
| **Windows** 10/11 (x64) | `Setup .exe` installer, or the portable `.exe` |
| **Linux** (x64) | `.AppImage`, `.deb` (Debian/Ubuntu) or `.rpm` (Fedora/RHEL) |

> **First launch on macOS:** TermCraft isn't notarized with Apple yet, so macOS will say it can't verify the developer. Open it once from **System Settings → Privacy & Security → Open Anyway**. **On Windows**, SmartScreen may ask for confirmation (**More info → Run anyway**).

## Highlights

- **Every protocol in one place:** SSH2, Telnet, Rlogin, serial, raw TCP, local shells, plus a built-in **VNC** viewer and **RDP** launching.
- **Session Manager:** folders, filter, drag and drop, import from `~/.ssh/config`, and connecting a whole folder at once.
- **Reach anything:** jump hosts, local/remote/SOCKS port forwarding, and SSH tunnels for VNC and RDP.
- **Work faster:** button bars (one set per device type), a command window that types into every tab, keyword highlighting and JavaScript automation.
- **Move files:** a two-pane SFTP browser and an SCP transfer manager, both of which work through jump hosts.
- **Your layout:** tabs, stacked, side by side or grid. Collapse everything for a full-screen terminal.
- **Appearance:** pick a theme family (Catppuccin, Nord, Solarized, Dracula, Gruvbox, Tokyo Night, One, Rosé Pine, Everforest, Kanagawa, GitHub, Tomorrow…) and **Light, Dark or Auto**, like macOS: Auto uses the family's light variant by day and its dark variant at night. The window and terminals share one palette, with a live preview; terminals can use a different palette if you want. The JetBrains Mono font is built in, with adjustable size, line spacing, margins and cursor.
- **Secure by default:** host-key verification, logins encrypted in your OS keychain, and a sandboxed UI. See [SECURITY.md](SECURITY.md).

| | |
|---|---|
| ![SCP transfer manager through a jump host](docs/screenshots/scp-transfers.png) | ![Session options with a jump host](docs/screenshots/session-options.png) |
| **SCP transfers** through a jump host | **Session options:** jump host, keep-alive, forwarding |
| ![Button bar editor](docs/screenshots/button-bars.png) | ![Appearance settings](docs/screenshots/themes.png) |
| **Button bars** for every kind of device | **Appearance:** 13 theme families, Light / Dark / Auto, live preview |

## Features

| Area | What's included |
|---|---|
| **Protocols** | SSH2, Telnet (with option negotiation: NAWS, TTYPE, ECHO, SGA, BINARY), Rlogin, Serial (COM/tty with baud, data bits, parity, stop bits, flow control), Raw TCP, Local Shell (PTY), VNC (built in), RDP (via the system client) |
| **SSH2 auth** | Public key (with passphrase prompt), keyboard-interactive (MFA), password with retry, SSH agent (ssh-agent, Pageant, Windows OpenSSH agent). You choose the method order. |
| **SSH2 extras** | Host key verification with a known-hosts store and a warning when a key changes, jump host / firewall chaining, local, remote and dynamic (SOCKS4/4a/5) port forwarding, X11 forwarding, agent forwarding, compression, keep-alive, protocol trace, cipher shown in the status bar |
| **Session Manager** | Folder tree, filter, drag and drop, connect a whole folder, duplicate, rename, per-session options, **tab colors** per session or folder (e.g. red for production), import from `~/.ssh/config` (including ProxyJump), JSON import and export |
| **Shared credentials** | One login (username + password and/or key) used by many sessions, such as a TACACS/RADIUS or domain account. Change the password once and every device uses it — or log in once with the new password and choose "Save login". Encrypted with the OS keychain. |
| **Bulk import** | Import hundreds of devices from a CSV (inventory/IPAM export or spreadsheet) or a plain host list. Columns are matched by header: name, host/IP, port, protocol, username, folder/site (`HQ/Core` creates subfolders), credential, jump host, notes. Duplicates are skipped. |
| **Run commands on many sessions** | Pick sessions or a whole folder, enter commands, and TermCraft runs them in the background over SSH2, Telnet, Rlogin or Serial — 1 to 20 at a time — and saves each device's output to its own file. Telnet/serial logins are answered automatically and `--More--` pagers are handled for every major vendor, so no `terminal length 0` is needed. Good for audits, config backups and "show version" across a site. |
| **Auto-login** | Telnet, Rlogin and serial consoles answer `Username:` / `Password:` prompts with the session's login or its credential (once each, only right after connecting). |
| **Quick Connect** | Dialog (`⌘Q` / `Ctrl+Shift+Q`) plus an "Enter host" box in the toolbar that accepts `user@host:port` and `telnet://host` |
| **Tabs & tiling** | Tabs, tile vertically, tile horizontally, grid. Clone session, reconnect (Enter on a dead tab), auto-reconnect, activity indicators, drag to reorder, rename |
| **Inline images** | The **Kitty graphics protocol** (PNG, RGB/RGBA, zlib, chunked transfers, placement, delete and the support query that tools like `chafa`, `timg`, `yazi` and `ranger` use), plus **Sixel** and **iTerm2** inline images. Only images sent inline are shown: a remote host can never make TermCraft read local files. |
| **Terminal** | xterm-256color/VT100/VT220/ANSI/Linux, truecolor, Unicode 11, 8 color schemes, per-session fonts and cursor, scrollback, find (regex, case), clickable links (Ctrl/⌘+click), character encodings |
| **Save output** | Save a tab's whole scrollback to a text file (File → Save Output As…). |
| **Clipboard** | Copy on select, right-click paste, confirm before a multi-line paste, configurable delay between pasted lines, paste as a single line, Send ASCII File |
| **Button bars** | Multiple named bars (e.g. Linux, Network Devices, Tools) with a dropdown to switch between them. Button functions are Send String, Send String to All Tabs, Run Script, Connect Session, Menu Function and Launch Application. Strings support `\r \n \t \e \xHH` escapes, `\p` (pause 1 s) and `${prompt:Label}` (ask for a value when clicked). Right-click to add, edit, duplicate, delete, move or copy buttons to another bar, or drag to reorder. Buttons can have colors and tooltips. A session can always show a particular bar. Bars can be imported and exported as JSON. |
| **Command Buffer** | Prepare commands before they reach the device (View → Command Buffer, ⌘E / Ctrl+Shift+E). **Command mode** is a strip below the terminal: type, press Enter to send, ↑/↓ for history. **Script mode** is an editor beside the terminal, half and half, in the style of WinFIOL: ⌘/Ctrl+Enter sends the line at the cursor and moves to the next, or send a selection or the whole script, pausing between lines until the device's prompt returns (or a fixed delay), with the line being sent highlighted and a Stop button. Send to the current, visible or all tabs; open and save command files; the buffer is kept between sessions. |
| **Productivity** | Broadcast keystrokes to all tabs, keyboard mapping, keyword highlighting with ready-made **Network devices** (interface down, err-disabled, syslog severities, IPs, MACs, interface names) and **Linux servers** rule sets |
| **Automation** | Logon actions (expect/send), logon scripts, anti-idle, JavaScript scripting with a `tc` automation API |
| **Logging** | Per-session logs with filename tokens (`%S %H %P %U %Y %M %D %h %m %s`), timestamps on each line, append or overwrite, plain-text or raw |
| **SFTP** | Dual-pane local and remote file manager with upload and download, recursive folders, drag and drop from your OS, rename, delete, mkdir, chmod and a transfer queue with progress |
| **SCP Transfer Manager** | A queue of SCP uploads and downloads (files, folders, wildcards) with progress, speed, time left, cancel and retry, parallel transfers, and drag-and-drop from Finder or Explorer. It connects directly, or through a jump host: the session's own, any saved session, or a one-off `user@host:port`. It speaks the SCP protocol itself, so it works with servers and network devices that have no SFTP. File names sent by the server are validated, which blocks path traversal from a malicious server (CVE-2019-6111 style). |
| **TFTP server** | Built-in TFTP server (Transfer → TFTP Server) for IOS/firmware images and config backups, with the blksize/tsize/timeout options for fast transfers of large images. It serves one folder only, uploads are off unless enabled, existing files are never replaced unless allowed, and it shows the exact `copy tftp://…` command to type on the device. |
| **ZMODEM / YMODEM / XMODEM** | Send and receive files over any terminal tab (serial console, SSH, Telnet). **ZMODEM starts by itself**: when the device runs `rz`, TermCraft asks for the files; when it runs `sz`, files download to your Downloads folder. Several files are sent as a **series in the order you choose** (remembered per session). YMODEM batch and XMODEM/XMODEM-1K cover bootloaders — U-Boot `loady`/`loadx`, ROMMON `xmodem -c flash:…`. Tested against the standard `lrzsz` (`rz`/`sz`) tools, including recovery from line errors. |
| **SSH keys** | Create Ed25519, RSA or ECDSA keys in `~/.ssh` (with a passphrase), copy public keys, and **install a key on a server** like `ssh-copy-id` (right-click a session → Install SSH Key…). |
| **VNC** | A built-in viewer (noVNC) in its own tab. It connects directly or **through an SSH tunnel** to a saved SSH session. It supports VNC password, Apple Remote Desktop (macOS Screen Sharing), VeNCrypt and RSA-AES authentication; fit-to-window, remote resize or actual size; view-only mode; clipboard sync; and Ctrl+Alt+Del. Logins can be saved like SSH logins. |
| **RDP** | Saved RDP sessions (domain, size or full screen, multi-monitor, admin console) that TermCraft launches with the system's own client: Windows App on macOS, Remote Desktop Connection on Windows, FreeRDP or Remmina on Linux. You can also set a custom command. It can open an **SSH tunnel** first and point the client at it. On Linux, a saved password goes to FreeRDP on stdin, never on the command line. |
| **Reticulum (optional)** | Off until you turn it on (Settings → General → Reticulum). Then devices on a [Reticulum](https://reticulum.network) network are reached by **destination hash** instead of IP, with the same tools as IP networks: **RNSH** sessions (`rnsh`, the SSH of Reticulum) saved in the Session Manager or opened by typing a hash in Quick Connect, with logging, logon actions and Run Commands on Sessions; **send and fetch files** with `rncp` (Transfer menu); and Tools → Reticulum for **remote commands** (`rnx`), **probes** (`rnprobe`, like ping), **path lookup and the path table** (`rnpath`, like traceroute and a routing table), **interface status** (`rnstatus`) and your rnsh **identity hash** for listeners' allow lists. TermCraft runs the official Reticulum programs (`pipx install rns` and `pipx install rnsh`), using your Reticulum config or one you choose. |
| **Security** | Saved passwords and passphrases are encrypted with a key kept in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Secrets never reach the UI. On macOS, logins saved by earlier (Electron) versions still decrypt. |

## Getting started

TermCraft is written in Rust with [Tauri](https://tauri.app): the backend (connections, transfers, storage, scripting) is the Rust crate in `src-tauri/`, and the window shows the web UI in `src/renderer/` in the system's web view (WebKit on macOS and Linux, WebView2 on Windows).

You need [Rust](https://rustup.rs) (stable), Node.js (for the UI's browser libraries and the end-to-end tests), the Tauri CLI (`cargo install tauri-cli --version "^2"`), and on Linux the WebKitGTK and udev development packages (`sudo apt install libwebkit2gtk-4.1-dev libudev-dev libssl-dev build-essential`).

```bash
npm install          # the UI's browser libraries (xterm.js, noVNC, fonts)
npm start            # build and run (cargo run)
```

## Building installers

```bash
npm run dist         # cargo tauri build: .app + .dmg on macOS, .msi/.exe on Windows, .deb/.rpm/AppImage on Linux
```

Build each platform on that platform, or push a `v*` tag and let `.github/workflows/release.yml` build all three. macOS distribution builds need a signing identity.

## Scripting

Scripts are plain JavaScript and support top-level `await`. The automation object is `tc` (`crt` is also accepted, for compatibility with scripts written for other terminal emulators). Run one with **Script → Run…**, attach it to a button, map it to a key, or set it as a session's logon script. Examples are in `examples/scripts/`.

```js
tc.Screen.Send("show version\r");
await tc.Screen.WaitForString("#", 10);                 // true or false on timeout
const i = await tc.Screen.WaitForStrings(["$", "#"], 5); // 1-based index, 0 on timeout
const out = await tc.Screen.ReadString("#", 10);         // text before the match
const screen = await tc.Screen.Get();                    // visible screen text
const host = await tc.Dialog.Prompt("Host?");
const tab = await tc.Session.Connect("Core Router");     // saved name or user@host:port
tab.Session.Log(true);
console.log("printed into the terminal");
```

Scripts run in an embedded JavaScript engine (QuickJS) on their own thread, with your own privileges. `require` gives a subset of Node's modules: `fs` (read, write, append, exists, mkdir, readdir, stat, rename, rm; the `Sync` forms, plus `fs.promises` and callbacks), `path`, `os`, `child_process` (`execSync`, `execFileSync`, `spawnSync`) and `crypto` (`createHash`, `randomBytes`, `randomUUID`). Files are read and written as text. `setTimeout`/`setInterval` work. `net` is not available. Only run scripts you trust.

## Tests

```bash
npm test           # Rust unit, integration and security tests (cargo test) + the UI's own tests
npm run test:e2e   # end-to-end suites in the real app (a debug build)
npm run lint       # cargo clippy, warnings as errors
npm run test:all   # all of the above, plus npm audit and cargo audit
```

The Rust tests cover the Telnet and SOCKS parsers, the store and keychain encryption, XMODEM/YMODEM/ZMODEM (also against the real `lrzsz` tools when installed), TFTP, SCP (against the real `scp` binary), the scripting engine, and integration tests that run the SSH client against an in-process SSH server: password and keyboard-interactive logins, host keys, saving logins, shells, local and SOCKS forwarding, jump hosts, SFTP, SCP, VNC and RDP tunnels, logon actions, `WaitFor` and timestamped logging.

The end-to-end suites in `test/smoke/` drive the real window. Run one with `npm run test:e2e -- ui` (any suite name prefix). They use a test-control channel that exists only in debug builds and only when `TERMCRAFT_CONTROL=1` is set; on macOS they also save screenshots (`TERMCRAFT_SHOTS=/tmp/shots`).

## Roadmap (not yet implemented)

- SSH1, Kerberos/GSSAPI auth, PKCS#11 and smart cards, X.509 certificates
- X/Y/Zmodem and Kermit file transfer (SFTP and SCP cover most uses)
- VBScript, Python or Perl scripting (JavaScript only) and a script recorder
- A text-mode `sftp>` tab (TermCraft has a GUI file manager instead)
- Printing, and multiple top-level windows (TermCraft uses one window with tabs and tiling)
- Rlogin from a privileged source port (many rlogind servers require one)
- A built-in RDP renderer. No embeddable RDP client is GPLv2-compatible (FreeRDP is Apache-2.0), so RDP uses the system client.
- Sending in non-Latin multibyte encodings (receiving works for Shift-JIS, GBK, Big5 and others; sending supports UTF-8 and the Latin-1 family)

## Design

> **The mark:** the prompt `>_` drawn as a connection. The top arm (mustard) is you and the bottom arm (teal) is the server. They meet at a vermilion joint, the jump host. The cream `_` cursor means connected and ready. It uses one line weight, round ends and flat warm inks on charcoal, in a mid-century modernist style.

## Layout

```
src-tauri/           the app (Rust, Tauri)
  src/app.rs         window, every call the UI makes, native dialogs
  src/menu.rs        application menu
  src/store.rs       sessions, settings and known hosts (JSON in the data folder, secrets encrypted)
  src/safe_storage.rs  keychain-backed encryption of saved logins
  src/conn_manager.rs  per-tab connections, decoding, logging, logon actions, waiters
  src/proto/         ssh.rs, simple.rs (telnet/rlogin/raw), serial.rs, local.rs, telnet_parser.rs, socks.rs
  src/scripting.rs   tc.* scripting engine (QuickJS; the API is in script_prelude.js)
  src/sftp_service.rs, scp.rs, scp_service.rs, xmodem.rs, zmodem.rs, tftp.rs, batch.rs, remote_desktop.rs
src/renderer/        UI (vanilla ES modules, xterm.js); js/tauri-api.js is its bridge to the backend
examples/scripts/    sample scripts
test/                the UI's node:test suites and the end-to-end suites (test/smoke)
```

## License

TermCraft is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License as published by the Free Software Foundation, either version 2 of the License, or (at your option) any later version.** See [LICENSE](LICENSE) for the full text.

TermCraft is distributed in the hope that it will be useful, but **without any warranty**; without even the implied warranty of merchantability or fitness for a particular purpose.

Every source file carries an SPDX tag: `SPDX-License-Identifier: GPL-2.0-or-later`. Bundled third-party packages are under GPL-compatible licenses (MIT, BSD, ISC, Unlicense, MPL-2.0 for noVNC, whose secondary-license clause allows combination with the GPL, and Apache-2.0 for some Rust crates, which is compatible with GPLv3), listed with their full texts in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Regenerate that file with `npm run notices` after changing dependencies.

The artwork in `build/`, `docs/` and `src/renderer/assets/` is generated by `scripts/icon-art.js` and is covered by the same license. Rebuild it with `npm run icons`.

## Security

See [SECURITY.md](SECURITY.md) for the security model and how to report vulnerabilities. `npm run test:all` runs the unit, integration and security regression tests, the end-to-end suites (including in-app attack tests) and a dependency audit.

## Contributing

Contributions are welcome. TermCraft uses the [Developer Certificate of Origin](https://developercertificate.org/), as the Linux kernel does: sign off each commit with `git commit -s`. See [CONTRIBUTING.md](CONTRIBUTING.md).
