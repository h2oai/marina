// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecasts answered by residents: `ResidentPart` dispatch and attribution
 * (in-process and over HTTP), the forecast as a task run as a Score
 * (ensemble, delphi), its budget, deadline and fence, per-resident filing and
 * producer credit — and that with MARINA_FORECAST_RESIDENTS off nothing changes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ledgerFor } from "../src/agent/standing";
import { WorkBudget } from "../src/coordination/work-budget";
import { currentEvidenceCutoff, resetEvidenceFenceForTests } from "../src/engine/evidence-fence";
import { SpendGuard } from "../src/engine/spend-guard";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed } from "../src/forecast/formations";
import {
  fileResidentRuns,
  forecastAsTask,
  type PartFactory,
  residentForecastScore,
  runResidentForecast,
} from "../src/forecast/resident-forecast";
import {
  attachResidentDispatcher,
  fencedForResidents,
  isResidentPart,
  type ResidentDispatcher,
  type ResidentRequest,
  residentFenceAt,
  residentPart,
} from "../src/forecast/resident-part";
import { routingRefs } from "../src/forecast/routing-refs";
import { modelPart } from "../src/forecast/service";
import { forecastTyped, type ModelPart, type TypedForecastDeps } from "../src/forecast/typed";
import { attachModelTraceSink, type ModelLifecycleEvent } from "../src/model/trace";
import {
  inProcessResidentDispatcher,
  residentEndpoint,
  residentForRole,
} from "../src/net/model-api/resident-dispatch";
import { resolveForecast } from "../src/outcomes/forecast";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { createTestEngine } from "./engine-fixture";
import { cleanupDb } from "./helpers";

const yesNo: AnswerSpec = {
  type: "choice",
  options: [{ id: "Yes" }, { id: "No" }],
  probabilities: true,
};
const retriever = async () => ({
  report: "- 2026-05-20 — a fact ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});
const part = (name: string, reply: (system: string, user: string) => string): ModelPart => ({
  name,
  complete: async (s, u) => reply(s, u),
});
const planner = part("planner", (system) => {
  if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
  if (system.startsWith("You review a research dossier")) return '{"done":true}';
  return '{"verdict":"keep"}';
});
const NOW = new Date("2026-10-05T00:00:00Z");
const PAST = "2026-06-01T00:00:00.000Z";
const baseDeps = (): TypedForecastDeps => ({
  retriever,
  analysts: [planner],
  planner,
  critic: planner,
  now: () => NOW,
  options: { researchRounds: 1, critique: false },
});

/** A probability reply as a resident would send it (round one p, after the panel q). */
const reply =
  (p: number, q = p) =>
  (system: string) => {
    const pp = system.includes("Delphi") ? q : p;
    return JSON.stringify({
      answer: pp >= 0.5 ? "Yes" : "No",
      probabilities: { Yes: pp, No: 1 - pp },
      reason: "my tools say so",
    });
  };

/** In-process mocked residents: who answers each call, and what each one saw. */
function fakeDispatcher(answers: Record<string, (system: string) => string>, order: string[]) {
  const seen: Array<ResidentRequest & { spec: string; asOf?: string }> = [];
  let i = 0;
  const dispatcher: ResidentDispatcher = {
    async ask(spec, request) {
      const resident = order[i++ % order.length]!;
      seen.push({
        ...request,
        spec,
        ...(currentEvidenceCutoff() ? { asOf: currentEvidenceCutoff() } : {}),
      });
      return {
        text: answers[resident]!(request.system),
        resident,
        requestId: `req-${i}`,
        costUsd: 0.01,
      };
    },
  };
  return { dispatcher, seen };
}

let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  detach = undefined;
  resetEvidenceFenceForTests();
});

