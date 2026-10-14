// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The proposition router (src/forecast/card-routing.ts): method cards with
 * preconditions, mechanical features plus an optional decisions booster, the
 * earned rule over cards from outcome evidence tagged family + method, the
 * routing record on the answer, and the competence map read back from it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DecisionProvider, DecisionRequest } from "../src/decisions/types";
import type { AnswerSpec } from "../src/forecast/answer-types";
import {
  type CardEvidence,
  chooseCard,
  evidenceFromOutcomes,
  forecastCarded,
} from "../src/forecast/card-routing";
import { competenceFrom, competenceMap, renderCompetence } from "../src/forecast/competence";
import { classChain, featurise, mechanicalFeatures } from "../src/forecast/featurise";
import { forecastFormed } from "../src/forecast/formations";
import {
  applyCard,
  cardContext,
  eligibility,
  RECIPE_CARDS,
  recipeCard,
} from "../src/forecast/method-cards";
import { routeSettingsFromEnv } from "../src/forecast/routing";
import { outcomeRefs, routingRefs } from "../src/forecast/routing-refs";
import type { ModelPart, TypedForecastDeps } from "../src/forecast/typed";
import { resolveForecast } from "../src/outcomes/forecast";
import { MarinaDB } from "../src/persistence/database";
import type { OutcomeRow } from "../src/persistence/db-outcomes";

const yesNo: AnswerSpec = {
  type: "choice",
  options: [{ id: "Yes" }, { id: "No" }],
  probabilities: true,
};
const number: AnswerSpec = { type: "number" };
const NOW = new Date("2026-10-05T00:00:00Z");
const now = () => NOW;

const part = (name: string, reply: (system: string) => string): ModelPart => ({
  name,
  complete: async (s) => reply(s),
});
const planner = part("planner", (system) => {
  if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
  if (system.startsWith("You review a research dossier")) return '{"done":true}';
  return '{"verdict":"keep"}';
});
const analyst = (name: string, p: number) =>
  part(name, () =>
    JSON.stringify({
      answer: p >= 0.5 ? "Yes" : "No",
      probabilities: { Yes: p, No: 1 - p },
      reason: `${name} reason`,
    }),
  );
let searches = 0;
const retriever = async () => {
  searches++;
  return {
    report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
    sources: [{ url: "https://example.org/1" }],
    costUsd: 0,
    searches: 1,
    retriever: "fake",
  };
};
const deps = (runs = 2): TypedForecastDeps => ({
  retriever,
  analysts: [analyst("m1", 0.7), analyst("m2", 0.6)],
  planner,
  critic: planner,
  now,
  options: { runs, researchRounds: 1 },
});

describe("method cards", () => {
  it("parses recipe specs into stable method keys; unknown specs are refused", () => {
    expect(recipeCard("delphi")?.id).toBe("formation:delphi");
    expect(recipeCard("formation:ensemble+closed-book")?.id).toBe("formation:ensemble+closed-book");
    expect(recipeCard("skeptic+noverify")?.id).toBe("formation:skeptic+noverify");
    expect(recipeCard("crowd")).toBeUndefined();
    expect(recipeCard("ensemble+web")).toBeUndefined();
    expect(recipeCard("ensemble+verify+noverify")).toBeUndefined();
    expect(RECIPE_CARDS.map((c) => c.id)).toContain("formation:tournament+closed-book");
  });

  it("a card whose preconditions fail here is never eligible", () => {
    const ctx = cardContext(deps(1));
    expect(eligibility(recipeCard("delphi")!, "choice", ctx)).toEqual({
      ok: false,
      why: "needs 2+ runs (have 1)",
    });
    expect(eligibility(recipeCard("ensemble")!, "choice", ctx).ok).toBe(true);
    const noRetriever = { ...ctx, retriever: false };
    expect(eligibility(recipeCard("ensemble")!, "choice", noRetriever).ok).toBe(false);
    expect(eligibility(recipeCard("ensemble+closed-book")!, "choice", noRetriever).ok).toBe(true);
  });

  it("applyCard: a plain formation runs on the operator's deps; variants override only their part", async () => {
    const d = deps();
    expect(applyCard(d, recipeCard("ensemble")!)).toBe(d);
    const closed = applyCard(d, recipeCard("ensemble+closed-book")!);
    expect((await closed.retriever({} as never)).report).toBe("");
    expect(closed.analysts).toBe(d.analysts);
    expect(applyCard(d, recipeCard("ensemble+noverify")!).options?.verify).toBe(false);
  });
});

