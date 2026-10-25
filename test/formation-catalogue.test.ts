// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The formation catalogue (`src/orchestration/formations/`): one entry per
 * formation, one description each, and every surface named after it agrees
 * with it — the crew briefs, the project templates, `PATTERN_FIT`, the text
 * patterns, the typed formations and the arena's. Templates instantiate to
 * valid Scores; the resident Scores are byte-identical to the pre-catalogue
 * ones; `model:` and `role:` assignees run the same template.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { FORMATION_PATTERNS } from "../src/arena/formations";
import { CREW_BRIEFS, crewFormationEntry } from "../src/coordination/crew-formations";
import { SpendGuard } from "../src/engine/spend-guard";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed, TYPED_FORMATIONS, typedScore } from "../src/forecast/formations";
import {
  assigneePart,
  modelSlotPart,
  type PartFactory,
  RESIDENT_PATTERNS,
  residentForecastScore,
  runResidentForecast,
  type SlotPart,
} from "../src/forecast/resident-forecast";
import {
  attachResidentDispatcher,
  isResidentPart,
  type ResidentDispatcher,
} from "../src/forecast/resident-part";
import type { ModelPart, TypedForecastDeps } from "../src/forecast/typed";
import {
  FORMATION_NAMES,
  FORMATIONS,
  NUMERIC_TEMPLATES,
  TEXT_TEMPLATES,
  TYPED_TEMPLATES,
} from "../src/orchestration/formations/catalogue";
import { afterEntrants, formationScore, knockout } from "../src/orchestration/formations/template";
import { CREW_ONLY_PATTERNS, TEXT_PATTERNS } from "../src/orchestration/text-patterns";
import { validateScore } from "../src/sdk/score";
import type { CrewFormation } from "../src/types";
import {
  ORCHESTRATION_PATTERNS,
  ORCHESTRATION_TEMPLATES,
  PATTERN_FIT,
  type TemplatePattern,
} from "../src/world/templates/orchestration";
import { legacyResidentForecastScore } from "./fixtures/formations-legacy/resident-score";

/** The patterns with a project template: every crew formation but `freeform` (the blank slate). */
const crewPatterns = ORCHESTRATION_PATTERNS.filter((p): p is TemplatePattern => p !== "freeform");

