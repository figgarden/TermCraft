# Changelog

All notable changes to TermCraft are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-16

### Added — for network engineers and Linux admins
- **Shared credentials** (Tools → Credentials): one login used by many sessions; update the password once for every device. Saving a new password at the login prompt updates the credential.
- **Bulk import** of hosts from a CSV or a plain list (Tools → Import Hosts), with folders, credentials and jump hosts matched by name.
- **Run Commands on Sessions** (Tools menu, or right-click a folder): run commands on many devices in the background and save each device's output to its own file. Handles Telnet/serial logins and `--More--` pagers.
- **Auto-login** for Telnet, Rlogin and serial consoles: answers `Username:`/`Password:` prompts from the session or its credential.
- **TFTP server** (Transfer → TFTP Server) for images and config backups.
- **ZMODEM** send and receive, started automatically when the device runs `rz` or `sz` (like SecureCRT), with recovery from line errors. Tested against `lrzsz`.
- **XMODEM, XMODEM-1K and YMODEM** send and receive over any terminal tab (Transfer menu and the terminal's right-click menu), for bootloaders such as U-Boot `loady`/`loadx` and ROMMON.
- **Send a series of files in order**: choosing several files for ZMODEM or YMODEM opens an ordering list, and the order is remembered for the session.
- **SSH key tools**: create keys and install a public key on a server (Tools → SSH Keys, right-click a session → Install SSH Key).
- **Inline images**: the Kitty graphics protocol, Sixel and iTerm2 images in terminal tabs (Settings → General). The terminal engine moves to xterm.js 6.1 (pinned beta build) for this.
- **Tab colors** per session or folder, shown on tabs, panes and in the Session Manager.
- **Save Output As…** saves a tab's whole scrollback to a text file.
- Ready-made **Network devices** and **Linux servers** keyword-highlighting rules (Settings → Keyword Highlighting).
- **Command Buffer** (replaces the Command Window): a SecureCRT-style command strip below the terminal, or a WinFIOL-style script editor beside it that sends line by line (⌘/Ctrl+Enter steps through the script), a selection or everything, waiting for the device prompt between lines, with Stop, line numbers and command files. Open it from its toolbar button or ⌘E / Ctrl+Shift+E.

### Changed — appearance
- **One Appearance screen** (Settings → Appearance) replaces the theme grid and the separate color-scheme settings: choose a theme family and Light, Dark or Auto (follows the system), with variants where a family has several (e.g. Catppuccin Frappé / Macchiato / Mocha) and a live preview of the window and a terminal. Your current theme is carried over.
- **Terminal colors** match the theme by default; a different palette can be chosen for all terminals or per session ("Terminal colors" in Session Options), with the same list and wording everywhere.
- **Typography**: JetBrains Mono is built in (same look on every computer), with font size, line spacing (Tight / Normal / Relaxed), margins (Compact / Comfortable / Spacious) and cursor style.
- **New icon set** for the toolbar and Session Manager, quieter toolbar and button bar, tabs that blend into their terminal, slim scrollbars, and a small dot (instead of italic text) for tabs with new output.
- On **macOS** the toolbar is the title bar, and native parts (window controls, scrollbars, dialogs) follow the chosen light or dark appearance.
- **Sending to all tabs** is easier to notice: the broadcast button and the toolbar underline turn red, and the Command Buffer's "All tabs" target is outlined in red.
- "Global Options" is now **Settings** (⌘, on macOS, Ctrl+, elsewhere).

### Fixed
- Local Shell tabs now pass raw bytes instead of re-encoding them as UTF-8 (on macOS and Linux), so binary transfers and non-UTF-8 encodings work there.
- Telnet, Rlogin and Raw TCP connections to an unreachable host now fail after the session's connect timeout (default 20 s) instead of waiting a minute or more.
- Button errors (for example, a program that doesn't exist) are now shown instead of failing silently.
- Session-type and add-button symbols no longer show as empty boxes on Linux: session types use short labels (SSH, TEL, COM, …) and the add buttons use the icon set.

### Security
- "Launch Application" buttons now run the program directly instead of through a shell, so `;`, `|`, `&&`, `$( )` and backticks are passed as plain text and can't chain extra commands. Each new command must be approved once in a native system dialog (Cancel, Run Once or Always Allow). Approvals are stored in a file the UI can't write, so an imported button bar can't approve its own commands. Windows batch files must now be started as `cmd /c file.bat`.

## [0.1.1] — 2026-10-15

### Fixed
- macOS builds now include the Electron and Chromium license notices (`Contents/Resources/licenses/`), which were missing from 0.1.0 on macOS. The release pipeline now fails if any license notice is missing.

## [0.1.0] — 2026-10-15

First public release.

### Connections
- SSH2 with public-key, keyboard-interactive (MFA), password and agent authentication; host-key verification; jump hosts; local, remote and SOCKS port forwarding; X11 and agent forwarding.
- Telnet, Rlogin, serial (COM/tty), raw TCP and local shells.
- Built-in **VNC** viewer (noVNC), direct or through an SSH tunnel; **RDP** sessions launched with the system client, optionally through an SSH tunnel.

### Productivity
- Session Manager with folders, filter, drag and drop, `~/.ssh/config` import, and connecting a whole folder at once.
- Tabs or tiled layouts (stacked, side by side, grid) and a full-screen terminal mode.
- Button bars with multiple named sets, per-session bars, prompts and pauses.
- Command window and broadcast typing, keyword highlighting, keyboard mapping, logon actions, logging, and JavaScript automation (`tc` API).
- SFTP browser and SCP transfer manager, both of which work through jump hosts.
- 26 themes: Catppuccin, Nord, Solarized, Dracula, Gruvbox, Tokyo Night, One, Rosé Pine, Everforest, Kanagawa, GitHub, Tomorrow and TermCraft's own.

### Security
- Sandboxed renderer with a strict Content Security Policy, an approval-checked main-process API, and denied web permissions.
- Logins saved only on request, after a successful login, and encrypted with the OS keychain.
- Protection against path traversal from SFTP/SCP servers, command injection, prototype pollution and code-running imports.
- Hardened Electron fuses in packaged builds. See [SECURITY.md](SECURITY.md).
