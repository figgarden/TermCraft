# Security Policy

TermCraft connects to remote systems and stores credentials, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately through the project repository's **"Report a vulnerability"** (private security advisory) feature. Include:

- what an attacker can do, and what they need (for example: a malicious SSH/SFTP/VNC server, a crafted session or button-bar file, local access)
- steps to reproduce, ideally with a minimal server or file
- the TermCraft version and your OS

We aim to acknowledge reports within a week and to credit reporters unless they prefer otherwise.

## Security model

TermCraft treats as **untrusted**: everything a remote server sends (terminal output and escape sequences, window titles, links, file names, VNC data) and any file you import (sessions, button bars).

| Protection | How |
|---|---|
| Renderer isolation | The UI runs sandboxed with context isolation and no Node.js. A strict Content Security Policy allows scripts only from the app itself: no inline scripts, no `eval`, no plugins, no frames. |
| Narrow main-process API | IPC is accepted only from TermCraft's own window. File reads, deletes, script runs and "Launch Application" commands are allowed only for files you picked in a dialog, folders you browsed, or commands configured on your buttons. |
| No navigation or pop-ups | The window can't navigate away. New windows and webviews are blocked. Only `http(s)` links reach the system browser, and terminal links require Cmd/Ctrl+click. |
| Permissions | All web permissions (camera, microphone, location, notifications…) are denied. |
| Host keys | SSH host keys are verified against known hosts, with a prominent warning when a key changes. |
| Credentials | Saved only when you ask, and only after a successful login. They're encrypted with the OS keychain (macOS Keychain, Windows DPAPI, libsecret) and never sent to the UI process, except a VNC password, which noVNC needs to authenticate. |
| Server-supplied file names | SFTP and SCP refuse names with separators or `..`, which blocks path traversal (CVE-2019-6111 class). |
| Shell safety | Remote paths are escaped for the remote shell. The custom RDP client runs without a local shell, so host and user names can't inject commands. Passwords are never put on command lines. |
| Untrusted imports | Imported sessions lose logon scripts and local shell commands. Imported button bars that run programs are shown to you before import. JSON is parsed without prototype pollution. |
| Local files | The data folder is `0700` and its files and session logs are `0600`. |
| Local bridges | The VNC WebSocket bridge listens on 127.0.0.1 only and needs a 192-bit per-tab token. SSH port forwards bind to 127.0.0.1 by default. |
| Packaged app | Electron fuses disable `RunAsNode`, `NODE_OPTIONS` and `--inspect`. The app loads only from its asar archive, and the asar's integrity is validated. Test hooks are unavailable in packaged builds. |

Scripts (`Script → Run…`, logon scripts, script buttons) are full programs that run with your privileges. Only run scripts you trust.

## Verifying

```bash
npm test          # unit, integration and security regression tests
npm run test:e2e  # end-to-end suites in the real app, including in-app attack tests
npm audit --omit=dev
```