describe("ResidentPart", () => {
  it("dispatches in-process, records who answered, passes the deadline and the fence", async () => {
    const { dispatcher, seen } = fakeDispatcher({ ann: reply(0.7) }, ["ann"]);
    detach = attachResidentDispatcher(dispatcher);
    const events: ModelLifecycleEvent[] = [];
    const untrace = attachModelTraceSink((e) => events.push(e));
    try {
      const p = residentPart("role:forecaster", {
        endsAt: Date.now() + 30_000,
        trace: { traceId: "trace-f1", caller: "forecast.test" },
      });
      expect(isResidentPart(p)).toBe(true);
      const { withEvidenceCutoff } = await import("../src/engine/evidence-fence");
      const text = await withEvidenceCutoff(PAST, () => p.complete("sys", "user"));
      expect(JSON.parse(text).answer).toBe("Yes");
      expect(p.calls).toEqual([
        expect.objectContaining({
          spec: "role:forecaster",
          resident: "ann",
          via: "in-process",
          asOf: PAST,
        }),
      ]);
      expect(seen[0]!.evidenceCutoff).toBe(PAST);
      expect(seen[0]!.deadlineMs).toBeGreaterThan(20_000);
      expect(seen[0]!.deadlineMs).toBeLessThanOrEqual(30_000);
      const completed = events.find((e) => e.phase === "completed")!;
      expect(completed).toMatchObject({ traceId: "trace-f1", target: "ann", routeKind: "agent" });
      expect(completed.traceContext).toMatchObject({ caller: "forecast.test" });
    } finally {
      untrace();
    }
  });

  it("refuses a measured call without the fence, and stops at the budget and spend scope", async () => {
    const { dispatcher } = fakeDispatcher({ ann: reply(0.7) }, ["ann"]);
    detach = attachResidentDispatcher(dispatcher);
    await expect(
      residentPart("role:forecaster", { requireFence: true }).complete("s", "u"),
    ).rejects.toThrow("as-of fence");
    const budget = new WorkBudget({ calls: 1, concurrency: 1, timeoutMs: 10_000 });
    const capped = residentPart("role:forecaster", { budget });
    await capped.complete("s", "u");
    await expect(capped.complete("s", "u")).rejects.toThrow("budget exhausted");
    const spend = new SpendGuard({ label: "test scope", budgetUsd: 0.015, daily: false });
    const scoped = residentPart("role:forecaster", { spend });
    await scoped.complete("s", "u");
    await expect(scoped.complete("s", "u")).rejects.toThrow("test scope");
  });

  it("outside the server: marina: over HTTP with the fence, deadline and attribution; role: refused", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "0.3" } }] }), {
        headers: { "x-marina-respondent": "Lead", "x-request-id": "req-h1" },
      });
    }) as unknown as typeof fetch;
    const env = { MARINA_FORECAST_MARINA_URL: "http://marina.test:3300" };
    const p = residentPart("marina:crewx", { env, fetch: fetcher, callDeadlineMs: 45_000 });
    const { withEvidenceCutoff } = await import("../src/engine/evidence-fence");
    expect(await withEvidenceCutoff(PAST, () => p.complete("sys", "user"))).toBe("0.3");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("http://marina.test:3300/v1/chat/completions");
    expect(headers["x-marina-asof"]).toBe(PAST);
    expect(headers["x-marina-deadline-ms"]).toBe("45000");
    expect(p.calls[0]).toMatchObject({ resident: "Lead", requestId: "req-h1", via: "http" });
    await expect(
      residentPart("role:forecaster", { env, fetch: fetcher }).complete("s", "u"),
    ).rejects.toThrow("inside the Marina server");
  });
});

