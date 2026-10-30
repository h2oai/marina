// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A caught failure reported with `ctx.send(…getErrorMessage(err)…)` reaches the
 * command phase as a SUCCESS: usage and activity record it as such, and an agent
 * reads the text as a successful tool result (the SDK rejects only when the
 * completion says `ok: false`). `refuseCommand` sends the same text AND marks
 * the failure. Opt out of a line with `// allow-send-error: <reason>` on it or
 * the line above (a later world event after the command already completed).
 */
const ROOT = join(import.meta.dir, "../src/engine/commands");
const PATTERN = /ctx\.send\([^;]*getErrorMessage\(/;
const ALLOW = /allow-send-error:\s*\S/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

describe("command handlers report a caught failure as a refusal", () => {
  test("no ctx.send(…getErrorMessage(err)…) outside an allow-send-error line", () => {
    const offenders: string[] = [];
    for (const path of sources(ROOT)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!PATTERN.test(line)) return;
        if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? "")) return;
        offenders.push(`${path.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
