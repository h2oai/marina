// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A caught failure reported with `ctx.send(…)` reaches the command phase as a
 * SUCCESS: usage and activity record it as such, and an agent or SDK script reads
 * the text as a successful result (the SDK rejects only when the completion says
 * `ok: false`). `refuseCommand` sends the same text AND marks the failure. Opt out
 * of a call with `// allow-send-error: <reason>` on its first line or the line
 * above (a later world event after the command completed, or a fallback that is
 * not a failure).
 */
const ROOT = join(import.meta.dir, "../src/engine/commands");
// Every spelling of "a caught error, sent as plain output" seen in handlers: the
// shared extractor, a hand-rolled `instanceof Error` / `.message` / `String(err)`,
// a memory-failure formatter, or a reply that opens with a failure word.
const PATTERNS: RegExp[] = [
  /getErrorMessage\(/,
  /\binstanceof (?:Error|\w+Error)\b/,
  /\b(?:e|err|error|cause)\.message\b/,
  /\bString\((?:e|err|error|cause)\)/,
  /formatMemoryFailure\(/,
  /^ctx\.send\(\s*[\w.]+,\s*[`"'](?:Failed|Blocked|Refused|Could not|Couldn't|Cannot|Unable)\b/,
];
const ALLOW = /allow-send-error:\s*\S/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/**
 * Each `ctx.send(` call — and each call of a local reply helper defined as
 * `const say = (text: string) => ctx.send(…)` — up to its statement end,
 * whitespace collapsed and spelled as `ctx.send(`, with its line.
 */
function* sendCalls(source: string): Generator<{ line: number; call: string }> {
  const aliases = [...source.matchAll(/const (\w+) = \([^)]*\)\s*=>\s*ctx\.send\(/g)].map(
    (m) => m[1]!,
  );
  const callee = new RegExp(
    `(?<![\\w.])(?:ctx\\.send|${["", ...aliases].join("|").slice(1) || "(?!)"})\\(`,
    "g",
  );
  for (const m of source.matchAll(callee)) {
    const before = source.slice(Math.max(0, m.index - 12), m.index);
    if (/const \w+ = $/.test(before) || /=>\s*$/.test(before)) continue; // the helper's own body
    const end = source.indexOf(";", m.index);
    const call = source
      .slice(m.index, end < 0 ? undefined : end)
      .replace(/\s+/g, " ")
      .replace(/^\w+\(/, "ctx.send(input.entity, ")
      .replace(/^ctx\.send\(input\.entity, ctx\.send\(/, "ctx.send(");
    yield { line: source.slice(0, m.index).split("\n").length, call };
  }
}

describe("command handlers report a caught failure as a refusal", () => {
  test("no failure sent with ctx.send outside an allow-send-error call", () => {
    const offenders: string[] = [];
    for (const path of sources(ROOT)) {
      const source = readFileSync(path, "utf8");
      const lines = source.split("\n");
      for (const { line, call } of sendCalls(source)) {
        if (!PATTERNS.some((p) => p.test(call))) continue;
        if (ALLOW.test(lines[line - 1] ?? "") || ALLOW.test(lines[line - 2] ?? "")) continue;
        offenders.push(`${path.slice(ROOT.length + 1)}:${line} ${call.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