describe("one catalogue, one description per formation", () => {
  it("every orchestration pattern is a crew entry, and every crew entry a pattern", () => {
    for (const p of ORCHESTRATION_PATTERNS) expect(FORMATIONS[p]?.crew, p).toBe(true);
    const crew = FORMATION_NAMES.filter((n) => FORMATIONS[n].crew);
    expect([...crew].sort()).toEqual([...ORCHESTRATION_PATTERNS].sort());
    for (const n of FORMATION_NAMES) expect(FORMATIONS[n].name).toBe(n);
  });

  it("PATTERN_FIT describes each pattern with the catalogue's summary", () => {
    for (const p of crewPatterns) expect(PATTERN_FIT[p].why, p).toBe(FORMATIONS[p].summary);
  });

  it("crew briefs and project templates name their catalogue entry and keep its protocol phrases", () => {
    for (const formation of Object.keys(CREW_BRIEFS) as CrewFormation[]) {
      const entry = crewFormationEntry(formation);
      expect(entry?.name, formation).toBe(formation);
      const brief = CREW_BRIEFS[formation].toLowerCase();
      expect(entry!.markers?.length, `${formation} markers`).toBeGreaterThan(0);
      for (const m of entry!.markers ?? [])
        expect(brief.includes(m.toLowerCase()), `${formation} brief lost "${m}"`).toBe(true);
      // `freeform` seeds no project template.
      if (formation === "freeform") continue;
      const template = ORCHESTRATION_TEMPLATES[formation]
        .map((n) => n.content)
        .join(" ")
        .toLowerCase();
      for (const m of entry!.templateMarkers ?? entry!.markers ?? [])
        expect(template.includes(m.toLowerCase()), `${formation} template lost "${m}"`).toBe(true);
    }
    // Every crew entry has its brief and its template.
    for (const p of crewPatterns) {
      expect(CREW_BRIEFS[p as CrewFormation], p).toBeDefined();
      expect(ORCHESTRATION_TEMPLATES[p], p).toBeDefined();
    }
  });

  it("the text patterns, the crew-only refusals, the typed and the arena formations are the catalogue's", () => {
    const text = FORMATION_NAMES.filter((n) => FORMATIONS[n].text);
    expect<string[]>([...TEXT_PATTERNS].sort()).toEqual([...text].sort());
    expect(Object.keys(TEXT_TEMPLATES)).toEqual([...TEXT_PATTERNS]);
    for (const p of TEXT_PATTERNS) expect(FORMATIONS[p].text).toBe(TEXT_TEMPLATES[p]);
    const crewOnly = FORMATION_NAMES.filter((n) => FORMATIONS[n].crewOnly);
    expect(Object.keys(CREW_ONLY_PATTERNS)).toEqual(crewOnly);
    for (const n of crewOnly) expect(CREW_ONLY_PATTERNS[n]).toBe(FORMATIONS[n].crewOnly!);
    // A pattern is either a one-task text protocol or crew-only, never both, never neither.
    for (const p of crewPatterns)
      expect(!!FORMATIONS[p].text !== !!FORMATIONS[p].crewOnly, p).toBe(true);
    expect(Object.keys(TYPED_TEMPLATES)).toEqual([...TYPED_FORMATIONS]);
    expect([...RESIDENT_PATTERNS]).toEqual([...TYPED_FORMATIONS]);
    const numeric = FORMATION_NAMES.filter((n) => FORMATIONS[n].numeric);
    expect([...numeric].sort()).toEqual([...FORMATION_PATTERNS].sort());
    for (const n of numeric) {
      const own = FORMATIONS[n].numeric!;
      expect(own.runtime === "catalogue", n).toBe(own.template !== undefined);
      if (own.template) expect(own.template).toBe(NUMERIC_TEMPLATES[n as "ensemble" | "delphi"]);
    }
  });
});

describe("templates", () => {
  const all = [
    ...Object.entries(TYPED_TEMPLATES).map(([n, t]) => [`typed ${n}`, t] as const),
    ...Object.entries(TEXT_TEMPLATES).map(([n, t]) => [`text ${n}`, t] as const),
    ...Object.entries(NUMERIC_TEMPLATES).map(([n, t]) => [`numeric ${n}`, t] as const),
  ];

  it("instantiate to valid Scores for 1–7 members, whole and after their entrants", () => {
    let checked = 0;
    for (const [name, t] of all) {
      for (let k = 1; k <= 7; k++) {
        const whole = formationScore(t, { k, id: name, assign: (slot, i) => `role:${slot}${i}` });
        expect(validateScore(whole), `${name} k=${k}`).toBeNull();
        if (t.entrants) {
          const rest = formationScore(t, {
            k,
            id: name,
            assign: (slot) => `role:${slot}`,
            only: afterEntrants(t),
          });
          if (rest.steps.length) expect(validateScore(rest), `${name} rest k=${k}`).toBeNull();
          expect(rest.steps.some((s) => s.id.startsWith(t.entrants!) && /\d$/.test(s.id))).toBe(
            false,
          );
        }
        checked++;
      }
    }
    expect(checked).toBe(all.length * 7);
  });

  it("a knockout over n entrants has n − 1 matches, an odd field a bye, one champion", () => {
    for (let n = 1; n <= 9; n++) {
      const rounds = knockout(
        Array.from({ length: n }, (_, i) => `f${i + 1}`),
        "m",
      );
      const slots = rounds.flat();
      expect(slots.filter((s) => s.b).length).toBe(Math.max(0, n - 1));
      if (n > 1) expect(rounds.at(-1)).toHaveLength(1);
      for (const round of rounds) for (const s of round.slice(0, -1)) expect(s.b).toBeDefined();
    }
    expect(knockout(["a", "b", "c"])).toEqual([
      [
        { id: "m1", round: 1, a: "a", b: "b" },
        { id: "m-bye1", round: 1, a: "c" },
      ],
      [{ id: "m2", round: 2, a: "m1", b: "m-bye1" }],
    ]);
  });

  it("schedules a typed tournament match by match and a text tournament round by round", () => {
    const typed = typedScore("tournament", [{ name: "a" }, { name: "b" }, { name: "c" }], {
      name: "critic",
    });
    expect(typed.steps.map((s) => s.id)).toEqual([
      "research",
      "f1",
      "f2",
      "f3",
      "m1",
      "m-bye1",
      "m2",
      "combine",
    ]);
    expect(typed.steps.find((s) => s.id === "m-bye1")!.access).toEqual(["f3", "m1"]);
    expect(typed.steps.find((s) => s.id === "m1")!.assignee).toBe("model:critic");
    expect(typed.steps.find((s) => s.id === "f2")!.assignee).toBe("model:b");
    const text = formationScore(TEXT_TEMPLATES.tournament, {
      k: 5,
      id: "t",
      assign: () => "model:x",
    });
    expect(text.steps.find((s) => s.id === "match3")!.access).toEqual([
      "match1",
      "match2",
      "match-bye1",
    ]);
  });
});

