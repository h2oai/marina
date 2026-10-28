// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestration surfaces on the one outcome path (`src/outcomes/orchestration.ts`):
 * a person's project verdict, a pattern run's own review verdict, a room
 * formation round's mechanical result — and the read-only views beside them:
 * arena challenger pooling (`challengerPoolKey`) and `benchmark eligible`.
 * Everything here runs with no model provider configured.
 */

import { describe, expect, it } from "bun:test";
import {
  challengerPoolKey,
  chooseArenaRoute,
  pooledVariants,
  type RouteEvidence,
} from "../src/arena/earned-routes";
import { sliceHash } from "../src/engine/benchmark-ledger";
import { eligiblePromotions, fileSlotPromotion } from "../src/engine/benchmark-promotion";
import { renderEligible } from "../src/engine/commands/benchmark";
import { patternCommand } from "../src/engine/commands/pattern";
import { setRank } from "../src/engine/permissions";
import { SpendGuard } from "../src/engine/spend-guard";
import { arenaRouteRows } from "../src/forecast/route-view";
import { runTextPattern, type TextComplete } from "../src/orchestration/text-patterns";
import { patternRunVerdict, recordPatternRun } from "../src/outcomes/orchestration";
import type { MarinaDB } from "../src/persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

const refsOf = (row: { refs_json: string | null } | undefined): string[] =>
  row?.refs_json ? (JSON.parse(row.refs_json) as string[]) : [];

// ─── 1. project outcome ─────────────────────────────────────────────────────

describe("project outcome → outcome row", () => {
  it("a person's verdict records one task outcome tagged with the project's pattern, with no provider", async () => {
    using _s = scopeProcessState({ env: noProviderEnv() });
    const f = createTestEngine();
    try {
      const jo = f.login("Jo");
      setRank(f.engine.entities.get(jo.entityId as EntityId)!, 9);
      const send = async (cmd: string) => {
        await f.engine.processCommand(jo.entityId, cmd);
        return stripAnsi(jo.connection.lastText());
      };
      await send("project create Alpha | grid patterns");
      expect(await send("project Alpha orchestrate deliberation")).toContain("deliberation");
      expect(
        await send("project Alpha outcome 0.8 | the plan held up; secret detail here"),
      ).toContain("Recorded outcome 0.80");
      const project = f.db.getProjectByName("Alpha")!;
      const row = f.db.getOutcomeBySubject(`project:${project.id}`);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        kind: "task",
        source: "project:outcome",
        basis: "mechanical",
        metric: "person-verdict",
        succeeded: 1,
        quality: 0.8,
        owner: "Jo",
      });
      const refs = refsOf(row);
      expect(refs).toContain("family:work:project");
      expect(refs).toContain("method:orchestration:deliberation");
      expect(refs.some((r) => r.startsWith("scope:"))).toBe(true);
      // Labels only: the evidence a person wrote never reaches the outcome row.
      expect(JSON.stringify(row)).not.toContain("secret detail");
    } finally {
      await f.dispose();
    }
  });
});

// ─── 2. pattern run ─────────────────────────────────────────────────────────

/** A fake model whose reviewer answers `review` (approve by default). */
function fake(review = '{"verdict":"approve","issues":""}'): TextComplete {
  return async (model, system) => {
    if (system.includes("You review a DRAFT")) return { text: review, costUsd: 0 };
    if (/"pick"/.test(system)) return { text: '{"pick":1,"reason":"ok"}', costUsd: 0 };
    return { text: `answer from ${model}`, costUsd: 0 };
  };
}

const runPattern = (pattern: "verification" | "ensemble", complete: TextComplete) =>
  runTextPattern(pattern, "Name the capital of France.", ["m/a", "m/b"], {
    complete,
    checker: "m/judge",
    budget: new SpendGuard({ label: "pattern budget", daily: false }),
  });

