// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The typed forecast formations on the catalogue (`src/orchestration/formations/`)
 * reproduce the pre-catalogue implementation exactly: given the same model
 * replies, every formation × answer type × member count × reply mix gives the
 * same answer object (key order included, timings zeroed) and asks every part
 * exactly the same prompts in the same order. The reference is the FROZEN
 * copy in `test/fixtures/formations-legacy/` — never edit it to pass.
 */

import { describe, expect, it } from "bun:test";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed, type TypedFormation } from "../src/forecast/formations";
import type { SuppliedPrior } from "../src/forecast/prior";
import type { ModelPart, TypedForecastDeps, TypedForecastRequest } from "../src/forecast/typed";
import { forecastFormed as legacyForecastFormed } from "./fixtures/formations-legacy/typed-formations";

/** FNV-1a: a reply is a pure function of who is asked what. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const SPECS: Record<string, AnswerSpec> = {
  binary: { type: "choice", options: [{ id: "Yes" }, { id: "No" }], probabilities: true },
  choice: { type: "choice", options: [{ id: "A", label: "Alpha" }, { id: "B" }, { id: "C" }] },
  multi: {
    type: "multi",
    options: [{ id: "w" }, { id: "x" }, { id: "y" }, { id: "z" }],
    minPicks: 1,
    probabilities: true,
  },
  number: { type: "number", unit: "points" },
  integer: { type: "number", integer: true },
  ranking: { type: "ranking", size: 3, candidates: ["p", "q", "r", "s"] },
  text: { type: "text", maxLength: 40 },
};

function answerFor(spec: AnswerSpec, h: number): Record<string, unknown> {
  const reason = `reason ${h % 97}`;
  const conf = ((h >>> 5) % 80) / 100 + 0.1;
  switch (spec.type) {
    case "choice": {
      const raw = spec.options.map((_, i) => ((h >>> (i * 3)) % 9) + 1);
      const sum = raw.reduce((a, b) => a + b, 0);
      const probs = Object.fromEntries(spec.options.map((o, i) => [o.id, raw[i]! / sum]));
      const top = spec.options[raw.indexOf(Math.max(...raw))]!.id;
      return {
        answer: top,
        confidence: conf,
        ...(spec.probabilities ? { probabilities: probs } : {}),
        reason,
      };
    }
    case "multi": {
      const probs = Object.fromEntries(
        spec.options.map((o, i) => [o.id, (((h >>> (i * 4)) % 90) + 5) / 100]),
      );
      const picks = spec.options.filter((o) => probs[o.id]! > 0.5).map((o) => o.id);
      return {
        answer: picks.length ? picks : [spec.options[0]!.id],
        confidence: conf,
        probabilities: probs,
        reason,
      };
    }
    case "number":
      return {
        answer: 100 + (h % 41) - 20 + (h % 7) / 10,
        sd: 1 + (h % 5),
        confidence: conf,
        reason,
      };
    case "ranking": {
      const c = [...(spec.candidates ?? [])];
      const out: string[] = [];
      let x = h;
      while (c.length && out.length < (spec.size ?? 3)) {
        out.push(c.splice(x % c.length, 1)[0]!);
        x = Math.floor(x / 7) + 3;
      }
      return { answer: out, confidence: conf, reason };
    }
    case "text":
      return { answer: `answer-${h % 3}`, confidence: conf, reason };
  }
}

interface Call {
  part: string;
  system: string;
  user: string;
}

/** Parts whose replies are a pure function of (seed, part, system, user); every call logged. */
function world(seed: number, spec: AnswerSpec, analysts: number, failRate: number) {
  const calls: Call[] = [];
  const part = (name: string, reply: (h: number, system: string, user: string) => string) =>
    ({
      name,
      complete: async (system: string, user: string) => {
        calls.push({ part: name, system, user });
        const h = hash(`${seed}|${name}|${system}|${user}`);
        // Every so often a model call fails outright or answers junk.
        if (failRate && h % failRate === 0) throw new Error(`${name} unavailable (${h % 13})`);
        if (failRate && h % failRate === 1) return "I cannot answer that.";
        return reply(h, system, user);
      },
    }) satisfies ModelPart;
  const judge = part("critic", (h, system) => {
    if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q1","q2"]}';
    if (system.startsWith("You review a research dossier")) return '{"done":true}';
    if (system.startsWith("You referee")) {
      const w = ["A", "B", "A", "B", "neither"][h % 5];
      return JSON.stringify({ winner: w, reason: `ruling ${h % 31}` });
    }
    if (system.startsWith("You are the skeptic")) {
      if (h % 7 === 0) return "no json here";
      return JSON.stringify({
        trust: (h % 101) / 100,
        ...(h % 3 ? { sd_scale: 1 + (h % 13) / 10 } : {}),
        critique: `too far ${h % 17}`,
      });
    }
    if (system.startsWith("You verify")) return '{"verdict":"ok"}';
    if (system.startsWith("You are the forecaster's critic")) {
      return h % 4 === 0
        ? JSON.stringify({ verdict: "revise", ...answerFor(spec, h) })
        : JSON.stringify({ verdict: "keep", reason: "holds" });
    }
    return JSON.stringify(answerFor(spec, h));
  });
  const members = Array.from({ length: analysts }, (_, i) =>
    part(`vendor${i}/model-${i}`, (h) => JSON.stringify(answerFor(spec, h))),
  );
  return { calls, judge, members };
}

