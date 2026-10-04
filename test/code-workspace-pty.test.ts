// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { terminalText } from "../scripts/code-terminal";
import { until } from "./helpers";

test.skipIf(process.platform === "win32")(
  "real PTY keeps drafts, world input and approval identity across split/focus resize",
  async () => {
    let output = "";
    const events: { event: string; value: string }[] = [];
    await using tty = new Bun.Terminal({
      cols: 120,
      rows: 36,
      data(_terminal, data) {
        output = (output + new TextDecoder().decode(data)).slice(-256 * 1024);
      },
    });
    const child = Bun.spawn(
      [process.execPath, "--env-file=/dev/null", resolve("test/fixtures/code-workspace-pty.ts")],
      {
        terminal: tty,
        env: { PATH: process.env.PATH, TERM: "xterm-256color", NO_COLOR: "1" },
        ipc(message) {
          events.push(message);
        },
      },
    );
    const received = (event: string, value?: string) =>
      events.some(
        (entry) => entry.event === event && (value === undefined || entry.value === value),
      );
    try {
      await until(() => received("ready") || child.exitCode !== null);
      if (!received("ready"))
        throw new Error(`PTY child exited ${child.exitCode}: ${terminalText(output)}`);
      child.send({ event: "output" });
      await until(() => terminalText(output).includes("world-pty-proof"));
      expect(terminalText(output)).toContain("coding-pty-proof");
      tty.write("repair 界 draft");
      child.send({ event: "ask" });
      await until(() => terminalText(output).includes("Requests (1)"));
      tty.write("\x1b[17~tell Peer still here\r");
      await until(() => received("line", "/world tell Peer still here"));
      expect(received("answer")).toBe(false);
      tty.write("world draft");
      tty.resize(35, 14);
      tty.write("\x1b[18~no\r");
      await until(() => received("answer", "no"));
      tty.write(" continued\r");
      await until(() => received("line", "/world world draft continued"));
      tty.resize(160, 48);
      tty.write("\x1b[17~\r");
      await until(() => received("line", "repair 界 draft"));
      tty.write("\x1b[200~line one\nline two\x1b[201~");
      tty.write("\r");
      await until(() => received("line", "line one\nline two"));
      tty.write("\x04");
      await until(() => received("closed") && child.exitCode !== null);
      expect(child.exitCode).toBe(0);
      expect(output).toContain("\x1b[?1049h");
      expect(output).toContain("\x1b[?1049l");
      expect(events.filter((entry) => entry.event === "line")).toHaveLength(4);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  },
  15000,
);