describe("in-process dispatch over the engine", () => {
  let f: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    f = createTestEngine();
  });
  afterEach(async () => {
    await f.dispose();
  });

  /** A resident that answers every model_request on its channels with `text`. */
  function answers(entityId: string, name: string, text: string) {
    const cm = f.engine.channelManager!;
    cm.onMessage((channelId, senderId, _n, content) => {
      if (senderId !== "__model_api__" || !cm.isMember(channelId, entityId)) return;
      const req = JSON.parse(content) as { type?: string; id?: string; target?: string };
      if (req.type !== "model_request" || req.target !== entityId) return;
      cm.send(
        channelId,
        entityId,
        name,
        JSON.stringify({ type: "model_response", id: req.id, content: text }),
      );
    });
  }

  it("role: resolves by standing, routes pinned to that resident, and names it", async () => {
    const a = f.login("Alpha");
    const b = f.login("Beta");
    for (const [n, conn] of [
      ["Alpha", a.connection],
      ["Beta", b.connection],
    ] as const) {
      f.db.saveAgentConfig({
        name: n,
        model: "test/model",
        role: "forecaster",
        spawnedBy: "system",
      });
      conn.internal = true;
    }
    // Beta has earned standing: the role resolves to it.
    f.db.appendStandingEvent({
      entityId: b.entityId,
      entityName: "Beta",
      kind: "task_complete",
      ref: "task:1",
      amount: 5,
    });
    const top = residentForRole(f.engine, "forecaster");
    expect(top?.name).toBe("Beta");
    answers(a.entityId, "Alpha", "from Alpha");
    answers(b.entityId, "Beta", "from Beta");
    const model = residentEndpoint(f.engine, top!);
    expect(model).toBe(`marina:resident-${top!.name.toLowerCase()}`);
    const d = inProcessResidentDispatcher(f.engine);
    const r = await d.ask("role:forecaster", { system: "S", user: "U", deadlineMs: 5_000 });
    expect(r.resident).toBe(top!.name);
    expect(r.text).toBe(`from ${top!.name}`);
    expect(r.requestId).toMatch(/^req-/);
    // A second slot rotates to the next resident by standing.
    const second = await d.ask("role:forecaster", {
      system: "S",
      user: "U",
      deadlineMs: 5_000,
      slot: 1,
    });
    expect(second.resident).toBe("Alpha");
    // The asker is never asked (its own command slot is busy waiting).
    const notSelf = await d.ask("role:forecaster", { system: "S", user: "U", exclude: "Beta" });
    expect(notSelf.resident).toBe("Alpha");
    await expect(d.ask("role:nobody", { system: "S", user: "U" })).rejects.toThrow(
      "no live resident",
    );
  });

  it("marina:<crew> goes through routeToChannel with the fence on the envelope", async () => {
    const lead = f.login("Lead");
    lead.connection.internal = true;
    const cm = f.engine.channelManager!;
    const ch = cm.createChannel({ type: "model", name: "model-crewr" });
    cm.addMember(ch.id, lead.entityId);
    let asof: unknown;
    cm.onMessage((channelId, senderId, _n, content) => {
      if (channelId !== ch.id || senderId !== "__model_api__") return;
      const req = JSON.parse(content) as { type?: string; id?: string; asof?: string };
      if (req.type !== "model_request") return;
      asof = req.asof;
      cm.send(
        channelId,
        lead.entityId,
        "Lead",
        JSON.stringify({ type: "model_response", id: req.id, content: "0.2" }),
      );
    });
    const r = await inProcessResidentDispatcher(f.engine).ask("marina:crewr", {
      system: "S",
      user: "U",
      evidenceCutoff: PAST,
    });
    expect(r).toMatchObject({ text: "0.2", resident: "Lead" });
    expect(asof).toBe(PAST);
  });
});

