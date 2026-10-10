// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeConsole } from "../../scripts/code-console";
import { HarnessStore } from "../../scripts/code-harness";
import { LocalWorkspace } from "../../src/coding/local-workspace";
import type { MarinaAgent, Perception } from "../../src/sdk/client";

// A real ProcessTerminal and the real terminal console; the world is a stub
// whose `code diff` reads the scripted edit in a real Git workspace.
const root = process.argv[2]!;
const send = (event: string, value = "") => process.send?.({ event, value });
const workspace = new LocalWorkspace(root);
let view: CodeConsole;
const agent = {
  getSession: () => ({ token: "pty-token" }),
  command: async (text: string) => {
    send("command", text);
    if (text !== "code diff") return [];
    const result = await workspace.diff();
    const p: Perception = {
      kind: "message",
      timestamp: 0,
      command_request_id: "r1",
      data: {
        text: `Diff: .\n${result.content}`,
        code: {
          event: "diff_viewed",
          type: "diff",
          content: result.content,
          truncated: result.truncated,
          paths: ["."],
          sessionId: "pty",
        },
      },
    } as Perception;
    view.receive(p);
    return Object.assign([p], { completion: "confirmed" });
  },
} as unknown as MarinaAgent;
view = new CodeConsole({
  agent,
  url: "http://local.test",
  root,
  directory: root,
  sessionId: "pty",
  connected: true,
  tui: true,
  harness: { version: 1, agent: "marina" },
  store: new HarnessStore(root),
  finish: (code) => {
    send("closed", String(code));
    process.disconnect?.();
  },
});
await view.start(true);
send("ready");