describe("features", () => {
  it("mechanical: shape, group, horizon from the cutoff, labels; group always ends the chain", () => {
    const f = mechanicalFeatures(
      {
        question: "Q",
        answer: yesNo,
        endTime: "2026-10-15T00:00:00Z",
        category: "US Politics!",
      },
      { now: NOW, board: "FutureX" },
    );
    expect(f).toMatchObject({
      answerType: "choice",
      group: "binary:no|yes",
      category: "us-politics",
      board: "futurex",
      horizonDays: 10,
      closes: true,
      source: "mechanical",
    });
    expect(classChain(f)).toEqual(["board:futurex", "category:us-politics", "group:binary:no|yes"]);
  });

  const provider = (
    answers: Record<string, unknown>,
    seen: DecisionRequest[] = [],
  ): DecisionProvider => ({
    kind: "test",
    model: "test",
    calibrated: false,
    async ask(request) {
      seen.push(request);
      return { answers: answers as never, provider: "test", model: "test", latencyMs: 1 };
    },
  });

  it("decisions booster: the domain enters the chain; only masked question text and shape are sent", async () => {
    const seen: DecisionRequest[] = [];
    const f = await featurise(
      {
        question: "Will ada@example.com's bill pass?",
        answer: yesNo,
        context: "PRIVATE-CONTEXT",
        priors: [{ source: "market", p: 0.4, observedAt: "2026-10-01T00:00:00Z" } as never],
      },
      {
        now: NOW,
        mode: "on",
        providers: [
          provider(
            {
              domain: { type: "choice", choice: "politics" },
              scheduled_event: { type: "noul", noul: 0.83 },
            },
            seen,
          ),
        ],
      },
    );
    expect(f.domain).toBe("politics");
    expect(f.scheduledEvent).toBe(0.83);
    expect(f.source).toBe("mechanical+decisions");
    expect(f.receipt?.status).toBe("answered");
    expect(classChain(f)).toEqual(["domain:politics/binary:no|yes", "group:binary:no|yes"]);
    const state = JSON.stringify(seen[0]!.state);
    expect(state).not.toContain("ada@example.com");
    expect(state).not.toContain("PRIVATE-CONTEXT");
    expect(Object.keys(seen[0]!.state as object).sort()).toEqual(["answer_type", "question"]);
  });

  it("observe records the judgement without changing the class; failure and off fall open", async () => {
    const answers = {
      domain: { type: "choice", choice: "economy" },
      scheduled_event: { type: "noul", noul: 0.1 },
    };
    const observed = await featurise(
      { question: "Q", answer: number },
      { now: NOW, mode: "observe", providers: [provider(answers)] },
    );
    expect(observed.domain).toBe("economy");
    expect(classChain(observed)).toEqual(["group:number"]);

    const broken: DecisionProvider = {
      kind: "test",
      model: "test",
      calibrated: false,
      ask: async () => {
        throw new Error("down");
      },
    };
    const failed = await featurise(
      { question: "Q", answer: number },
      { now: NOW, mode: "on", providers: [broken] },
    );
    expect(failed.domain).toBeUndefined();
    expect(failed.receipt?.status).toBe("unavailable");
    expect(classChain(failed)).toEqual(["group:number"]);

    const seen: DecisionRequest[] = [];
    const off = await featurise(
      { question: "Q", answer: number },
      { now: NOW, mode: "off", providers: [provider(answers, seen)] },
    );
    expect(seen).toHaveLength(0);
    expect(off.receipt).toBeUndefined();
  });

  it("auto with no configured backend asks nothing", async () => {
    const f = await featurise({ question: "Q", answer: number }, { now: NOW, env: {} });
    expect(f.source).toBe("mechanical");
    expect(f.receipt).toBeUndefined();
  });
});

