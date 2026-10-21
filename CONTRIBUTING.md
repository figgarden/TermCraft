# Contributing to TermCraft

Thanks for helping. TermCraft is free software under the **GNU GPL, version 2 or later** (`GPL-2.0-or-later`). Contributions are accepted under the same license.

## Developer Certificate of Origin

Like the Linux kernel, TermCraft uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA. Signing off a commit certifies that you wrote it, or otherwise have the right to submit it, under the project's license. Add a sign-off line to every commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you.

## Ground rules

- New source files start with:
  ```js
  // SPDX-License-Identifier: GPL-2.0-or-later
  // Copyright (C) <year> Gabriel Moreno and contributors
  ```
- New dependencies must be compatible with **GPLv2**: MIT, BSD, ISC, zlib, Unlicense, LGPL, or GPL-2.0-or-later. Avoid Apache-2.0: it is compatible with GPLv3 only, so it would quietly remove the "version 2" option. Never add proprietary or "non-commercial" code. Run `npm run notices` afterwards.
- Run `npm run test:all` before sending a change (clippy, unit, security and end-to-end tests plus dependency audits).
- Keep security-sensitive code (authentication, host keys, credential storage, SCP/SFTP path handling) covered by tests.

## Building

```bash
npm install        # the UI's browser libraries
npm start          # build and run from source (needs Rust: https://rustup.rs)
npm run dist       # installers for this platform (cargo tauri build)
npm run icons      # re-render the artwork
```
