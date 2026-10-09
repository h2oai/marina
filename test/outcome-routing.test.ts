// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  applyRouteEvidence,
  liveEvidenceEntries,
  type RouteEvidenceSettings,
  routeEvidenceSettingsFromEnv,
} from "../src/engine/benchmark-evidence";
import { handleOutcomeReport } from "../src/net/outcomes-api";
import { recordTaskVerdict } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";

describe("live evidence in model routing", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    db.saveAgentConfig({
      name: "Good",
      model: "vendor/strong",
      role: "coder",
      spawnedBy: "system",
    });
    db.saveAgentConfig({ name: "Weak", model: "vendor/cheap", role: "coder", spawnedBy: "system" });
    for (let i = 0; i < 12; i++) {
      recordTaskVerdict(db, { taskId: i, claimant: "Good", approved: true, at: i });
      recordTaskVerdict(db, { taskId: 100 + i, claimant: "Weak", approved: i < 3, at: i });
    }
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const candidates = [
    { route: "cheap", model: "vendor/cheap" },
    { route: "strong", model: "vendor/strong" },
  ];
  const settings = (over: Partial<RouteEvidenceSettings>): RouteEvidenceSettings => ({
    ...routeEvidenceSettingsFromEnv({}),
    minN: 10,
    ...over,
  });

  it("is off by default, and on it picks the model that gets more done", () => {
    expect(routeEvidenceSettingsFromEnv({}).live).toBe(false);
    expect(routeEvidenceSettingsFromEnv({ MARINA_ROUTE_EVIDENCE_LIVE: "on" }).live).toBe(true);
    const routed = { route: "cheap", model: "vendor/cheap" };
    const off = applyRouteEvidence(routed, candidates, "coder", settings({ mode: "on" }), db);
    expect(off).toMatchObject({
      route: "cheap",
      applied: false,
      signals: { evidence: "no_family" },
    });
    const on = applyRouteEvidence(
      routed,
      candidates,
      "coder",
      settings({ mode: "on", live: true }),
      db,
    );
    expect(on).toMatchObject({ route: "strong", applied: true });
    expect(on.signals).toMatchObject({ evidence_live: 24, evidence_level: "role" });
    const observed = applyRouteEvidence(
      routed,
      candidates,
      "coder",
      settings({ mode: "observe", live: true }),
      db,
    );
    expect(observed).toMatchObject({ route: "cheap", applied: false });
    expect(observed.signals.evidence).toBe("observed");
  });

  it("live entries: per role and pooled per model, families live:<source>", () => {
    const live = liveEvidenceEntries(db, "coder");
    expect(live.role.map((e) => [e.family, e.name, e.n, e.correct])).toEqual(
      expect.arrayContaining([
        ["live:task:verdict", "vendor/strong", 12, 12],
        ["live:task:verdict", "vendor/cheap", 12, 3],
      ]),
    );
    expect(liveEvidenceEntries(db, "planner").role).toEqual([]);
    expect(liveEvidenceEntries(db, undefined).model).toHaveLength(2);
  });
});

describe("POST /v1/outcomes", () => {
  let db: MarinaDB;
  const engine = () =>
    ({
      db,
      entities: { all: () => [{ id: "e_ada", name: "ada" }] },
    }) as never;
  const post = (body: unknown, headers: Record<string, string> = {}, owner = "ada") =>
    handleOutcomeReport(
      new Request("http://x/v1/outcomes", {
        method: "POST",
        body: JSON.stringify(body),
        headers,
      }),
      engine(),
      owner ? { boundEntityName: owner } : undefined,
    );
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    const base = {
      type: "model_request_lifecycle",
      requestId: "req-1",
      traceId: "req-1",
      model: "assistant",
      timestamp: 1,
    };
    db.logEvent({ ...base, phase: "received", entityId: "e_ada" } as EngineEvent);
    db.logEvent({
      ...base,
      phase: "routed",
      target: "openrouter/vendor/strong",
      entityId: "e_ada",
    } as EngineEvent);
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  it("records the caller's report once, with the model that served it, as evidence only", async () => {
    const res = await post({
      requestId: "req-1",
      succeeded: true,
      quality: 0.8,
      detail: "tests pass",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      subject: "request:req-1",
      model: "openrouter/vendor/strong",
    });
    const o = db.getOutcomeBySubject("request:req-1")!;
    expect(o).toMatchObject({
      kind: "request",
      owner: "ada",
      succeeded: 1,
      quality: 0.8,
      basis: "mechanical",
    });
    expect(JSON.parse(o.participants_json!)).toEqual([{ model: "openrouter/vendor/strong" }]);
    expect(db.outcomeDeliveries(o.id)).toEqual([]);
    expect((await post({ requestId: "req-1", succeeded: false })).status).toBe(409);
  });

  it("refuses unbound keys, someone else's request, unknown ids and bad bodies", async () => {
    expect((await post({ requestId: "req-1", succeeded: true }, {}, "")).status).toBe(403);
    expect((await post({ requestId: "req-1", succeeded: true }, {}, "bo")).status).toBe(404);
    expect((await post({ requestId: "nope", succeeded: true })).status).toBe(404);
    expect((await post({ requestId: "req-1", succeeded: "yes" })).status).toBe(400);
    expect((await post({ requestId: "req-1", succeeded: true, quality: 2 })).status).toBe(400);
    expect(db.listOutcomes()).toHaveLength(0);
  });

  it("a measurement report is recorded as measurement", async () => {
    await post(
      { requestId: "req-1", succeeded: true },
      { "x-marina-eval": "benchmark=tau2; mode=measure" },
    );
    expect(db.getOutcomeBySubject("request:req-1")!.eval_mode).toBe("measure");
  });
});