describe("routing refs", () => {
  it("tags families, method and question from the routing record; unsafe values dropped", () => {
    const json = JSON.stringify({
      routing: {
        families: ["category:x", "group:number", "bad value with spaces"],
        method: "formation:delphi",
        question: "item-7",
      },
    });
    expect(routingRefs(json)).toEqual([
      "family:category:x",
      "family:group:number",
      "method:formation:delphi",
      "q:item-7",
    ]);
    expect(
      routingRefs(JSON.stringify({ typed: { routing: { method: "formation:ensemble" } } })),
    ).toEqual(["method:formation:ensemble"]);
    expect(routingRefs("not json")).toEqual([]);
    expect(outcomeRefs('["a",1,"b"]')).toEqual(["a", "b"]);
  });
});

/** Seeded evidence: `n` questions in a class, both methods answered, the challenger by `gain`. */
function seeded(
  family: string,
  n: number,
  gain: number,
  opts: { challenger?: string; measure?: boolean; at?: number } = {},
): CardEvidence[] {
  const out: CardEvidence[] = [];
  for (let i = 0; i < n; i++) {
    const base = 0.5 + ((i * 37) % 11) / 100;
    const q = `q:${family}-${i}`;
    const resolvedAt = opts.at ?? Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000;
    const measure = opts.measure ?? false;
    out.push({
      family,
      method: "formation:ensemble",
      question: q,
      score: base,
      resolvedAt,
      measure,
    });
    out.push({
      family,
      method: opts.challenger ?? "formation:delphi",
      question: q,
      score: base + gain + (i % 2 ? 0.01 : -0.01),
      resolvedAt,
      measure,
    });
  }
  return out;
}

