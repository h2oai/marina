// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability posture (`src/config/capability-posture.ts`): every setting the
 * environment reference documents as off/observe/false by default, and every
 * non-core feature, has exactly one posture; the readout and the readiness
 * line read it; the generated page is fresh.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  daysUntil,
  FEATURE_POSTURE,
  isOffByDefault,
  KNOB_POSTURE,
  overduePosture,
  postureEntries,
  renderPostureReference,
} from "../src/config/capability-posture";
import { ENVIRONMENT_REFERENCE_PATH, environmentCatalog } from "../src/config/environment";
import { FEATURE_STATUS } from "../src/config/feature-status";
import { lastEvidenceAt, type PostureDb, postureCommand } from "../src/engine/commands/posture";
import { capabilityPostureCheck } from "../src/engine/readiness-learning";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, EntityId, RoomContext } from "../src/types";

const reference = readFileSync(ENVIRONMENT_REFERENCE_PATH, "utf8");
const catalog = environmentCatalog(reference);

describe("capability posture registry", () => {
  it("covers every off/observe/false MARINA_* setting in the environment reference", () => {
    const offByDefault = catalog.filter((s) => isOffByDefault(s.key, s.example)).map((s) => s.key);
    expect(offByDefault.length).toBeGreaterThan(0);
    // A new off-by-default setting needs a posture entry (measure + decideBy, or by-design).
    expect(offByDefault.filter((k) => !Object.hasOwn(KNOB_POSTURE, k))).toEqual([]);
  });

  it("names no setting that is gone, or that now defaults on", () => {
    const defaults = new Map(catalog.map((s) => [s.key, s.example]));
    const stale = Object.keys(KNOB_POSTURE).filter((k) => {
      const example = defaults.get(k);
      return example === undefined || !isOffByDefault(k, example);
    });
    expect(stale).toEqual([]);
  });

  it("covers exactly the non-core features", () => {
    const nonCore = FEATURE_STATUS.filter((f) => f.status !== "core").map((f) => f.name);
    expect(nonCore.filter((n) => !Object.hasOwn(FEATURE_POSTURE, n))).toEqual([]);
    expect(Object.keys(FEATURE_POSTURE).filter((n) => !nonCore.includes(n))).toEqual([]);
  });

  it("dates every measure entry and gives every by-design entry a reason", () => {
    for (const e of postureEntries()) {
      if (e.posture.class === "measure") {
        expect(e.posture.decideBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(e.posture.decideBy))).toBe(false);
        expect(e.posture.promoteWhen.length).toBeGreaterThan(0);
      } else expect(e.posture.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps docs/reference/capability-posture.md generated from the registry", () => {
    expect(readFileSync("docs/reference/capability-posture.md", "utf8")).toBe(
      renderPostureReference(),
    );
  });
});

describe("decide-by dates", () => {
  const firstDeadline = postureEntries()
    .flatMap((e) => (e.posture.class === "measure" ? [e.posture.decideBy] : []))
    .sort()[0]!;

  it("counts days to the end of the decide-by day (UTC)", () => {
    expect(daysUntil("2026-11-15", Date.parse("2026-11-15T12:00:00Z"))).toBe(0);
    expect(daysUntil("2026-11-15", Date.parse("2026-11-16T00:00:01Z"))).toBe(-1);
    expect(daysUntil("2026-11-15", Date.parse("2026-11-05T00:00:00Z"))).toBe(10);
  });

  it("readiness is ok before the first deadline and degraded after it, naming the oldest", () => {
    const before = Date.parse(`${firstDeadline}T00:00:00Z`);
    expect(capabilityPostureCheck(before)).toMatchObject({
      id: "capability-posture",
      status: "ok",
    });
    const after = before + 3 * 86_400_000;
    const overdue = overduePosture(after);
    expect(overdue.length).toBeGreaterThan(0);
    const check = capabilityPostureCheck(after);
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain(`${overdue.length} of `);
    expect(check.detail).toContain(overdue[0]!.subject);
    expect(check.detail).toContain(`due ${firstDeadline}`);
    expect(check.remediation).toContain("posture due");
  });
});

describe("posture command", () => {
  const T = Date.parse("2026-10-25T00:00:00Z");
  const fakeDb = (): PostureDb & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      listOutcomes: ((opts: { source?: string; kind?: string }) => {
        calls.push(`outcomes:${opts.source ?? ""}:${opts.kind ?? ""}`);
        return opts.source === "arena:" ? [{ resolved_at: T - 2 * 86_400_000 }] : [];
      }) as unknown as PostureDb["listOutcomes"],
      listJudgeLedger: ((opts: { surface?: string }) => {
        calls.push(`judge:${opts.surface ?? "*"}`);
        return [
          { surface: "verify", opined_at: T - 86_400_000 },
          { surface: "attention:wake", opined_at: T - 5 * 86_400_000 },
        ].filter((r) => !opts.surface || r.surface === opts.surface);
      }) as unknown as PostureDb["listJudgeLedger"],
      queryBenchmarkRuns: ((q: { benchmark?: string }) => {
        calls.push(`bench:${q.benchmark ?? "*"}`);
        return [];
      }) as unknown as PostureDb["queryBenchmarkRuns"],
    };
  };

  it("reads the last evidence time from each ledger", () => {
    const db = fakeDb();
    expect(lastEvidenceAt(db, { kind: "outcomes", source: "arena:" })).toBe(T - 2 * 86_400_000);
    expect(lastEvidenceAt(db, { kind: "judge", surface: "verify" })).toBe(T - 86_400_000);
    expect(lastEvidenceAt(db, { kind: "judge", surface: "attention:" })).toBe(T - 5 * 86_400_000);
    expect(lastEvidenceAt(db, { kind: "benchmark", benchmark: "frames" })).toBeUndefined();
    expect(lastEvidenceAt(db, { kind: "operator" })).toBeUndefined();
    expect(db.calls).toContain("judge:verify");
    expect(db.calls).toContain("judge:*"); // a prefix scans recent rows
  });

  it("reads an empty real database without error", () => {
    const db = new MarinaDB(":memory:");
    try {
      for (const e of postureEntries())
        if (e.posture.class === "measure")
          expect(lastEvidenceAt(db, e.posture.evidence)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  const run = (args: string, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const cmd = postureCommand({ db: fakeDb(), reference: () => reference, env, now: () => T });
    const ctx = { send: (_: EntityId, msg: string) => out.push(msg) } as unknown as RoomContext;
    const tokens = args.split(/\s+/).filter(Boolean);
    void cmd.handler(ctx, {
      entity: "e_1" as EntityId,
      raw: `posture ${args}`,
      verb: "posture",
      args,
      tokens,
    } as unknown as CommandInput);
    return out.join("\n");
  };

  it("is a rank-0 read-only command", () => {
    const cmd = postureCommand({ reference: () => reference });
    expect(cmd.minRank).toBe(0);
    expect(cmd.usage?.every((u) => typeof u !== "string" && u.effect === "read")).toBe(true);
  });

  it("lists measure entries with value, evidence, last evidence and days left", () => {
    const text = run("");
    expect(text).toContain("Capability posture —");
    expect(text).toContain(
      "MARINA_DECISION_VERIFY = observe (default) · decide by 2026-11-15 (21d left)",
    );
    expect(text).toContain("evidence: judge ledger surface verify · last 2026-10-24 (1d ago)");
    expect(text).toContain("MARINA_ARENA_TRENDS_PARTIAL = off (default)");
    expect(text).not.toContain("by design:");
    expect(run("all")).toContain("MARINA_TRADING_ENABLED = false (default) — by design:");
  });

  it("shows only short plain values and filters by name", () => {
    const hook = ["https://hooks.example.test/", "abc"].join("");
    const text = run("ops_notify", { MARINA_OPS_NOTIFY: hook });
    expect(text).toContain("MARINA_OPS_NOTIFY = set");
    expect(text).not.toContain(hook);
    expect(run("decision_verify", { MARINA_DECISION_VERIFY: "on" })).toContain(
      "MARINA_DECISION_VERIFY = on ·",
    );
    expect(run("due")).toContain("Nothing is past its decide-by date.");
  });
});
