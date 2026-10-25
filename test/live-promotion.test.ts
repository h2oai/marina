// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live work changes a default by earned promotion: shared outcomes tagged by
 * role and model are judged on a time-split holdout, a passing candidate
 * raises one ops-inbox proposal, and only a PERSON holding role.edit files
 * it (`fileSlotPromotion`); `roleModel` then reads the promoted slot between
 * env and tier.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  crewModelFromEnv,
  MODEL_ROLES,
  type ModelRole,
  residentDefaultModel,
  roleModel,
  setRoleModelSlots,
} from "../src/config/model-tiers";
import { fileSlotPromotion } from "../src/engine/benchmark-promotion";
import { type DefaultResolution, onDefaultResolved } from "../src/engine/default-resolution";
import {
  evaluateLiveSlots,
  LIVE_PROMOTION_MIN_PER_ARM,
  liveProposalKey,
  runLivePromotionPass,
} from "../src/engine/live-promotion";
import { grant } from "../src/engine/safety-gates";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const A = "vendor/strong-a";
const B = "marina/cheap"; // what an agent with no model runs on: the incumbent
const SLOT = "role-model:coder";
/** A provider key, assembled at runtime (never a secret-shaped literal). */
const FAKE_KEY = ["test", "only", "key"].join("-");

const CLEAN_ENV: Record<string, string | undefined> = {
  OPENROUTER_API_KEY: FAKE_KEY,
  MARINA_DEFAULT_MODEL: undefined,
  MARINA_AGENT_MODELS: undefined,
  MARINA_MODEL_TIER_CHEAP: undefined,
  MARINA_MODEL_TIER_STRONG: undefined,
  MARINA_CREW_MODEL: undefined,
  MARINA_WORKBENCH_MODEL: undefined,
};