describe("pattern run → outcome", () => {
  it("records the run's own review verdict as a judged request outcome", async () => {
    const f = createTestEngine();
    try {
      const approved = await runPattern("verification", fake());
      expect(patternRunVerdict(approved)).toEqual({ approved: true, judge: "m/judge" });
      recordPatternRun(f.db, { result: approved, runId: "r1", owner: "Jo" });
      const row = f.db.getOutcomeBySubject("judged:pattern:r1");
      expect(row).toMatchObject({
        kind: "request",
        source: "pattern:verification",
        basis: "judged",
        judge: "pattern-review:m/judge",
        succeeded: 1,
      });
      const refs = refsOf(row);
      expect(refs).toContain("family:work:request");
      expect(refs).toContain("method:pattern:verification");
      // One model drafted it.
      expect(refs).toContain("method:model:m/a");

      const revised = await runPattern(
        "verification",
        fake('{"verdict":"revise","issues":"cite a source"}'),
      );
      recordPatternRun(f.db, { result: revised, runId: "r2" });
      const sent = f.db.getOutcomeBySubject("judged:pattern:r2");
      expect(sent?.succeeded).toBe(0);
      expect(refsOf(sent)).toContain("scope:unscoped");
      expect(JSON.stringify(sent)).not.toContain("cite a source");
    } finally {
      await f.dispose();
    }
  });

  it("records nothing when the run has no verdict of its own", async () => {
    const f = createTestEngine();
    try {
      const picked = await runPattern("ensemble", fake());
      expect(patternRunVerdict(picked)).toBeUndefined();
      expect(recordPatternRun(f.db, { result: picked, runId: "r3" })).toBeUndefined();
      const unreadable = await runPattern("verification", fake("looks fine to me"));
      expect(patternRunVerdict(unreadable)).toBeUndefined();
      expect(f.db.listOutcomes({ kind: "request" })).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  });

  it("`pattern run` records through the command, owned by the caller", async () => {
    using _s = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "off" } });
    const f = createTestEngine();
    try {
      const cmd: CommandDef = patternCommand({
        members: () => ["m/a"],
        complete: () => fake(),
        db: () => f.db as MarinaDB,
        nameOf: () => "Jo",
      });
      const out: string[] = [];
      const ctx = {
        send: (_e: EntityId, m: string) => out.push(stripAnsi(m)),
      } as unknown as RoomContext;
      const args = "run verification -- Name the capital";
      await cmd.handler(ctx, {
        entity: "e_1" as EntityId,
        verb: "pattern",
        args,
        tokens: args.split(/\s+/),
        raw: `pattern ${args}`,
      } as never);
      const rows = f.db.listOutcomes({ kind: "request" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner).toBe("Jo");
      expect(refsOf(rows[0])).toContain("method:pattern:verification");
    } finally {
      await f.dispose();
    }
  });
});

// ─── 3. room formation ──────────────────────────────────────────────────────

describe("room formation round → outcome", () => {
  it("a verification round closing records its checkers' verdicts; a debate records nothing", async () => {
    using _s = scopeProcessState({ env: noProviderEnv() });
    const f = createTestEngine({ room: { formation: "verification" } });
    try {
      const bea = f.login("Bea");
      const ash = f.login("Ash");
      const cy = f.login("Cy");
      await f.engine.processCommand(bea.entityId, "say draft: the bridge holds 40 t");
      await f.engine.processCommand(ash.entityId, "say aspect: correctness pass — sums check");
      await f.engine.processCommand(cy.entityId, "say aspect: safety fail — no margin");
      expect(f.db.listOutcomes({ kind: "request" })).toHaveLength(0);
      await f.engine.processCommand(bea.entityId, "say fixed: 40 t with a 1.5 margin");
      const rows = f.db.listOutcomes({ kind: "request" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "room-formation:verification",
        basis: "mechanical",
        metric: "aspect-checks",
        owner: "Bea",
        succeeded: 0,
        quality: 0.5,
      });
      expect(refsOf(rows[0])).toContain("method:room-formation:verification");
      expect(JSON.stringify(rows[0])).not.toContain("bridge");
    } finally {
      await f.dispose();
    }

    const d = createTestEngine({ room: { formation: "debate" } });
    try {
      const [a, b, c] = [d.login("Ash"), d.login("Bea"), d.login("Cy")];
      await d.engine.processCommand(a.entityId, "say tabs");
      await d.engine.processCommand(b.entityId, "say spaces");
      await d.engine.processCommand(c.entityId, "say aspect: x pass — spaces win");
      expect(d.db.listOutcomes({ kind: "request" })).toHaveLength(0);
    } finally {
      await d.dispose();
    }
  });
});

// ─── 4. arena challenger pooling ────────────────────────────────────────────

