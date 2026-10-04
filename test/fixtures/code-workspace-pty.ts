// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeTerminal } from "../../scripts/code-terminal";

// This child exercises the actual ProcessTerminal, raw input, resize and shell
// restoration. Protocol/coding outcomes are qualified separately against a live world.
const send = (event: string, value = "") => process.send?.({ event, value });
const terminal = new CodeTerminal({
  tui: true,
  views: true,
  line: (text) => send("line", text),
  interrupt: () => send("interrupt"),
  close: () => {
    send("closed");
    process.disconnect?.();
  },
});
process.on("message", (message: { event: string; value?: string }) => {
  if (message.event === "output") {
    terminal.write("coding-pty-proof", "coding");
    terminal.write("world-pty-proof", "world");
  } else if (message.event === "ask") {
    void terminal.ask("Approve PTY request 17?").then((answer) => send("answer", answer));
  } else if (message.event === "close") terminal.close();
});
send("ready");
