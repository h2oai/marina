// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The free-text patterns on the catalogue (`pattern run`, `POST /v1/patterns/run`)
 * reproduce the pre-catalogue protocols exactly: given the same model replies,
 * every pattern × member count × reply mix × budget × abort point gives the
 * same result (answer, success, every trace step in order, cost, fallback)
 * and makes exactly the same calls in the same order. The reference is the
 * FROZEN copy in `test/fixtures/formations-legacy/` — never edit it to pass.
 */

import { describe, expect, it } from "bun:test";
import { SpendGuard } from "../src/engine/spend-guard";
import {
  runTextPattern,
  TEXT_PATTERNS,
  TEXT_PICK_SYSTEM,
  type TextComplete,
  type TextPattern,
} from "../src/orchestration/text-patterns";
import {
  TEXT_PICK_SYSTEM as LEGACY_PICK_SYSTEM,
  TEXT_PATTERNS as LEGACY_TEXT_PATTERNS,
  runTextPattern as legacyRunTextPattern,
} from "./fixtures/formations-legacy/text-patterns";

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface Scenario {
  seed: number;
  members: string[];
  budgetUsd?: number;
  abortAfter?: number;
}

/** A deterministic model: the reply is a pure function of (seed, model, system, user). */
function fake(s: Scenario) {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const controller = new AbortController();
  const complete: TextComplete = async (model, system, user) => {
    calls.push({ model, system, user });
    if (s.abortAfter !== undefined && calls.length >= s.abortAfter)
      controller.abort(
        new DOMException("deadline", calls.length % 2 ? "TimeoutError" : "AbortError"),
      );
    const h = hash(`${s.seed}|${model}|${system}|${user}`);
    const costUsd = (h % 5) * 0.01;
    if (h % 9 === 0) throw new Error(`${model} upstream ${h % 500}`);
    if (h % 9 === 1) return { text: "   ", costUsd };
    if (system === TEXT_PICK_SYSTEM) {
      const n = user.split("CANDIDATE ").length - 2;
      const picks = [
        `{"pick":${(h % Math.max(1, n)) + 1},"reason":"best"}`,
        "no idea",
        '{"pick":99}',
      ];
      return { text: picks[h % 7 < 5 ? 0 : (h % 2) + 1]!, costUsd };
    }
    if (system.includes("You review a DRAFT")) {
      const reviews = [
        '{"verdict":"approve","issues":""}',
        `{"verdict":"revise","issues":"fix ${h % 11}"}`,
        "looks fine to me",
      ];
      return { text: reviews[h % 3]!, costUsd };
    }
    // Few distinct answers, so unanimous candidates happen too.
    return { text: `answer ${h % 4} (${system.slice(0, 12)})`, costUsd };
  };
  return { calls, complete, signal: controller.signal };
}

async function run(
  impl: typeof runTextPattern,
  pattern: TextPattern,
  s: Scenario,
): Promise<{ result: unknown; calls: unknown }> {
  const f = fake(s);
  const result = await impl(pattern, `Task ${s.seed}: name three rivers.`, s.members, {
    complete: f.complete,
    checker: "m/checker",
    budget: new SpendGuard({
      label: "pattern budget",
      daily: false,
      ...(s.budgetUsd !== undefined ? { budgetUsd: s.budgetUsd } : {}),
      concurrency: s.members.length,
    }),
    ...(s.abortAfter !== undefined ? { signal: f.signal } : {}),
  });
  return { result, calls: f.calls };
}

const MEMBER_SETS = [
  ["m/a"],
  ["m/a", "m/b"],
  ["m/a", "m/b", "m/c"],
  ["m/a", "m/a", "m/b", "m/c"],
  ["m/a", "m/b", "m/c", "m/d", "m/e"],
];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BUDGETS = [undefined, 0.03, 0.08, 0.2];
const ABORTS = [undefined, 2, 5];

describe("text patterns: catalogue ≡ pre-catalogue protocols", () => {
  it("names the same patterns and prompts", () => {
    expect([...TEXT_PATTERNS]).toEqual([...LEGACY_TEXT_PATTERNS]);
    expect(TEXT_PICK_SYSTEM).toBe(LEGACY_PICK_SYSTEM);
  });

  for (const pattern of TEXT_PATTERNS) {
    it(`${pattern}: identical results, traces and calls`, async () => {
      let compared = 0;
      let stopped = 0;
      for (const members of MEMBER_SETS)
        for (const seed of SEEDS)
          for (const budgetUsd of BUDGETS)
            for (const abortAfter of ABORTS) {
              const s: Scenario = {
                seed,
                members,
                ...(budgetUsd !== undefined ? { budgetUsd } : {}),
                ...(abortAfter !== undefined ? { abortAfter } : {}),
              };
              const legacy = await run(legacyRunTextPattern as typeof runTextPattern, pattern, s);
              const current = await run(runTextPattern, pattern, s);
              const where = JSON.stringify(s);
              expect(JSON.stringify(current.result), where).toBe(JSON.stringify(legacy.result));
              expect(current.calls, where).toEqual(legacy.calls);
              if ((legacy.result as { trace: { fallback?: string } }).trace.fallback) stopped++;
              compared++;
            }
      expect(compared).toBe(MEMBER_SETS.length * SEEDS.length * BUDGETS.length * ABORTS.length);
      // Budget stops, aborts and outages were all exercised, not only clean runs.
      expect(stopped).toBeGreaterThan(0);
      expect(stopped).toBeLessThan(compared);
    });
  }
});
