// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The arena formations that still run on their own code (catalogue entries
 * with `numeric.runtime: "arena"`) are byte-identical to the frozen
 * pre-catalogue implementation on the stored rounds
 * (`test/fixtures/formations/arena-rounds.json`): the same forecast (JSON, key
 * order included) and the same calls in the same order, with replies that
 * arrive out of order, fail, or blow up. The reference is
 * `test/fixtures/arena-formations-legacy.ts` — never edit it to pass.
 *
 * The formations that run from the catalogue (`ensemble`, `delphi`) are NOT
 * pinned here: the catalogue is held by behaviour tests
 * (`test/formation-behaviour.test.ts`, `test/formation-catalogue.test.ts`) and
 * may change its prompts and answers when a measurement says it should.
 */

import { describe, expect, it } from "bun:test";
import {
  FORMATION_PATTERNS,
  type FormationMember,
  type FormationPattern,
  formationForecastRound,
} from "../src/arena/formations";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import { FORMATIONS } from "../src/orchestration/formations/catalogue";
import { formationForecastRound as legacyFormationForecastRound } from "./fixtures/arena-formations-legacy";
import stored from "./fixtures/formations/arena-rounds.json";

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const ROUNDS = stored.rounds as Array<{ round: ArenaRound; lock: ArenaLock }>;

/** Members whose replies are pure functions of what they are asked and arrive after varied delays. */
function crew(seed: number, n: number, failRate: number, last: number) {
  const calls: Array<{ member: string; system: string; user: string }> = [];
  const members: FormationMember[] = Array.from({ length: n }, (_, i) => ({
    name: `vendor${i}/model-${i}`,
    complete: async (system: string, user: string) => {
      calls.push({ member: `m${i}`, system, user });
      const h = hash(`${seed}|${i}|${system}|${user}`);
      // Deterministic out-of-order arrival: a few microtask hops per reply.
      for (let k = 0; k < h % 5; k++) await Promise.resolve();
      if (failRate && h % failRate === 0) throw new Error(`model-${i} unavailable`);
      if (failRate && h % failRate === 1) return "sorry, no JSON";
      const scale = Math.max(0.5, Math.abs(last) * 0.02 + 0.5);
      // Now and then a blowup, far beyond 4 start sds.
      const move = h % 17 === 0 ? 50 * scale : (((h % 21) - 10) / 10) * scale;
      return JSON.stringify({
        mean: Math.round((last + move) * 100) / 100,
        sd: Math.round((0.4 + (h % 9) / 5) * scale * 100) / 100,
        reason: `model-${i} sees ${h % 13} in vendor${(i + 1) % 3}/model-${(i + 1) % 3}'s data`,
        winner: ["A", "B", "B", "?"][h % 4],
        trust: (h % 11) / 10,
        sd_scale: 1 + (h % 3) / 4,
        adjustment: ((h % 7) - 3) / 4,
        confidence: (h % 10) / 10,
        hypothesis: `trend ${h % 3}`,
        check: {
          name: ["recent mean", "trend", "last-k deltas"][h % 3],
          k: 3 + (h % 4),
          series: "history",
        },
        decision: ["keep", "revert", "start"][h % 3],
        cites: [{ date: "2026-07-24", value: last }],
        critique: `check ${h % 5}`,
        direction: h % 2 ? "above" : "at-or-below",
      });
    },
  }));
  return { members, calls };
}

/** The arena formations on their own code; the catalogue-run ones are held by behaviour tests. */
const OWN_CODE = FORMATION_PATTERNS.filter(
  (p) => FORMATIONS[p as keyof typeof FORMATIONS]?.numeric?.runtime === "arena",
);

describe("arena formations on their own code ≡ pre-catalogue implementation (stored rounds)", () => {
  it("covers every arena formation not run from the catalogue", () => {
    expect(OWN_CODE).toHaveLength(FORMATION_PATTERNS.length - 2);
    expect(OWN_CODE).not.toContain("ensemble");
    expect(OWN_CODE).not.toContain("delphi");
  });

  for (const pattern of OWN_CODE) {
    it(`${pattern}: identical forecasts and calls`, async () => {
      let compared = 0;
      let formed = 0;
      for (const { round, lock } of ROUNDS) {
        const last = (lock.answer_history ?? []).at(-1)!.value;
        for (const n of [1, 2, 3, 4])
          for (const seed of [1, 2, 3, 4, 5])
            for (const failRate of [0, 4]) {
              const a = crew(seed, n, failRate, last);
              const b = crew(seed, n, failRate, last);
              const legacy = await legacyFormationForecastRound(
                pattern as FormationPattern,
                round,
                lock,
                a.members,
              );
              const current = await formationForecastRound(
                pattern as FormationPattern,
                round,
                lock,
                b.members,
              );
              const where = `${round.round_id} n=${n} seed=${seed} fail=${failRate}`;
              expect(JSON.stringify(current), where).toBe(JSON.stringify(legacy));
              expect(b.calls, where).toEqual(a.calls);
              if (current.proposals) formed++;
              compared++;
            }
      }
      expect(compared).toBe(ROUNDS.length * 4 * 5 * 2);
      // The formation itself ran (not only its fallback).
      expect(formed).toBeGreaterThan(0);
    });
  }
});