describe("the resident Scores are the catalogue's templates", () => {
  it("ensemble and delphi instantiate exactly as before the catalogue", () => {
    for (const pattern of ["ensemble", "delphi"] as const)
      for (const k of [0, 1, 2, 2.6, 3, 7, 9])
        for (const assignee of [undefined, "marina:crewx", "role:analyst", "model:vendor/x"]) {
          expect(residentForecastScore(pattern, k, assignee)).toEqual(
            legacyResidentForecastScore(pattern, k, assignee),
          );
          expect(residentForecastScore(pattern, k, assignee, "custom-id")).toEqual(
            legacyResidentForecastScore(pattern, k, assignee, "custom-id"),
          );
        }
  });

  it("tournament refs its matches to the pipeline; the skeptic crew is always two residents", () => {
    const t = residentForecastScore("tournament", 4);
    expect(t.steps.filter((s) => s.assignee === "role:forecaster").map((s) => s.id)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
    ]);
    expect(t.steps.filter((s) => /^m\d/.test(s.id))).toHaveLength(3);
    const s = residentForecastScore("skeptic", 6, "marina:crewx");
    expect(s.steps.map((x) => x.id)).toEqual(["research", "f1", "f2", "skeptic", "combine"]);
    expect(s.goal).toBe("Resident forecast (skeptic, 2 residents)");
    expect(s.steps.find((x) => x.id === "skeptic")!.assignee).toBe("model:marina-forecast");
  });
});

// ─── model: and role: in the same slots ──────────────────────────────────────

const yesNo: AnswerSpec = {
  type: "choice",
  options: [{ id: "Yes" }, { id: "No" }],
  probabilities: true,
};
const part = (name: string, reply: (system: string, user: string) => string): ModelPart => ({
  name,
  complete: async (s, u) => reply(s, u),
});
const planner = part("planner", (system) => {
  if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
  if (system.startsWith("You review a research dossier")) return '{"done":true}';
  if (system.startsWith("You referee")) return '{"winner":"B","reason":"better grounded"}';
  if (system.startsWith("You are the skeptic")) return '{"trust":0.6,"critique":"ok"}';
  return '{"verdict":"keep"}';
});
const deps = (): TypedForecastDeps => ({
  retriever: async () => ({
    report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
    sources: [{ url: "https://example.org/1" }],
    costUsd: 0,
    searches: 1,
    retriever: "fake",
  }),
  analysts: [planner],
  planner,
  critic: planner,
  now: () => new Date("2026-10-05T00:00:00Z"),
  options: { researchRounds: 1, critique: false },
});
/** A member answering p in round one (q when revising), by slot. */
const answers = [0.8, 0.3, 0.6];
const replyFor = (i: number) => (system: string) => {
  const p = system.includes("Delphi") ? answers[i]! - 0.1 : answers[i]!;
  return JSON.stringify({
    answer: p >= 0.5 ? "Yes" : "No",
    probabilities: { Yes: p, No: 1 - p },
    reason: `slot ${i} reason`,
  });
};

