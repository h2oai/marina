// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import {
  KIT_FLAGS,
  kitArgs,
  kitRunRoot,
  resetKitJobsForTests,
  worldLedgerPath,
} from "../src/engine/benchmark-kit";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

describe("benchmark kit launcher (pure)", () => {
  it("maps allowlisted options to the kit's flags and refuses anything else", () => {
    expect(
      kitArgs("tau2", { arms: "single,verify", replicates: "2", budget: "$5", domain: "airline" }, [
        "--dry-run",
      ]),
    ).toEqual([
      "tau2",
      "--arm",
      "single,verify",
      "--replicates",
      "2",
      "--budget-usd",
      "5",
      "--domain",
      "airline",
      "--dry-run",
    ]);
    expect(kitArgs("tau2", { "run-dir": "/etc" })).toHaveProperty("error");
    expect(kitArgs("tau2", { ledger: "x.db" })).toHaveProperty("error");
    // A value is one plain token: no spaces, quotes or shell syntax.
    expect(kitArgs("tau2", { model: "a b" })).toHaveProperty("error");
    expect(kitArgs("tau2", { model: "$(rm -rf /)" })).toHaveProperty("error");
    expect(kitArgs("../tau2", {})).toHaveProperty("error");
    expect(Object.values(KIT_FLAGS)).not.toContain("--run-dir");
    expect(Object.values(KIT_FLAGS)).not.toContain("--ledger");
  });

  it("files into the world DB and keeps runs beside it", () => {
    expect(worldLedgerPath({ DB_PATH: "data/marina.db" })).toBe(resolve("data/marina.db"));
    expect(kitRunRoot({ DB_PATH: "data/marina.db" })).toBe(join(resolve("data"), "kit-runs"));
    expect(kitRunRoot({ MARINA_BENCHMARK_KIT_DIR: "/srv/kit" })).toBe("/srv/kit");
  });
});

describe("benchmark kit command", () => {
  let fx: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    resetKitJobsForTests();
    fx = createTestEngine();
  });
  afterEach(() => fx.dispose());
  const text = (c: { messages: { data?: { text?: unknown } }[] }) =>
    stripAnsi(c.messages.map((m) => String(m.data?.text ?? "")).join("\n"));

  it("needs a budget for a real run and reports unknown jobs", async () => {
    const { connection, entityId } = fx.login("Ada");
    fx.engine.entities.get(entityId)!.properties.rank = 4;
    await fx.engine.processCommand(entityId, "benchmark kit tau2 arms:single limit:2");
    expect(text(connection)).toContain("a run needs budget:<usd>");
    await fx.engine.processCommand(entityId, "benchmark kit tau2 bogus:1 budget:1");
    expect(text(connection)).toContain("unexpected");
    await fx.engine.processCommand(entityId, "benchmark kit status kit_nope");
    expect(text(connection)).toContain("No kit job");
    await fx.engine.processCommand(entityId, "benchmark kit status");
    expect(text(connection)).toContain("No kit jobs since this server started");
  });
});
