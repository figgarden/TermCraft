# Changelog

All notable changes to TermCraft are documented here. This project uses [Semantic Versioning](https://semver.org/).

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
