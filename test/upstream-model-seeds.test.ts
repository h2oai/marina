// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An imported bundle's seed for a slot that chooses a model is withheld from
 * `resolveDefault` until a local PERSON holding `role.edit` adopts it: one
 * ops-inbox approval per slot+value, the trace says `withheld`, an agent
 * never adopts, and the adoption is filed through `fileSlotPromotion` with
 * basis `upstream`. Seeds for non-model slots serve as before, and
 * `MARINA_UPSTREAM_MODEL_SEEDS=serve` restores direct serving.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleModel } from "../src/config/model-tiers";
import { type DefaultResolution, onDefaultResolved } from "../src/engine/default-resolution";
import { grant } from "../src/engine/safety-gates";
import { ownBundleGrant } from "../src/learned/entitlement";
import { exportLearnedBundle } from "../src/learned/export";
import { importLearnedBundle } from "../src/learned/import";
import { generateLearnedKeyPair, type PinnedKey } from "../src/learned/sign";
import {
  isModelSelectingSlot,
  proposeUpstreamModelSeeds,
  upstreamModelSeedMode,
  upstreamProposalKey,
} from "../src/learned/upstream-model-seeds";
import { RANK_WEIGHTS_SLOT, rankWeights } from "../src/memory/admission";
import { keyIdOfPublicKey } from "../src/net/federation-crypto";
import { MarinaDB } from "../src/persistence/database";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

setDefaultTimeout(30_000);

