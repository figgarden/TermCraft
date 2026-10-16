// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Run from a connected tab: Script > Run…
// Sends a command, waits for the prompt and shows the output.
tc.Screen.Send("uname -a\r");
const output = await tc.Screen.ReadString(["$ ", "# ", "% "], 10);
if (tc.Screen.MatchIndex === 0) {
  await tc.Dialog.MessageBox("Timed out waiting for the prompt");
} else {
  await tc.Dialog.MessageBox(output.trim(), "uname -a");
}
