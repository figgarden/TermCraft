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
| UI isolation | The UI runs in the system web view (WebKit / WebView2) with no Node.js and no Tauri plugins: it can call only TermCraft's own backend command and listen for its events (see `src-tauri/capabilities`). A strict Content Security Policy allows scripts only from the app itself: no inline scripts, no `eval`, no plugins, no frames. WebAssembly compilation (`wasm-unsafe-eval`) is allowed for the inline-image decoder only; it does not allow JavaScript `eval`. Inline images (Kitty, Sixel, iTerm2) are accepted only when sent inline: Kitty's file, temp-file and shared-memory transmission is refused, so a remote host cannot make TermCraft read local files. Images are limited to 4096×4096 pixels and 128 MB per tab. |
| Narrow backend API | Calls are accepted only from TermCraft's own window showing TermCraft's own page. File reads, deletes, uploads to a server, script runs and "Launch Application" commands are allowed only for files you picked in a dialog or dropped on the window, folders you browsed, or commands configured on your buttons. |
| No navigation or pop-ups | The window can't navigate away. New windows and webviews are blocked. Only `http(s)` links reach the system browser, and terminal links require Cmd/Ctrl+click. |
| Permissions | All web permissions (camera, microphone, location, notifications…) are denied. (The macOS web view would otherwise grant camera and microphone requests.) |
| Host keys | SSH host keys are verified against known hosts, with a prominent warning when a key changes. |
| Credentials | Saved only when you ask, and only after a successful login. They're encrypted (AES) with a key kept in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) and never sent to the UI, except a VNC password, which noVNC needs to authenticate. |
| Server-supplied file names | SFTP and SCP refuse names with separators or `..`, which blocks path traversal (CVE-2019-6111 class). |
| Shell safety | Remote paths are escaped for the remote shell. The custom RDP client and "Launch Application" buttons run without a local shell, so host names, user names and characters like `;` `|` `$( )` can't inject commands. Each new Launch Application command must be approved once in a native system dialog that the UI can't skip or fake. Passwords are never put on command lines. |
| Untrusted imports | Imported sessions lose logon scripts and local shell commands. Imported button bars that run programs are shown to you before import. JSON is parsed without prototype pollution. |
| Local files | The data folder is `0700` and its files and session logs are `0600`. |
| Network tools | The TFTP server shares only the default `~/TermCraft TFTP` folder or one you pick in a native folder dialog (never a folder the UI merely browsed), refuses `..`, absolute paths and drive letters, accepts uploads only when enabled, never replaces files unless allowed, and stops when its tab closes. "Run Commands" writes output only to `~/TermCraft Output` or a folder picked in a dialog, files are `0600`, and passwords are never written to the transcript. YMODEM and ZMODEM receive ignore any path the sender gives and never overwrite; downloads a device starts by itself (ZMODEM `sz`) always go to `~/Downloads`, which the UI cannot redirect, and sending files always requires picking them in a native dialog. Installing an SSH key validates the key so it can't inject shell commands. |
| Reticulum | Off by default. TermCraft starts only the Reticulum programs (rnsh, rncp, rnx, rnstatus, rnpath, rnprobe, rnid), never a shell; destination hashes are validated and values are placed after `--` so they can't become options. Files sent with rncp must have been chosen in a dialog or dropped; fetched files go to a folder picked in a dialog (or Downloads). Imported sessions lose their Reticulum identity file path. |
| Local bridges | The VNC WebSocket bridge listens on 127.0.0.1 only and needs a 192-bit per-tab token. SSH port forwards bind to 127.0.0.1 by default. |
| Packaged app | The UI's files are compiled into the executable; the page can't load anything else. Developer tools and the end-to-end test channel exist only in debug builds (and the test channel only when `TERMCRAFT_CONTROL=1` is set). |
| Memory safety | The backend is Rust. `npm run lint` (clippy) and `cargo audit` run in CI. One known advisory has no fix yet: RUSTSEC-2023-0071, a timing side channel in the `rsa` crate. It affects RSA private-key operations (here: signing when you log in with an RSA key file); exploiting it needs many precisely timed observations, which an SSH login does not provide. Ed25519 and ECDSA keys are not affected. |

Scripts (`Script → Run…`, logon scripts, script buttons) are full programs that run with your privileges. Only run scripts you trust.

## Verifying

```bash
npm test          # unit, integration and security regression tests (Rust and UI)
npm run test:e2e  # end-to-end suites in the real app, including in-app attack tests
npm run lint      # clippy
npm run audit     # npm audit and cargo audit
```