describe("live-evidence promotion", () => {
  let state: DisposableStack;
  let world: ReturnType<typeof createTestEngine>;
  let subject = 0;

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: CLEAN_ENV });
    world = createTestEngine();
  });
  afterEach(async () => {
    setRoleModelSlots(undefined);
    await world.dispose();
    state.dispose();
  });

  /**
   * `perArm` outcomes for each of two models, interleaved in time so the
   * newer half (holdout) holds half of each. `wins(model, i, split)` decides.
   */
  function seed(
    role: string,
    models: [string, string],
    perArm: number,
    wins: (model: string, i: number, split: "discovery" | "holdout") => boolean,
    scope = "scope:shared",
  ) {
    for (let i = 0; i < perArm; i++) {
      for (const [k, model] of models.entries()) {
        const split = i < perArm / 2 ? "discovery" : "holdout";
        subject++;
        world.db.recordOutcomeRow(
          {
            subject: `task:${subject}`,
            kind: "task",
            source: "task:verdict",
            domain: "tools",
            owner: model === models[0] ? "Worker1" : "Worker2",
            succeeded: wins(model, i, split),
            quality: wins(model, i, split) ? 1 : 0,
            basis: "mechanical",
            refs: [
              "family:work:task",
              `family:work:task:role:${role}`,
              `method:model:${model}`,
              scope,
            ],
            resolvedAt: 1_000_000 + (i * 2 + k) * 1000,
          },
          [],
        );
      }
    }
  }

  /** A clearly better A on both splits: 90 % vs 30 %. */
  const clearWin = (model: string, i: number) => (model === A ? i % 10 !== 0 : i % 10 < 3);

  function login(name: string) {
    const { connection, entityId } = world.login(name);
    const send = async (cmd: string) => {
      connection.clear();
      await world.engine.processCommand(entityId, cmd);
      return stripAnsi(connection.allTextJoined());
    };
    return { entityId, send };
  }

  it("raises one proposal; a person with role.edit files it; the role's model becomes A", async () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const report = evaluateLiveSlots(db);
    const c = report.find((r) => r.slot === SLOT)!.candidates.find((x) => x.candidate === A)!;
    expect(c.incumbent).toBe(B);
    expect(c.status).toBe("eligible");
    expect(c.ci[0]).toBeGreaterThan(0);

    // The pass raises ONE proposal and files nothing.
    expect(runLivePromotionPass(db)).toMatchObject({ proposed: 1, refused: 0 });
    expect(db.listBenchmarkDefaults()).toHaveLength(0);
    expect(residentDefaultModel(db, process.env, "coder")).toBe(B);
    const key = liveProposalKey(SLOT, B, A);
    const alert = db.listOperationalAlerts("open").find((a) => a.alert_key === key)!;
    expect(alert.attention_kind).toBe("approval");
    expect(alert.title).toContain(`promote ${SLOT} → ${A}`);
    // Not re-raised.
    expect(runLivePromotionPass(db).proposed).toBe(0);
    expect(db.listOperationalAlerts().filter((a) => a.alert_key === key)[0]!.occurrences).toBe(1);

    // The read view shows it, and records nothing.
    const viewer = login("Viewer");
    const view = await viewer.send("benchmark eligible live");
    expect(view).toContain(SLOT);
    expect(view).toContain("PROPOSED");
    expect(db.listBenchmarkPromotions(SLOT)).toHaveLength(0);

    // Without role.edit: held as a challenge, nothing filed.
    expect(await viewer.send(`benchmark promote ${SLOT} ${A}`)).toContain("held: challenge");
    expect(db.listBenchmarkDefaults()).toHaveLength(0);

    // A person holding role.edit files it.
    const alice = login("Alice");
    grant(db, alice.entityId, "role.edit");
    expect(await alice.send(`benchmark promote ${SLOT} ${A}`)).toContain(
      `Promoted ${A} to ${SLOT}`,
    );
    const history = db.listBenchmarkPromotions(SLOT);
    expect(history.map((h) => h.outcome)).toEqual(["promoted"]);
    expect(history[0]!.challenger_run_id).toBe(`live:${A}`);
    expect(JSON.parse(history[0]!.stats_json!)).toMatchObject({ basis: "live", split: "holdout" });
    expect(db.listOperationalAlerts().find((a) => a.alert_key === key)!.status).toBe("resolved");

    // The role's model is now A, read through resolveDefault; other roles keep the tier.
    expect(residentDefaultModel(db, process.env, "coder")).toBe(A);
    expect(roleModel("resident", { slots: db, workRole: "coder" }).source).toBe(`promoted ${SLOT}`);
    expect(residentDefaultModel(db, process.env, "scholar")).toBe(B);
    // The new incumbent is A: A is no longer a candidate.
    const after = evaluateLiveSlots(db).find((r) => r.slot === SLOT)!;
    expect(after.incumbent.model).toBe(A);
    expect(after.layer).toBe("promoted");
  });

  it("a model role (crew) reads its promoted slot through roleModel and the registered ledger", () => {
    const { db } = world;
    seed("crew", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const c = evaluateLiveSlots(db, { role: "crew" })[0]!.candidates[0]!;
    expect(c.status).toBe("eligible");
    const filed = fileSlotPromotion(db, {
      slot: "role-model:crew",
      live: c,
      actor: { key: "person-key", keyOf: (id) => id },
    });
    expect(filed.kind).toBe("promoted");
    expect(roleModel("crew", { slots: db }).model).toBe(A);
    // Env-only call sites read the registered world ledger.
    expect(crewModelFromEnv()).toBe(B);
    setRoleModelSlots(db);
    expect(crewModelFromEnv()).toBe(A);
    // The role's own knob still wins.
    expect(crewModelFromEnv({ ...process.env, MARINA_CREW_MODEL: "pinned/model" })).toBe(
      "pinned/model",
    );
    // So does a role: override.
    expect(
      roleModel("crew", { env: { ...process.env, MARINA_AGENT_MODELS: "role:crew=x/y" } }).model,
    ).toBe("x/y");
  });

  it("env settings win over a promotion, and the pass raises nothing while env sets the role", async () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const env = { ...process.env, MARINA_DEFAULT_MODEL: "operator/choice" };
    const c = evaluateLiveSlots(db, { env }).find((r) => r.slot === SLOT)!;
    expect(c.layer).toBe("env");
    // The incumbent is the env model; neither seeded model is it, so both are
    // candidates, and none may be proposed.
    expect(c.candidates.every((x) => x.status !== "eligible")).toBe(true);
    expect(runLivePromotionPass(db, { env }).proposed).toBe(0);

    const filed = fileSlotPromotion(db, {
      slot: SLOT,
      live: evaluateLiveSlots(db).find((r) => r.slot === SLOT)!.candidates[0]!,
      actor: { key: "person-key", keyOf: (id) => id },
    });
    expect(filed.kind).toBe("promoted");
    expect(residentDefaultModel(db, env, "coder")).toBe("operator/choice");
    expect(residentDefaultModel(db, process.env, "coder")).toBe(A);
  });

  it("a promoted model this installation cannot call falls back to the tier, traced", () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const c = evaluateLiveSlots(db).find((r) => r.slot === SLOT)!.candidates[0]!;
    fileSlotPromotion(db, { slot: SLOT, live: c, actor: { key: "p", keyOf: (id) => id } });
    const traces: DefaultResolution<unknown>[] = [];
    const off = onDefaultResolved((r) => traces.push(r));
    try {
      const noKeys = { ...process.env, OPENROUTER_API_KEY: undefined };
      expect(residentDefaultModel(db, noKeys, "coder")).toBe(B);
      const t = traces.find((r) => r.slot === SLOT)!;
      expect(t.source).toBe("builtin");
      expect(t.consulted.find((x) => x.key === SLOT)?.outcome).toBe("unreadable");
    } finally {
      off();
    }
  });

  it("too little data: nothing is raised or recorded", () => {
    const { db } = world;
    seed("coder", [A, B], LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const c = evaluateLiveSlots(db).find((r) => r.slot === SLOT)!.candidates[0]!;
    expect(c.status).toBe("too-little-data");
    expect(runLivePromotionPass(db)).toMatchObject({ proposed: 0, refused: 0 });
    expect(db.listBenchmarkPromotions(SLOT)).toHaveLength(0);
    expect(db.listOperationalAlerts().filter((a) => a.category === "promotion")).toHaveLength(0);
  });

  it("a discovery loss is refused and recorded once per evidence state; it raises the bar", () => {
    const { db } = world;
    // A wins the holdout clearly but loses discovery.
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, (model, i, split) =>
      split === "holdout" ? clearWin(model, i) : model === A ? i % 10 < 3 : i % 10 < 6,
    );
    const c = evaluateLiveSlots(db).find((r) => r.slot === SLOT)!.candidates[0]!;
    expect(c.status).toBe("refused");
    expect(c.reasons.join(" ")).toContain("loses on discovery");
    expect(runLivePromotionPass(db)).toMatchObject({ proposed: 0, refused: 1 });
    expect(runLivePromotionPass(db)).toMatchObject({ proposed: 0, refused: 0 });
    const rows = db.listBenchmarkPromotions(SLOT);
    expect(rows.map((r) => r.outcome)).toEqual(["refused"]);
    expect(db.listBenchmarkDefaults()).toHaveLength(0);
    // A second candidate now faces a higher bar: the first counts as tried.
    seed("coder", ["vendor/other", B], 4, () => true);
    const other = evaluateLiveSlots(db)
      .find((r) => r.slot === SLOT)!
      .candidates.find((x) => x.candidate === "vendor/other")!;
    expect(other.triedBefore).toBeGreaterThanOrEqual(1);
  });

  it("a person's private outcomes never promote a world default", () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin, "scope:owner:Alice");
    expect(evaluateLiveSlots(db)).toHaveLength(0);
    expect(runLivePromotionPass(db)).toMatchObject({ slots: 0, proposed: 0 });
  });

  it("an agent never files a live promotion, even holding role.edit", async () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    db.saveAgentConfig({ name: "Bot", model: A, role: "coder", spawnedBy: "system" });
    const bot = login("Bot");
    grant(db, bot.entityId, "role.edit");
    expect(await bot.send(`benchmark promote ${SLOT} ${A}`)).toContain("a person files it");
    expect(db.listBenchmarkPromotions(SLOT)).toHaveLength(0);
  });

  it("no one files a promotion resting on their own work", () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const c = evaluateLiveSlots(db).find((r) => r.slot === SLOT)!.candidates[0]!;
    const filed = fileSlotPromotion(db, {
      slot: SLOT,
      live: c,
      actor: { key: "Worker1", keyOf: (id) => id },
    });
    expect(filed.kind).toBe("error");
    expect(db.listBenchmarkPromotions(SLOT)).toHaveLength(0);
  });

  it("a ledger run never fills a role-model slot", () => {
    const filed = fileSlotPromotion(world.db, {
      slot: SLOT,
      runId: "run-1",
      actor: { key: "p", keyOf: (id) => id },
    });
    expect(filed.kind).toBe("error");
  });

  it("no provider: nothing throws and nothing is raised", () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const env = { OPENROUTER_API_KEY: undefined } as Record<string, string | undefined>;
    const c = evaluateLiveSlots(db, { env }).find((r) => r.slot === SLOT)!.candidates[0]!;
    expect(c.status).toBe("not-callable");
    expect(runLivePromotionPass(db, { env })).toMatchObject({ proposed: 0, refused: 0 });
  });

  it("with no promotion every role resolves byte-identically, with no new trace", () => {
    const { db } = world;
    seed("coder", [A, B], 2 * LIVE_PROMOTION_MIN_PER_ARM, clearWin);
    const traces: DefaultResolution<unknown>[] = [];
    const off = onDefaultResolved((r) => traces.push(r));
    try {
      for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
        expect(roleModel(role, { slots: db, workRole: "coder" })).toEqual(roleModel(role));
      }
      setRoleModelSlots(db);
      expect(residentDefaultModel(db, process.env, "coder")).toBe(B);
      expect(crewModelFromEnv()).toBe(B);
      expect(traces).toHaveLength(0);
    } finally {
      off();
    }
  });
});