const SLOT = "role-model:coder";
const A = "vendor/strong-a";
const TIER = "marina/cheap";
const WEIGHTS = { value: 0.4, generality: 0.2, novelty: 0.1, evidence: 0.2, evidence_fit: 0.1 };
/** A provider key, assembled at runtime (never a secret-shaped literal). */
const FAKE_KEY = ["test", "only", "key"].join("-");
const CLEAN_ENV: Record<string, string | undefined> = {
  OPENROUTER_API_KEY: FAKE_KEY,
  MARINA_DEFAULT_MODEL: undefined,
  MARINA_AGENT_MODELS: undefined,
  MARINA_MODEL_TIER_CHEAP: undefined,
  MARINA_MODEL_TIER_STRONG: undefined,
  MARINA_UPSTREAM_MODEL_SEEDS: undefined,
};
const KEY = generateLearnedKeyPair();
const PINNED: PinnedKey[] = [
  { label: "test", publicKey: KEY.publicKey, keyId: keyIdOfPublicKey(KEY.publicKey) },
];
const ON = { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv;

describe("upstream seeds that choose a model", () => {
  let state: DisposableStack;
  let world: ReturnType<typeof createTestEngine>;
  const dirs: string[] = [];
  let traces: DefaultResolution<unknown>[];
  let stopTrace: () => void;

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: CLEAN_ENV });
    world = createTestEngine();
    traces = [];
    stopTrace = onDefaultResolved((r) => traces.push(r));
  });
  afterEach(async () => {
    stopTrace();
    await world.dispose();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    state.dispose();
  });

  /** A publisher world whose promoted slots are a role's model and the rank weights. */
  function publish(): string {
    const dir = mkdtempSync(join(tmpdir(), "upstream-model-seeds-"));
    dirs.push(dir);
    const source = new MarinaDB(join(dir, "source.db"));
    try {
      for (const [slot, value] of [
        [SLOT, A],
        [RANK_WEIGHTS_SLOT, WEIGHTS],
      ] as const) {
        source.recordBenchmarkPromotion({
          slot,
          outcome: "seeded",
          challenger_run_id: null,
          incumbent_run_id: null,
          value_json: JSON.stringify(value),
          actor: "publisher",
          stats_json: null,
          reason: "first incumbent",
          created_at: 1,
        });
      }
      const outDir = join(dir, "bundle");
      exportLearnedBundle(source, {
        outDir,
        name: "models",
        publisher: { name: "Test Publisher" },
        signingKey: KEY.privateKey,
        marinaVersion: "0.9.0",
      });
      return outDir;
    } finally {
      source.close();
    }
  }

  async function importInto(db: MarinaDB) {
    const out = await importLearnedBundle(db, publish(), {
      pinned: PINNED,
      env: ON,
      entitlement: ownBundleGrant("operator"),
    });
    if (!out.ok) throw new Error(out.error);
    return out.report;
  }

  function login(name: string) {
    const { connection, entityId } = world.login(name);
    const send = async (cmd: string) => {
      connection.clear();
      await world.engine.processCommand(entityId, cmd);
      return stripAnsi(connection.allTextJoined());
    };
    return { entityId, send };
  }

  const proposals = (db: MarinaDB) =>
    db.listOperationalAlerts().filter((a) => a.alert_key.startsWith(`promotion:${SLOT}:upstream`));

  it("classifies every slot class but memory-ranking as model-selecting; propose by default", () => {
    for (const slot of [
      SLOT,
      "verify:checker",
      "forecast-config:board",
      "forecast-config:family:forecasting",
      "showcase:crew",
      "crew:answerer:formation",
      "some-new-slot",
    ])
      expect(isModelSelectingSlot(slot)).toBe(true);
    expect(isModelSelectingSlot(RANK_WEIGHTS_SLOT)).toBe(false);
    expect(isModelSelectingSlot("memory-ranking")).toBe(false);
    expect(upstreamModelSeedMode({})).toBe("propose");
    expect(upstreamModelSeedMode({ MARINA_UPSTREAM_MODEL_SEEDS: "junk" })).toBe("propose");
    expect(upstreamModelSeedMode({ MARINA_UPSTREAM_MODEL_SEEDS: "serve" })).toBe("serve");
  });

  it("imports, withholds the role's model seed, proposes once; only a person with role.edit adopts", async () => {
    const { db } = world;
    const report = await importInto(db);
    expect(report.seeded.sort()).toEqual([RANK_WEIGHTS_SLOT, SLOT].sort());
    expect(report.proposed).toBe(1);

    // The role still resolves to its tier; the trace says the seed was withheld.
    traces = [];
    const choice = roleModel("resident", { slots: db, workRole: "coder" });
    expect(choice.model).toBe(TIER);
    expect(choice.source.startsWith("tier:")).toBe(true);
    const trace = traces.find((t) => t.slot === SLOT)!;
    expect(trace.source).toBe("builtin");
    expect(trace.withheld?.[0]).toContain(`${SLOT}@upstream:`);
    expect(trace.reason).toContain("withheld pending approval");

    // A non-model slot's seed still serves.
    expect(rankWeights(db)).toEqual({ weights: WEIGHTS, source: "upstream" });

    // Exactly one approval, never re-raised; none for the non-model slot.
    expect(proposals(db)).toHaveLength(1);
    const alert = proposals(db)[0]!;
    expect(alert.alert_key).toBe(upstreamProposalKey(SLOT, JSON.stringify(A)));
    expect(alert.attention_kind).toBe("approval");
    expect(alert.status).toBe("open");
    expect(alert.action_ref).toBe(`benchmark promote ${SLOT} ${A}`);
    expect(proposeUpstreamModelSeeds(db)).toBe(0);
    expect(db.listOperationalAlerts().some((a) => a.alert_key.includes(RANK_WEIGHTS_SLOT))).toBe(
      false,
    );

    // An agent never adopts, even holding role.edit.
    db.saveAgentConfig({ name: "Bot", model: A, role: "coder", spawnedBy: "system" });
    const bot = login("Bot");
    grant(db, bot.entityId, "role.edit");
    expect(await bot.send(`benchmark promote ${SLOT} ${A}`)).toContain("An agent never adopts");
    expect(await bot.send(`benchmark promote ${SLOT} upstream`)).toContain("An agent never adopts");
    expect(db.getBenchmarkDefault(SLOT)).toBeUndefined();

    // A person without role.edit is held as a challenge; nothing is filed.
    const viewer = login("Viewer");
    expect(await viewer.send(`benchmark promote ${SLOT} ${A}`)).toContain("held: challenge");
    expect(db.getBenchmarkDefault(SLOT)).toBeUndefined();

    // A person holding role.edit adopts it, filed with basis upstream.
    const alice = login("Alice");
    grant(db, alice.entityId, "role.edit");
    expect(await alice.send(`benchmark promote ${SLOT} other/model`)).toContain(
      `An imported upstream seed proposes ${A}`,
    );
    expect(db.getBenchmarkDefault(SLOT)).toBeUndefined();
    expect(await alice.send(`benchmark promote ${SLOT} ${A}`)).toContain(`Adopted upstream:`);
    const history = db.listBenchmarkPromotions(SLOT);
    expect(history.map((h) => h.outcome)).toEqual(["seeded"]);
    const stats = JSON.parse(history[0]!.stats_json!);
    expect(stats).toMatchObject({ basis: "upstream", artifactId: expect.any(String) });
    expect(stats.valueSha256).toHaveLength(64);
    expect(history[0]!.actor).toBe(db.durableEntityKey(alice.entityId));
    expect(proposals(db)[0]!.status).toBe("resolved");

    // The role now resolves to the adopted model, as a local slot.
    expect(roleModel("resident", { slots: db, workRole: "coder" })).toEqual({
      model: A,
      source: `promoted ${SLOT}`,
    });
    // Nothing left to adopt.
    expect(await alice.send(`benchmark promote ${SLOT} upstream`)).toContain("already set locally");
  });

  it("MARINA_UPSTREAM_MODEL_SEEDS=serve serves the seed directly and raises nothing", async () => {
    using _serve = scopeProcessState({ env: { MARINA_UPSTREAM_MODEL_SEEDS: "serve" } });
    const { db } = world;
    const report = await importInto(db);
    expect(report.proposed).toBe(0);
    expect(proposals(db)).toHaveLength(0);
    const choice = roleModel("resident", { slots: db, workRole: "coder" });
    expect(choice.model).toBe(A);
  });
});
