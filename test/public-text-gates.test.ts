// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public-text gates: tracked files describe what Marina does, never who decided
 * it, when, or what a run measured. Each gate counts matching lines across every
 * tracked text file; the count may only fall. `GATE_CEILINGS` is a ratchet: lower
 * a ceiling when a change removes hits, never raise it. The goal is 0 for all.
 *
 * Gates:
 * - `names`: people's names.
 * - `private-repo`: the private companion repository by name (the internal
 *   model-token prefix `marina-internal-…` is an identifier, not a reference).
 * - `dated-prose`: a parenthesised calendar date `(YYYY-MM-DD…` outside test
 *   fixtures and JSON data.
 * - `history`: project-history and measurement phrases.
 * - `run-figures`: shares and spend figures quoted from runs.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const TEXT_EXT =
  /\.(ts|tsx|js|mjs|cjs|jsx|md|mdx|astro|json|jsonl|yml|yaml|toml|sh|py|css|html|txt|reference|example|svg)$/i;

interface Gate {
  pattern: RegExp;
  /** Path prefixes or suffixes this gate does not read. */
  skip?: (path: string) => boolean;
}

export const GATES = {
  names: { pattern: /jeff|dhanika|gambera/i },
  "private-repo": { pattern: /marina-internal(?!-)/ },
  "dated-prose": {
    pattern: /\((19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}/,
    skip: (p) => p.startsWith("test/fixtures/") || p.endsWith(".json"),
  },
  history: {
    pattern:
      /Flow, Nov|usage audit|live world (held|had)|wiring (wave|item)|\bPhase [0-9]+\b|we measured|our measurements|in-house/i,
  },
  "run-figures": {
    pattern: /[0-9]+(\.[0-9]+)? ?% of (agent|turns|prompts|calls|rows)|\$[0-9]+ of \$[0-9]+|\/week/,
  },
} satisfies Record<string, Gate>;

type GateName = keyof typeof GATES;

/** Ratchet: current hit counts. Lower these as the text is cleaned; never raise them. */
export const GATE_CEILINGS: Record<GateName, number> = {
  names: 0,
  "private-repo": 0,
  "dated-prose": 56,
  history: 79,
  "run-figures": 1,
};

/** This file names every pattern, so it is not read. */
const SELF = "test/public-text-gates.test.ts";

function trackedTextFiles(): string[] | null {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (proc.exitCode !== 0) return null;
  return proc.stdout
    .toString()
    .split("\0")
    .filter((p) => p && p !== SELF && TEXT_EXT.test(p));
}

export function countGateHits(
  files: string[],
): Record<string, { count: number; sample: string[] }> {
  const out: Record<string, { count: number; sample: string[] }> = {};
  for (const name of Object.keys(GATES)) out[name] = { count: 0, sample: [] };
  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // a tracked path deleted in the working tree
    }
    const lines = text.split("\n");
    for (const [name, gate] of Object.entries(GATES) as [GateName, Gate][]) {
      if (gate.skip?.(path)) continue;
      const hit = out[name]!;
      for (let i = 0; i < lines.length; i++) {
        if (gate.pattern.test(lines[i]!)) {
          hit.count++;
          if (hit.sample.length < 10) hit.sample.push(`${path}:${i + 1}`);
        }
      }
    }
  }
  return out;
}

describe("public-text gates", () => {
  const files = trackedTextFiles();

  it.skipIf(files === null)("no gate rises above its ceiling", () => {
    const hits = countGateHits(files!);
    const over = Object.entries(hits)
      .filter(([name, h]) => h.count > GATE_CEILINGS[name as GateName])
      .map(
        ([name, h]) =>
          `${name}: ${h.count} > ceiling ${GATE_CEILINGS[name as GateName]} (e.g. ${h.sample.join(", ")})`,
      );
    expect(over).toEqual([]);
  });

  it("each gate matches what it should and spares identifiers", () => {
    expect(GATES.names.pattern.test("spawnedBy: Jeff")).toBe(true);
    expect(GATES["private-repo"].pattern.test("see marina-internal design notes")).toBe(true);
    expect(GATES["private-repo"].pattern.test("token marina-internal-abc123")).toBe(false);
    expect(GATES["dated-prose"].pattern.test("fixed (2026-10-21)")).toBe(true);
    expect(GATES.history.pattern.test("Phase 3 adds")).toBe(true);
    expect(GATES["run-figures"].pattern.test("12% of turns")).toBe(true);
  });
});