describe("chooseCard", () => {
  const settings = { mode: "on" as const, minN: 10 };
  const features = mechanicalFeatures({ question: "Q", answer: yesNo }, { now: NOW });
  const base = {
    features,
    defaultCard: recipeCard("ensemble")!,
    candidates: ["formation:ensemble", "formation:delphi", "formation:tournament"],
    ctx: cardContext(deps(3)),
    settings,
    cutoff: NOW.toISOString(),
  };

  it("no evidence: the default stands, recorded with its class chain", () => {
    const r = chooseCard({ ...base, evidence: [] });
    expect(r.method).toBe("formation:ensemble");
    expect(r.class).toBe("group:binary:no|yes");
    expect(r.families).toEqual(["group:binary:no|yes"]);
    expect(r.reason).toContain("stands");
  });

  it("a paired held-out win past the margin picks the challenger; observe keeps the default", () => {
    const evidence = seeded("group:binary:no|yes", 20, 0.1);
    const on = chooseCard({ ...base, evidence });
    expect(on.method).toBe("formation:delphi");
    expect(on.challengers.find((c) => c.id === "formation:delphi")?.verdict).toBe("qualifies");
    const observe = chooseCard({ ...base, evidence, settings: { ...settings, mode: "observe" } });
    expect(observe.picked).toBe("formation:delphi");
    expect(observe.method).toBe("formation:ensemble");
  });

  it("too few pairs, a loss, or evidence after the cutoff never replace the default", () => {
    expect(chooseCard({ ...base, evidence: seeded("group:binary:no|yes", 5, 0.2) }).method).toBe(
      "formation:ensemble",
    );
    expect(chooseCard({ ...base, evidence: seeded("group:binary:no|yes", 20, -0.1) }).method).toBe(
      "formation:ensemble",
    );
    const late = seeded("group:binary:no|yes", 20, 0.1, { at: Date.parse("2026-10-06T00:00:00Z") });
    expect(chooseCard({ ...base, evidence: late }).method).toBe("formation:ensemble");
  });

  it("an ineligible challenger is never picked, whatever its evidence", () => {
    const r = chooseCard({
      ...base,
      ctx: cardContext(deps(1)),
      evidence: seeded("group:binary:no|yes", 20, 0.2),
    });
    expect(r.method).toBe("formation:ensemble");
    expect(r.candidates.find((c) => c.id === "formation:delphi")).toMatchObject({
      eligible: false,
    });
  });

  it("measurement rows count only for their own board's class", () => {
    const measured = seeded("group:binary:no|yes", 20, 0.2, { measure: true });
    expect(chooseCard({ ...base, evidence: measured }).method).toBe("formation:ensemble");
    const boardFeatures = mechanicalFeatures(
      { question: "Q", answer: yesNo },
      { now: NOW, board: "futurex" },
    );
    const r = chooseCard({
      ...base,
      features: boardFeatures,
      evidence: seeded("board:futurex", 20, 0.2, { measure: true }),
    });
    expect(r.class).toBe("board:futurex");
    expect(r.method).toBe("formation:delphi");
  });

  it("the most specific class with enough evidence answers; siblings only order exploration", () => {
    const catFeatures = mechanicalFeatures(
      { question: "Q", answer: yesNo, category: "sports" },
      { now: NOW },
    );
    // Outcomes are tagged with their whole chain: each row's category AND group.
    const both = (cat: string, ev: CardEvidence[]) =>
      ev
        .flatMap((e) => [e, { ...e, family: "group:binary:no|yes" }])
        .map((e) => ({
          ...e,
          question: e.question.replace(cat, `x-${cat}`),
        }));
    // This category: 12 tied questions (delphi = ensemble). A SIBLING category: tournament strong.
    const own = both("category:sports", seeded("category:sports", 12, 0));
    const sibling = both(
      "category:politics",
      seeded("category:politics", 8, 0.3, { challenger: "formation:tournament" }),
    );
    const r = chooseCard({ ...base, features: catFeatures, evidence: own.concat(sibling) });
    // 10+ records in its own category: the category is the class, where nothing earned a win.
    expect(r.class).toBe("category:sports");
    expect(r.method).toBe("formation:ensemble");
    // The sibling's strong tournament record only orders what to try next.
    expect(r.explore[0]).toBe("formation:tournament");

    // Too little in its own category: the group (which holds the sibling's questions) is the class.
    const thin = both("category:sports", seeded("category:sports", 3, 0));
    const r2 = chooseCard({ ...base, features: catFeatures, evidence: thin.concat(sibling) });
    expect(r2.class).toBe("group:binary:no|yes");
  });
});

describe("forecastCarded", () => {
  it("with no evidence the default card answers exactly as the formation does, and records the decision", async () => {
    searches = 0;
    const req = { question: "Will it?", answer: yesNo, id: "item-1" };
    const settings = routeSettingsFromEnv({});
    const routed = await forecastCarded(req, deps(), "ensemble", settings, {
      env: {},
      featureProviders: [],
    });
    const plainSearches = searches;
    const plain = await forecastFormed(req, deps(), "ensemble");
    expect(routed.routing.method).toBe("formation:ensemble");
    expect(routed.routing.question).toBe("item-1");
    expect(routed.prediction).toBe(plain.prediction);
    expect(routed.distribution).toEqual(plain.distribution);
    expect(plainSearches).toBeGreaterThan(0);
    const { routing: _routing, ...rest } = routed;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(plain).sort());
  });

  it("an earned closed-book card answers without web research", async () => {
    const t0 = Date.parse("2026-09-01T00:00:00Z");
    const rows = seeded("group:binary:no|yes", 30, 0.1, {
      challenger: "formation:ensemble+closed-book",
    }).map(
      (e, i): OutcomeRow => ({
        id: i + 1,
        subject: `forecast:${i + 1}`,
        kind: "forecast",
        source: "forecast:choice",
        domain: "forecast",
        owner: "Ada",
        succeeded: 1,
        quality: e.score,
        loss: 1 - e.score,
        metric: "brier",
        truth_json: null,
        detail: null,
        basis: "mechanical",
        judge: null,
        eval_mode: "live",
        participants_json: null,
        refs_json: JSON.stringify([`family:${e.family}`, `method:${e.method}`, e.question]),
        resolved_at: t0 + i,
        created_at: t0 + i,
      }),
    );
    const db = { listOutcomes: () => rows };
    searches = 0;
    const a = await forecastCarded(
      { question: "Will it?", answer: yesNo },
      deps(),
      "ensemble",
      routeSettingsFromEnv({ MARINA_FORECAST_ROUTE_CANDIDATES: "ensemble,ensemble+closed-book" }),
      { db, env: {}, featureProviders: [] },
    );
    expect(a.routing.method).toBe("formation:ensemble+closed-book");
    expect(searches).toBe(0);
  });

  it("routing off: no evidence read, default answers, outcome still tagged", async () => {
    let read = 0;
    const a = await forecastCarded(
      { question: "Will it?", answer: yesNo },
      deps(),
      "ensemble",
      routeSettingsFromEnv({ MARINA_FORECAST_ROUTE: "off" }),
      {
        db: {
          listOutcomes: () => {
            read++;
            return [];
          },
        },
        env: {},
      },
    );
    expect(read).toBe(0);
    expect(a.routing.mode).toBe("off");
    expect(a.routing.method).toBe("formation:ensemble");
    expect(a.routing.families).toEqual(["group:binary:no|yes"]);
  });
});