describe("a forecast as a Score", () => {
  it("templates: ensemble = research → K → combine; delphi = research → K → summary → K → combine", () => {
    const e = residentForecastScore("ensemble", 3);
    expect(e.steps.map((s) => s.id)).toEqual(["research", "f1", "f2", "f3", "combine"]);
    expect(e.steps.filter((s) => s.assignee === "role:forecaster")).toHaveLength(3);
    const d = residentForecastScore("delphi", 2, "marina:crewx");
    expect(d.steps.map((s) => s.id)).toEqual([
      "research",
      "f1",
      "f2",
      "summary",
      "v1",
      "v2",
      "combine",
    ]);
    expect(d.steps.find((s) => s.id === "v2")!.access).toEqual(["summary", "f2"]);
    expect(d.steps.find((s) => s.id === "v1")!.assignee).toBe("marina:crewx");
  });

  const mockedParts = (answers: Record<string, (system: string) => string>, order: string[]) => {
    const { dispatcher, seen } = fakeDispatcher(answers, order);
    detach = attachResidentDispatcher(dispatcher);
    return { seen, part: residentPart as PartFactory };
  };

  it("ensemble: K residents answer through the Score; the combination is the formation's; runs are attributed", async () => {
    const { seen } = mockedParts({ ann: reply(0.8), bob: reply(0.6), cy: reply(0.4) }, [
      "ann",
      "bob",
      "cy",
    ]);
    const steps: string[] = [];
    const a = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "ensemble", k: 3 },
      baseDeps(),
      { calls: 10, timeoutMs: 60_000 },
      { onStep: (ev) => ev.phase === "done" && steps.push(ev.stepId) },
    );
    expect(a.formation.pattern).toBe("ensemble");
    expect(
      a.residents.steps
        .filter((s) => s.status === "done")
        .map((s) => s.step)
        .sort(),
    ).toEqual(["combine", "f1", "f2", "f3", "research"].sort());
    expect(steps[0]).toBe("research");
    expect(steps.at(-1)).toBe("combine");
    expect(a.residents.producers.sort()).toEqual(["ann", "bob", "cy"]);
    expect((a.runs as Array<{ resident?: string }>).map((r) => r.resident).sort()).toEqual([
      "ann",
      "bob",
      "cy",
    ]);
    expect(a.distribution?.Yes).toBeCloseTo(0.6, 2);
    // A past cutoff: every resident turn ran fenced at it.
    expect(a.residents.fence).toBe(PAST);
    expect(seen.every((s) => s.evidenceCutoff === PAST && s.asOf === PAST)).toBe(true);
    // Step 0 is the pipeline's research: every resident saw the dossier.
    expect(seen.every((s) => s.user.includes("a fact"))).toBe(true);
  });

  it("delphi: K → anonymous summary → K revisions; the median of the revisions, revisions attributed", async () => {
    mockedParts({ ann: reply(0.8, 0.7), bob: reply(0.2, 0.4), cy: reply(0.6, 0.6) }, [
      "ann",
      "bob",
      "cy",
    ]);
    const a = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "delphi", k: 3 },
      baseDeps(),
      { calls: 20, timeoutMs: 60_000 },
    );
    expect(a.formation.pattern).toBe("delphi");
    expect(a.formation.revisions).toHaveLength(3);
    expect(a.distribution?.Yes).toBeCloseTo(0.6, 3);
    const byStep = Object.fromEntries(a.residents.steps.map((s) => [s.step, s]));
    expect(byStep.summary!.status).toBe("done");
    for (const id of ["v1", "v2", "v3"]) expect(byStep[id]!.resident).toBeDefined();
    expect(
      (a.formation.revisions as Array<{ resident?: string }>).every(
        (r) => typeof r.resident === "string",
      ),
    ).toBe(true);
  });

  it("matches the plain formation's answer given the same answers (combiners stay pure code)", async () => {
    mockedParts({ ann: reply(0.8, 0.7), bob: reply(0.2, 0.4), cy: reply(0.6, 0.6) }, [
      "ann",
      "bob",
      "cy",
    ]);
    const viaScore = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo }, pattern: "delphi", k: 3 },
      { ...baseDeps(), now: () => new Date() },
      { calls: 20, timeoutMs: 60_000 },
    );
    const plain = await forecastFormed(
      { question: "Will it?", answer: yesNo },
      {
        ...baseDeps(),
        now: () => new Date(),
        analysts: [
          part("a", reply(0.8, 0.7)),
          part("b", reply(0.2, 0.4)),
          part("c", reply(0.6, 0.6)),
        ],
        options: { researchRounds: 1, critique: false, runs: 3 },
      },
      "delphi",
    );
    expect(viaScore.distribution?.Yes).toBeCloseTo(plain.distribution!.Yes!, 6);
    expect(viaScore.formatted).toBe(plain.formatted);
    // A live question (cutoff = now): residents run unfenced.
    expect(viaScore.residents.fence).toBeUndefined();
  });

  it("a measured forecast is fenced even at a live cutoff", async () => {
    const { seen } = mockedParts({ ann: reply(0.7) }, ["ann"]);
    const a = await runResidentForecast(
      {
        forecast: { question: "Will it?", answer: yesNo },
        pattern: "ensemble",
        k: 1,
        measure: true,
      },
      { ...baseDeps(), now: () => new Date() },
      { calls: 4, timeoutMs: 60_000 },
    );
    expect(a.residents.measure).toBe(true);
    expect(a.residents.fence).toBeDefined();
    expect(seen.every((s) => s.evidenceCutoff === a.residents.fence)).toBe(true);
  });

  it("budget: the call cap ends resident work; the forecast still answers from what finished", async () => {
    mockedParts({ ann: reply(0.8), bob: reply(0.6), cy: reply(0.4) }, ["ann", "bob", "cy"]);
    const a = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "ensemble", k: 3 },
      baseDeps(),
      { calls: 1, concurrency: 1, timeoutMs: 60_000 },
    );
    expect(a.residents.budget.attempted).toBe(1);
    expect(a.residents.steps.some((s) => s.status === "error")).toBe(true);
    expect(a.formatted).toBeDefined();
    expect(a.runs.filter((r) => r.weight > 0)).toHaveLength(1);
  });

  it("deadline: each resident call gets what is left of the forecast's wall clock", async () => {
    const { seen } = mockedParts({ ann: reply(0.7) }, ["ann"]);
    await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "ensemble", k: 1 },
      baseDeps(),
      { calls: 4, timeoutMs: 20_000 },
    );
    expect(seen[0]!.deadlineMs).toBeLessThanOrEqual(20_000);
    expect(seen[0]!.deadlineMs).toBeGreaterThan(10_000);
  });

  it("a slow crew past its deadline returns its draft; the Score does not hang", async () => {
    const dispatcher: ResidentDispatcher = {
      ask: async (_spec, request) => ({
        text: reply(0.65)(request.system),
        resident: "lead",
        budgetForced: "deadline",
      }),
    };
    detach = attachResidentDispatcher(dispatcher);
    const a = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "ensemble", k: 2 },
      baseDeps(),
      { calls: 6, timeoutMs: 30_000 },
    );
    expect(a.residents.calls.every((c) => c.budgetForced === "deadline")).toBe(true);
    expect(a.formatted).toBe("Yes");
  });
});