describe("arena challenger pooling", () => {
  const FAMILY = "aaii";
  const ev = (
    roundId: string,
    spec: string,
    skill: number,
    extra: Partial<RouteEvidence> = {},
  ): RouteEvidence => ({
    roundId,
    family: FAMILY,
    source: "shadow",
    spec,
    skill,
    visibleAt: 0,
    ...extra,
  });

  it("pools a spec's settings variants and nothing else", () => {
    expect(challengerPoolKey("nowcast#0123456789abcdef")).toBe("nowcast");
    expect(challengerPoolKey("formation:delphi:openrouter/v/a,openrouter/v/b")).toBe(
      "formation:delphi:openrouter/v/a,openrouter/v/b",
    );
  });

  it("variants pool into one per-round score (the last recorded); panels of one kind never pool; promotion stays per spec", () => {
    const evidence: RouteEvidence[] = [];
    for (let i = 0; i < 10; i++) {
      const round = `r${i}`;
      evidence.push(ev(round, "baseline", 0, { source: "filed" }));
      // Seven settings variants of the nowcast; only the latest of each round counts.
      for (let v = 0; v < 7; v++)
        evidence.push(
          ev(round, "nowcast", v === 6 ? 0.2 : -1, {
            variant: `nowcast#${String(v).padStart(16, "0")}`,
            recordedAt: 100 + v,
          }),
        );
      evidence.push(ev(round, "formation:delphi:openrouter/v/a,openrouter/v/b", 0.3));
      evidence.push(ev(round, "formation:delphi:openrouter/v/c,openrouter/v/d", -0.5));
    }
    const decision = chooseArenaRoute({
      family: FAMILY,
      defaultSpec: "baseline",
      evidence,
      now: 1,
      mode: "on",
      minN: 8,
    });
    const nowcast = decision.challengers.find((c) => c.id === "nowcast");
    // Pooled: ten rounds, not ten per fingerprint split seven ways.
    expect(nowcast?.n).toBe(10);
    expect(nowcast?.gain).toBeCloseTo(0.2, 6);
    // Different panels of one kind stay separate challengers.
    expect(decision.challengers.map((c) => c.id).sort()).toEqual([
      "formation:delphi:openrouter/v/a,openrouter/v/b",
      "formation:delphi:openrouter/v/c,openrouter/v/d",
      "nowcast",
    ]);
    // What routing would run is always a runnable spec, never a fingerprint.
    expect(decision.picked.includes("#")).toBe(false);
    expect(["formation:delphi:openrouter/v/a,openrouter/v/b", "nowcast", "baseline"]).toContain(
      decision.picked,
    );

    expect(pooledVariants({ family: FAMILY, evidence, now: 1 }).get("nowcast")).toBe(7);
    const rows = arenaRouteRows({ evidence, defaultFor: () => "baseline", minN: 8, now: 1 });
    expect(rows.find((r) => r.method === "nowcast")?.variants).toBe(7);
    expect(
      rows.find((r) => r.method === "formation:delphi:openrouter/v/a,openrouter/v/b")?.variants,
    ).toBeUndefined();
  });
});

// ─── 5. benchmark eligible ──────────────────────────────────────────────────

const SLOT = "crew:answerer:formation";
const IDS = Array.from({ length: 200 }, (_, i) => `item-${i}`);

function recordRun(db: MarinaDB, id: string, group: string, correct: (i: number) => boolean) {
  const items = IDS.map((item_id, i) => ({
    item_id,
    correct: correct(i),
    score: null,
    latency_ms: null,
    cost_usd: 0.01,
    trace_id: null,
    participants_json: null,
    judge_verdict: null,
  }));
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: "synthetic",
      config_hash: id,
      config_json: "{}",
      agent_id: null,
      started_at: 0,
      completed_at: 1,
      duration_ms: 1,
      score: items.filter((x) => x.correct).length / items.length,
      answered: items.length,
      total: items.length,
      cost_usd: 2,
      n: items.length,
      ci_low: 0,
      ci_high: 1,
      seed: 1,
      slice_hash: sliceHash(IDS),
      judge: "judge/model",
      target_kind: "model",
      target_json: JSON.stringify({ model: `model-${group}` }),
      label: id,
      source: "import",
      content_hash: null,
      replicate_group: group,
    },
    items,
  );
}

describe("benchmark eligible", () => {
  it("lists the configuration that would earn the slot and not the one that would not; files nothing", async () => {
    const f = createTestEngine();
    try {
      const db = f.db;
      recordRun(db, "base", "base", (i) => i % 5 < 2);
      recordRun(db, "base-r2", "base", (i) => i % 5 < 2);
      recordRun(db, "strong", "strong", (i) => i % 5 < 4);
      recordRun(db, "strong-r2", "strong", (i) => i % 5 < 4);
      recordRun(db, "twin", "twin", (i) => i % 5 < 2);
      recordRun(db, "twin-r2", "twin", (i) => i % 5 < 2);
      const seeded = fileSlotPromotion(db, {
        slot: SLOT,
        runId: "base",
        actor: { key: "operator", keyOf: (id) => id },
      });
      expect(seeded.kind).toBe("seeded");
      const before = db.listBenchmarkPromotions(SLOT).length;

      const rows = eligiblePromotions(db);
      const byGroup = new Map(rows.map((r) => [r.group, r]));
      expect(byGroup.get("strong")?.eligible).toBe(true);
      expect(byGroup.get("strong")?.peers).toBe(1);
      expect(byGroup.get("twin")?.eligible).toBe(false);
      expect(byGroup.get("twin")?.reasons[0]).toContain("does not pass");
      expect(byGroup.has("base")).toBe(false);
      expect(eligiblePromotions(db, { board: "other" })).toHaveLength(0);

      const text = stripAnsi(renderEligible(db, "synthetic"));
      expect(text).toContain("Eligible to promote (1 of 2)");
      expect(text).toContain(`benchmark promote ${SLOT} strong`);
      // Read-only: nothing filed, no attempt recorded.
      expect(db.listBenchmarkPromotions(SLOT)).toHaveLength(before);
    } finally {
      await f.dispose();
    }
  });
});
