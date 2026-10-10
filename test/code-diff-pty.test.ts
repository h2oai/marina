// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminalText } from "../scripts/code-terminal";
import { until } from "./helpers";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-diff-pty-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");
  git("config", "user.email", "pty@example.invalid");
  git("config", "user.name", "PTY");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  writeFileSync(join(root, "alpha.txt"), `${lines.join("\n")}\n`);
  writeFileSync(join(root, "beta.txt"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  // The scripted edit: two hunks in one file and a change in a second file.
  lines[2] = "line two changed";
  lines[25] = "line twenty-five changed";
  writeFileSync(join(root, "alpha.txt"), `${lines.join("\n")}\n`);
  writeFileSync(join(root, "beta.txt"), "one\nTWO\nthree\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "real PTY: /diff opens a coloured diff view with file and hunk jumps; q returns",
  async () => {
    let output = "";
    const events: { event: string; value: string }[] = [];
    await using tty = new Bun.Terminal({
      cols: 120,
      rows: 36,
      data(_terminal, data) {
        output = (output + new TextDecoder().decode(data)).slice(-512 * 1024);
      },
    });
    const child = Bun.spawn(
      [process.execPath, "--env-file=/dev/null", resolve("test/fixtures/code-diff-pty.ts"), root],
      {
        terminal: tty,
        // Colour on: no NO_COLOR in the child environment.
        env: { PATH: process.env.PATH, TERM: "xterm-256color", HOME: root },
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
      output = "";
      tty.write("/diff");
      // Enter first inserts a highlighted suggestion, then sends. Extra Enters
      // on an empty composer (or inside the diff view) do nothing.
      await until(() => {
        if (received("command", "code diff")) return true;
        tty.write("\r");
        return false;
      });
      await until(() => terminalText(output).includes("q returns"));
      const screen = terminalText(output);
      expect(screen).toContain("2 files · +4 −3");
      expect(screen).toContain("alpha.txt");
      expect(screen).toContain("file 1/2");
      // Colour reaches the terminal only for the diff structure.
      expect(output).toContain("\x1b[32m+line two changed");
      expect(output).toContain("\x1b[31m-line 2");
      expect(output).toMatch(new RegExp(`${String.fromCharCode(27)}\\[36m@@ -1,\\d+ \\+1,\\d+ @@`));
      expect(output).toContain("\x1b[1mdiff --git a/alpha.txt b/alpha.txt");
      output = "";
      tty.write("]");
      await until(() => terminalText(output).includes("hunk 2/3"));
      tty.write("n");
      await until(() => terminalText(output).includes("file 2/2"));
      tty.write("p");
      await until(() => terminalText(output).includes("file 1/2"));
      output = "";
      tty.write("q");
      await until(() => terminalText(output).includes("recent local history"));
      // Back in the composer: typed text is a draft again, not a diff key.
      tty.write("next please\r");
      await until(() => received("command", "next please"));
      tty.write("\x04");
      await until(() => received("closed") && child.exitCode !== null);
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  },
  20000,
);
