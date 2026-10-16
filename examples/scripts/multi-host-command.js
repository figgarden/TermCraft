// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Connect to several saved sessions (by name) and run the same command on each,
// collecting the results into a file in your home directory.
const fs = require("fs");
const path = require("path");
const os = require("os");

const names = (await tc.Dialog.Prompt("Session names (comma separated):", "Multi-host", "")) || "";
const command = await tc.Dialog.Prompt("Command to run:", "Multi-host", "uptime");
if (!names || !command) tc.Quit();

const results = [];
for (const name of names.split(",").map((s) => s.trim()).filter(Boolean)) {
  try {
    const tab = await tc.Session.Connect(name);
    await tab.Screen.WaitForStrings(["$ ", "# ", "> "], 15);
    tab.Screen.Send(command + "\r");
    const out = await tab.Screen.ReadString(["$ ", "# ", "> "], 30);
    results.push(`### ${name}\n${out.trim()}\n`);
    tab.Session.Disconnect();
  } catch (e) {
    results.push(`### ${name}\nERROR: ${e.message}\n`);
  }
}
const file = path.join(os.homedir(), `TermCraft-multi-${Date.now()}.txt`);
fs.writeFileSync(file, results.join("\n"));
await tc.Dialog.MessageBox(`Saved results to ${file}`);