describe("outcomes carry the routing tags; the competence map reads them back", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("resolveForecast adds family / method / q refs; the map shows live cells with coverage", () => {
    const save = (mean: number, method: string, q: string) =>
      db.saveForecastAnswer({
        entityName: "Ada",
        question: "How many?",
        kind: "number",
        mean,
        sd: 1,
        answerJson: JSON.stringify({
          routing: { families: ["category:x", "group:number"], method, question: q },
        }),
      });
    const t = Date.parse("2026-10-01T00:00:00Z");
    resolveForecast(db, save(10, "formation:ensemble", "a"), { value: 10.5 }, t);
    resolveForecast(db, save(10, "formation:delphi", "a"), { value: 10.5 }, t + 1);
    resolveForecast(db, save(10, "formation:ensemble", "b"), { value: 14 }, t + 2);
    const rows = db.listOutcomes({ kind: "forecast" });
    expect(outcomeRefs(rows[0]!.refs_json)).toEqual(
      expect.arrayContaining(["family:category:x", "family:group:number", "q:b"]),
    );
    // One evidence item per family the outcome is tagged with; both methods pair on `q:a`.
    const ev = evidenceFromOutcomes(rows).filter((e) => e.family === "group:number");
    expect(
      ev
        .filter((e) => e.question === "q:a")
        .map((e) => e.method)
        .sort(),
    ).toEqual(["formation:delphi", "formation:ensemble"]);
    const map = competenceMap(db, { family: "group:" });
    const ens = map.find((c) => c.method === "formation:ensemble")!;
    expect(ens).toMatchObject({ family: "group:number", metric: "crps", live: 2, measure: 0 });
    expect(ens.coverage80).toEqual({ rate: 0.5, n: 2 });
    expect(renderCompetence(map)).toContain("group:number  formation:ensemble  2 live");
  });

  it("measurement rows are counted separately and judged rows are ignored", () => {
    const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
      id: 1,
      subject: "bench:1",
      kind: "benchmark",
      source: "benchmark:gsm8k",
      domain: "benchmark",
      owner: null,
      succeeded: 1,
      quality: 0.7,
      loss: 0.3,
      metric: "score",
      truth_json: null,
      detail: null,
      basis: "mechanical",
      judge: null,
      eval_mode: "measure",
      participants_json: null,
      refs_json: JSON.stringify(["family:gsm8k", "method:model:m"]),
      resolved_at: 1,
      created_at: 1,
      ...over,
    });
    const map = competenceFrom([
      row({}),
      row({ id: 2, quality: 0.9 }),
      row({ id: 3, basis: "judged" }),
    ]);
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({
      family: "gsm8k",
      method: "model:m",
      live: 0,
      measure: 2,
      mean: 0.8,
    });
    expect(renderCompetence([])).toContain("no resolved");
  });
});
