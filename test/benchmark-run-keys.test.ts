// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  lookupRunKey,
  mintRunKey,
  noteRunKeyCall,
  resetRunKeysForTests,
  revokeRunKey,
  runKeyRefusal,
  TRANSPORT_TRIP,
  withRunKey,
} from "../src/engine/benchmark-run-keys";
import { armStack, benchmarkRunConfig, runKeyGrant } from "../src/engine/benchmark-runner";
import { handleModelApi } from "../src/net/model/model-api";
import { authenticate } from "../src/net/model-api/shared";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

describe("benchmark run keys", () => {
  beforeEach(() => resetRunKeysForTests());

  it("mints an unguessable key, looks it up, expires and revokes it", () => {
    const token = mintRunKey({ runId: "br_1", stack: "none" });
    expect(token).toMatch(/^mrk_[0-9a-f]{32}$/);
    expect(lookupRunKey(token)).toMatchObject({ runId: "br_1", stack: "none", spentUsd: 0 });
    expect(lookupRunKey(`${token}0`)).toBeUndefined();
    expect(lookupRunKey(token, Date.now() + 7 * 3_600_000)).toBeUndefined();
    const again = mintRunKey({ runId: "br_2" });
    expect(revokeRunKey(again)?.runId).toBe("br_2");
    expect(lookupRunKey(again)).toBeUndefined();
  });

  it("attributes spend inside the run and refuses once the cap is spent", () => {
    const token = mintRunKey({ runId: "br_1", capUsd: 1 });
    const state = lookupRunKey(token)!;
    noteRunKeyCall({ ok: true, costUsd: 0.4 }); // outside any run key: not attributed
    expect(state.spentUsd).toBe(0);
    withRunKey(state, () => noteRunKeyCall({ ok: true, costUsd: 0.6 }));
    expect(runKeyRefusal(state)).toBeUndefined();
    withRunKey(state, () => noteRunKeyCall({ ok: true, costUsd: 0.5 }));
    expect(runKeyRefusal(state)).toMatchObject({ code: "run_budget_exhausted" });
  });

  it("stops after consecutive network failures; a good call resets the count", () => {
    const state = lookupRunKey(mintRunKey({ runId: "br_1" }))!;
    withRunKey(state, () => {
      for (let i = 0; i < TRANSPORT_TRIP - 1; i++) noteRunKeyCall({ ok: false, network: true });
      noteRunKeyCall({ ok: true });
      for (let i = 0; i < TRANSPORT_TRIP - 1; i++) noteRunKeyCall({ ok: false, network: true });
      // An HTTP error is the upstream answering: not a transport strike.
      noteRunKeyCall({ ok: false });
    });
    expect(runKeyRefusal(state)).toBeUndefined();
    withRunKey(state, () => noteRunKeyCall({ ok: false, network: true }));
    expect(runKeyRefusal(state)).toMatchObject({ code: "run_transport_failed" });
  });

  it("maps arms to stacks and records arm and cap in the run config", () => {
    expect(armStack("bare")).toEqual({ stack: "none" });
    expect(armStack("full")).toEqual({ stack: "full" });
    expect(armStack("lessons,obligations")).toEqual({ stack: "lessons,obligations" });
    expect(armStack("on")).toMatchObject({ stack: expect.stringContaining("obligations") });
    expect(armStack("nonsense")).toHaveProperty("error");
    const config = benchmarkRunConfig({ benchmark: "gsm8k", arm: "On", capUsd: 3 }, {});
    expect(config).toMatchObject({ arm: "on", capUsd: 3 });
    expect(benchmarkRunConfig({ benchmark: "gsm8k" }, {})).not.toHaveProperty("arm");
  });

  it("binds each learning arm to its own authorized identity and evaluation fence", () => {
    const a = runKeyGrant("br_a", { benchmark: "smoke", arm: "on" }, { targetKind: "model" })!;
    const b = runKeyGrant("br_b", { benchmark: "smoke", arm: "on" }, { targetKind: "model" })!;
    expect(a.entityName).toBe("benchmark-br_a");
    expect(b.entityName).not.toBe(a.entityName);
    expect(a.evalTag).toBe("benchmark=smoke; mode=measure");
    expect(a.stack?.split(",")).toContain("learn");
    const token = mintRunKey(a);
    const auth = authenticate(
      new Request("http://localhost/v1/models", { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(auth).toMatchObject({ auth: { canNameMap: false, boundEntityName: a.entityName } });
    revokeRunKey(token);
    expect(lookupRunKey(token)).toBeUndefined();
  });
});

describe("run keys on /v1", () => {
  let fx: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    resetRunKeysForTests();
    fx = createTestEngine();
  });
  afterEach(() => fx.dispose());

  const req = (token: string, path = "/v1/models") =>
    new Request(`http://127.0.0.1${path}`, { headers: { Authorization: `Bearer ${token}` } });

  it("authenticates a live run key even when MODEL_API_KEYS is set, with no name-map authority", () => {
    using _state = scopeProcessState({ env: { MODEL_API_KEYS: "operator-secret" } });
    const token = mintRunKey({ runId: "br_1", entityName: "BenchArm" });
    const outcome = authenticate(req(token));
    expect("auth" in outcome && outcome.auth).toMatchObject({
      internal: false,
      canNameMap: false,
      boundEntityName: "BenchArm",
      runKey: { runId: "br_1" },
    });
    revokeRunKey(token);
    expect("error" in authenticate(req(token))).toBe(true);
  });

  it("serves a run key's requests and refuses them once its run is stopped", async () => {
    using _state = scopeProcessState({ env: { MODEL_API_KEYS: "operator-secret" } });
    const token = mintRunKey({ runId: "br_1", capUsd: 1 });
    const url = new URL("http://127.0.0.1/v1/models");
    const ok = await handleModelApi(url, "GET", req(token), fx.engine);
    expect(ok?.status).toBe(200);
    const state = lookupRunKey(token)!;
    withRunKey(state, () => noteRunKeyCall({ ok: true, costUsd: 2 }));
    const refused = await handleModelApi(url, "GET", req(token), fx.engine);
    expect(refused?.status).toBe(429);
    expect(((await refused!.json()) as { error: { code: string } }).error.code).toBe(
      "run_budget_exhausted",
    );
  });
});
