// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Back up a network device's running config from the current tab to a file.
const fs = require("fs");
const path = require("path");
const os = require("os");

tc.Screen.Send("terminal length 0\r");
await tc.Screen.WaitForString("#", 5);
tc.Screen.Send("show running-config\r");
const config = await tc.Screen.ReadString(["\nend", "#"], 60);
const file = path.join(os.homedir(), `running-config-${new Date().toISOString().slice(0, 10)}.txt`);
fs.writeFileSync(file, config.replace(/\r/g, ""));
console.log(`Saved ${config.length} bytes to ${file}`);