const NOW = new Date("2026-10-05T00:00:00Z");

function depsFor(
  w: ReturnType<typeof world>,
  runs: number,
  opts: { critique?: boolean } = {},
): TypedForecastDeps {
  return {
    retriever: async (brief) => ({
      report: `- 2026-09-20 — ${brief.queries?.[0] ?? "a fact"} ([src](https://example.org/1))\n- 2026-09-28 — another reading 42 ([src](https://example.org/2))`,
      sources: [{ url: "https://example.org/1" }, { url: "https://example.org/2" }],
      costUsd: 0,
      searches: 1,
      retriever: "fake",
    }),
    analysts: w.members,
    planner: w.judge,
    critic: w.judge,
    now: () => NOW,
    options: {
      runs,
      researchRounds: 1,
      ...(opts.critique === false ? { critique: false } : {}),
    },
  };
}

function priorsFor(spec: AnswerSpec, seed: number): SuppliedPrior[] | undefined {
  if (seed % 2) return undefined;
  const at = "2026-10-01T00:00:00Z";
  if (spec.type === "choice") {
    const n = spec.options.length;
    return [
      {
        source: "market",
        at,
        distribution: Object.fromEntries(
          spec.options.map((o, i) => [o.id, i === 0 ? 0.5 : 0.5 / (n - 1)]),
        ),
      },
    ];
  }
  if (spec.type === "multi")
    return [
      {
        source: "market",
        at,
        distribution: Object.fromEntries(spec.options.map((o, i) => [o.id, i % 2 ? 0.3 : 0.6])),
      },
    ];
  if (spec.type === "number") return [{ source: "market", at, value: 101, sd: seed % 4 ? 4 : 0.5 }];
  return undefined;
}

/** The answer as JSON with wall-clock timings zeroed (they measure the test machine). */
function stable(answer: unknown): string {
  return JSON.stringify(answer, (k, v) =>
    k === "latencyMs" || k === "usedMs" || k === "ms" ? 0 : v,
  );
}

async function both(
  pattern: TypedFormation,
  specName: string,
  seed: number,
  analysts: number,
  failRate: number,
) {
  const spec = SPECS[specName]!;
  const priors = priorsFor(spec, seed);
  const req: TypedForecastRequest = {
    question: `Q${seed}: what happens (${specName})?`,
    answer: spec,
    context: seed % 3 ? "Resolves on the official figure." : undefined,
    ...(priors ? { priors } : {}),
  } as TypedForecastRequest;
  const runs = analysts + (seed % 2);
  const a = world(seed, spec, analysts, failRate);
  const b = world(seed, spec, analysts, failRate);
  const legacy = await legacyForecastFormed(req, depsFor(a, runs), pattern);
  const current = await forecastFormed(req, depsFor(b, runs), pattern);
  return { legacy, current, legacyCalls: a.calls, calls: b.calls };
}

const FORMATIONS: TypedFormation[] = ["ensemble", "delphi", "tournament", "skeptic"];
const SEEDS = [1, 2, 3, 4, 5, 6];

describe("typed formations: catalogue ≡ pre-catalogue implementation", () => {
  for (const pattern of FORMATIONS) {
    for (const specName of Object.keys(SPECS)) {
      it(`${pattern} × ${specName}: identical answers and prompts`, async () => {
        let compared = 0;
        for (const seed of SEEDS) {
          for (const analysts of [1, 2, 3]) {
            for (const failRate of [0, 5]) {
              const r = await both(pattern, specName, seed, analysts, failRate);
              const where = `${pattern}/${specName} seed ${seed}, ${analysts} analysts, fail ${failRate}`;
              expect(stable(r.current), where).toBe(stable(r.legacy));
              expect(r.calls, where).toEqual(r.legacyCalls);
              compared++;
            }
          }
        }
        expect(compared).toBe(SEEDS.length * 3 * 2);
      });
    }
  }

  it("exercises every formation's own stage (not only fallbacks)", async () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      for (const pattern of FORMATIONS) {
        const r = await both(pattern, "binary", seed, 3, 0);
        const f = r.current.formation;
        if (f.revisions?.length) seen.add("delphi:revisions");
        if (f.matches?.length) seen.add("tournament:matches");
        if (f.matches?.some((m) => m.error)) seen.add("tournament:no-winner");
        if (f.crew?.trust !== undefined) seen.add("skeptic:trust");
        if (r.current.critique) seen.add("ensemble:critique");
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "delphi:revisions",
        "ensemble:critique",
        "skeptic:trust",
        "tournament:matches",
        "tournament:no-winner",
      ].sort(),
    );
  });

  it("the tournament bracket with byes (five entrants) matches match for match", async () => {
    for (const seed of SEEDS) {
      const r = await both("tournament", "number", seed, 5, 0);
      expect(r.current.formation.matches?.length).toBe(r.legacy.formation.matches?.length);
      expect(stable(r.current)).toBe(stable(r.legacy));
      expect(r.calls).toEqual(r.legacyCalls);
    }
  });
});