describe("filing and producer credit", () => {
  const TEST_DB = `test_resident_forecast_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    for (const [id, name] of [
      ["u_ann", "ann"],
      ["u_bob", "bob"],
      ["u_asker", "asker"],
    ] as const)
      db.createUser({ id, name });
    db.saveAgentConfig({
      name: "ann",
      model: "vendor/model-a",
      role: "forecaster",
      spawnedBy: "system",
    });
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
    cleanupDb(TEST_DB);
  });

  it("files each resident's run as its own answer, tagged q:/method:/model:/resident:, and credits it on resolution", async () => {
    const { dispatcher } = fakeDispatcher({ ann: reply(0.9), bob: reply(0.2) }, ["ann", "bob"]);
    detach = attachResidentDispatcher(dispatcher);
    const a = await runResidentForecast(
      { forecast: { question: "Will it?", answer: yesNo, asOf: PAST }, pattern: "ensemble", k: 2 },
      baseDeps(),
      { calls: 6, timeoutMs: 60_000 },
    );
    const ids = fileResidentRuns(db, a, { parentId: 7, questionId: "q-77" });
    expect(ids).toHaveLength(2);
    const rows = ids.map((id) => db.getForecastAnswer(id)!);
    expect(rows.map((r) => r.entity_name).sort()).toEqual(["ann", "bob"]);
    // A live run carries no eval mode (any eval mode never earns standing).
    expect(rows.every((r) => r.source === "forecast-resident" && !r.eval_mode)).toBe(true);
    const annRow = rows.find((r) => r.entity_name === "ann")!;
    expect(routingRefs(annRow.answer_json)).toEqual([
      "method:residents-ensemble",
      "q:q-77",
      "model:vendor/model-a",
      "resident:ann",
    ]);
    expect(JSON.parse(annRow.answer_json).parent).toBe(7);
    // Filing twice keeps the first rows.
    expect(fileResidentRuns(db, a, { parentId: 7, questionId: "q-77" })).toEqual(ids);
    // Resolution credits the resident whose run scored, independently resolved.
    resolveForecast(db, annRow.id, { option: "Yes" }, Date.now());
    const credits = ledgerFor(db, "u_ann").filter((r) => r.kind === "forecast_resolved");
    expect(credits.length).toBe(1);
    expect(credits[0]!.amount).toBeGreaterThan(0);
    const outcome = db.getOutcomeBySubject(`forecast:${annRow.id}`)!;
    const refs = JSON.parse(outcome.refs_json!) as string[];
    expect(refs).toEqual(
      expect.arrayContaining(["q:q-77", "method:residents-ensemble", "resident:ann"]),
    );
  });

  it("a measured forecast's resident rows never earn standing", async () => {
    const { dispatcher } = fakeDispatcher({ ann: reply(0.9) }, ["ann"]);
    detach = attachResidentDispatcher(dispatcher);
    const a = await runResidentForecast(
      {
        forecast: { question: "Will it?", answer: yesNo, asOf: PAST },
        pattern: "ensemble",
        k: 1,
        measure: true,
      },
      baseDeps(),
      { calls: 4, timeoutMs: 60_000 },
    );
    const [id] = fileResidentRuns(db, a, { questionId: "q-m" });
    expect(db.getForecastAnswer(id!)!.eval_mode).toBe("measure");
    resolveForecast(db, id!, { option: "Yes" }, Date.now());
    expect(ledgerFor(db, "u_ann").filter((r) => r.kind === "forecast_resolved")).toHaveLength(0);
  });

  it("forecastAsTask: a task (value 0) is created, run, filed and closed", async () => {
    const { dispatcher } = fakeDispatcher({ ann: reply(0.9), bob: reply(0.7) }, ["ann", "bob"]);
    detach = attachResidentDispatcher(dispatcher);
    const made = await forecastAsTask(
      {
        request: {
          forecast: { question: "Will it?", answer: yesNo, asOf: PAST },
          pattern: "ensemble",
          k: 2,
        },
        filer: { id: "u_asker", name: "asker" },
      },
      {
        db,
        env: { MARINA_FORECAST_RESIDENTS: "on" },
        typed: { deps: baseDeps(), costUsd: () => 0.5 },
      },
    );
    if ("error" in made) throw new Error(made.error);
    const task = db.getTask(made.taskId!)!;
    expect(task.status).toBe("completed");
    expect(task.standing).toBe(0);
    expect(JSON.parse(task.description!)).toMatchObject({
      kind: "forecast",
      pattern: "ensemble",
      eval_mode: "live",
    });
    const combined = db.getForecastAnswer(made.answerId!)!;
    expect(combined).toMatchObject({ entity_name: "asker", external_id: `task:${made.taskId}` });
    expect(combined.eval_mode).toBeFalsy();
    expect(made.residentAnswerIds).toHaveLength(2);
    expect(made.answer.costUsd).toBeCloseTo(0.52, 6);
  });

  it("forecastAsTask is refused while MARINA_FORECAST_RESIDENTS is off", async () => {
    const made = await forecastAsTask(
      {
        request: { forecast: { question: "Will it?", answer: yesNo }, pattern: "ensemble" },
        filer: { id: "u_asker", name: "asker" },
      },
      { db, env: {}, typed: { deps: baseDeps(), costUsd: () => 0 } },
    );
    expect(made).toEqual({ error: expect.stringContaining("MARINA_FORECAST_RESIDENTS=on") });
    expect(db.listTasks({})).toHaveLength(0);
  });
});

describe("off: byte-identical", () => {
  it("modelPart keeps marina: on its plain HTTP path (no fence, no deadline header) and role: is not a resident", async () => {
    const original = globalThis.fetch;
    const bodies: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      bodies.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as unknown as typeof fetch;
    try {
      const env = { MARINA_FORECAST_MARINA_URL: "http://m.test" };
      const p = modelPart("marina:crewx", env);
      expect(isResidentPart(p)).toBe(false);
      expect(await p.complete("sys", "user")).toBe("ok");
      expect(bodies[0]!.url).toBe("http://m.test/v1/chat/completions");
      expect(bodies[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
      expect(bodies[0]!.init.body).toBe(
        JSON.stringify({
          model: "marina:crewx",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "user" },
          ],
        }),
      );
      let roleIsResident = false;
      try {
        roleIsResident = isResidentPart(modelPart("role:forecaster", env));
      } catch {
        roleIsResident = false;
      }
      expect(roleIsResident).toBe(false);
      // On, the same spec is a resident part.
      expect(
        isResidentPart(modelPart("marina:crewx", { ...env, MARINA_FORECAST_RESIDENTS: "on" })),
      ).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("plain parts: no fence is ever set, even for a past cutoff, and prompts are unchanged", async () => {
    const seen: Array<{ s: string; u: string; asOf?: string }> = [];
    const spy = (name: string) =>
      part(name, (s, u) => {
        seen.push({ s, u, ...(currentEvidenceCutoff() ? { asOf: currentEvidenceCutoff() } : {}) });
        return reply(0.6)(s);
      });
    const deps = {
      ...baseDeps(),
      analysts: [spy("m1"), spy("m2")],
      options: { researchRounds: 1, runs: 2 },
    };
    const req = { question: "Will it?", answer: yesNo, asOf: PAST };
    expect(fencedForResidents(req, deps, async () => 1)).toBeUndefined();
    const a1 = await forecastTyped(req, deps);
    const first = seen.splice(0);
    const a2 = await forecastTyped(req, deps);
    expect(seen.every((x) => x.asOf === undefined)).toBe(true);
    expect(first.map((x) => x.s + x.u)).toEqual(seen.map((x) => x.s + x.u));
    expect(a1.formatted).toBe(a2.formatted);
  });

  it("the fence applies only to a cutoff in the past by the real clock", () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(residentFenceAt("2026-06-01T00:00:00Z", now)).toBe("2026-06-01T00:00:00Z");
    expect(residentFenceAt("2026-10-20T00:00:00Z", now)).toBeUndefined();
  });

  it("the forecast command does not parse resident modifiers while off", async () => {
    const { forecastModifierSpec, residentRequest } = await import(
      "../src/engine/commands/forecast"
    );
    const { parseModifiers } = await import("../src/engine/parse-input");
    const tokens = "Will it rain crew:crewx pattern:delphi".split(" ");
    const off = parseModifiers(tokens, forecastModifierSpec({}));
    // Off: the whole input is the question, as before this change.
    expect(off.rest.join(" ")).toBe("Will it rain crew:crewx pattern:delphi");
    expect(Object.keys(forecastModifierSpec({})).sort()).toEqual(
      ["ends", "options", "resolves", "size", "type"].sort(),
    );
    const on = parseModifiers(tokens, forecastModifierSpec({ MARINA_FORECAST_RESIDENTS: "on" }));
    expect(on.rest.join(" ")).toBe("Will it rain");
    expect(residentRequest(on.values)).toMatchObject({
      assignee: "marina:crewx",
      pattern: "delphi",
    });
    expect(residentRequest({ pattern: "tournament" })).toEqual({
      error: expect.stringContaining("ensemble or delphi"),
    });
  });
});