let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  detach = undefined;
});

describe("assignees are interchangeable", () => {
  it("assigneePart: model:<id> is a model, role:/marina: a resident", () => {
    expect(isResidentPart(assigneePart("role:forecaster", {}))).toBe(true);
    expect(isResidentPart(assigneePart("marina:crewx", {}))).toBe(true);
    const m = assigneePart("model:vendor/x", {});
    expect(isResidentPart(m)).toBe(false);
    expect(m.spec).toBe("model:vendor/x");
  });

  it("a model slot stops at the forecast's spend cap before any call", async () => {
    const spend = new SpendGuard({ label: "cap", budgetUsd: 0.01, daily: false });
    spend.record(1);
    const m = modelSlotPart("model:vendor/x", { spend });
    await expect(m.complete("s", "u")).rejects.toThrow(/model:vendor\/x/);
  });

  for (const pattern of ["ensemble", "delphi", "tournament", "skeptic"] as const) {
    it(`${pattern}: model: and role: slots give the plain formation's answer`, async () => {
      // role: residents (in-process dispatcher) …
      let n = 0;
      const dispatcher: ResidentDispatcher = {
        async ask(_spec, request) {
          const slot = request.slot ?? 0;
          n++;
          return { text: replyFor(slot)(request.system), resident: `res${slot}` };
        },
      };
      detach = attachResidentDispatcher(dispatcher);
      const viaRole = await runResidentForecast(
        { forecast: { question: "Will it?", answer: yesNo }, pattern, k: 3 },
        deps(),
        { calls: 30, timeoutMs: 60_000 },
      );
      expect(n).toBeGreaterThan(0);
      expect(viaRole.residents.producers.length).toBeGreaterThan(0);
      // … model: slots (a model part per slot, no residents) …
      const made: SlotPart[] = [];
      const factory: PartFactory = (spec, opts) => {
        const i = opts.slot ?? 0;
        const p: SlotPart = {
          name: opts.name ?? spec,
          spec,
          calls: [],
          complete: async (s) => replyFor(i)(s),
        };
        made.push(p);
        return p;
      };
      const viaModel = await runResidentForecast(
        {
          forecast: { question: "Will it?", answer: yesNo },
          pattern,
          k: 3,
          assignee: "model:vendor/x",
        },
        deps(),
        { calls: 30, timeoutMs: 60_000 },
        { part: factory },
      );
      expect(made.map((p) => p.spec)).toEqual(Array(made.length).fill("model:vendor/x"));
      expect(viaModel.residents.producers).toEqual([]);
      expect(viaModel.residents.steps.find((s) => s.step === "combine")?.status).toBe("done");
      // … and the plain formation over the same answers.
      const k = pattern === "skeptic" ? 2 : 3;
      const plain = await forecastFormed(
        { question: "Will it?", answer: yesNo },
        {
          ...deps(),
          analysts: Array.from({ length: k }, (_, i) => part(`m${i}`, replyFor(i))),
          options: { researchRounds: 1, critique: false, runs: k },
        },
        pattern,
      );
      for (const got of [viaRole, viaModel]) {
        expect(got.formatted).toBe(plain.formatted);
        expect(got.distribution?.Yes).toBeCloseTo(plain.distribution!.Yes!, 9);
        expect(got.formation.pattern).toBe(pattern);
      }
      if (pattern === "tournament") expect(viaRole.formation.matches).toHaveLength(2);
      if (pattern === "skeptic") expect(viaRole.formation.crew?.trust).toBe(0.6);
    });
  }
});
