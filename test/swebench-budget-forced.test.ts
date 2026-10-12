// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A Code Mode submission past its time budget's final-answer point (the path
// `marina -p` takes: it always sends `budget:`) reaches the benchmark ledger
// as `budget_forced` (migration 157): lifecycle → `-p --json` → session
// database → SWE-bench ledger result → ledger item → `benchmark result`.
// A label only: the harness grades the patch, the score never moves.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetForcedFromRuns,
  ledgerResult,
  type SweAttempt,
  sessionBudgetForced,
} from "../benchmarks/swebench/adapter";
import { printOutcome, terminalCodeLifecycle } from "../scripts/code";
import { beginCodingRun, codingRunMetadata } from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { type HarnessResultFile, ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

let f: ReturnType<typeof createTestEngine>;
let root: string;
let owner: ReturnType<typeof f.login>;
let state: DisposableStack;

beforeEach(() => {
  state = scopeProcessState({
    trustProfile: "shared",
    rateLimitBypass: true,
    env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off", MARINA_DECISION_VERIFY: "off" },
  });
  root = mkdtempSync(join(tmpdir(), "marina-swe-forced-"));
  f = createTestEngine({ storage: "disk" });
  owner = f.login("Owner");
  const actor = f.engine.entities.get(owner.entityId)!;
  grant(f.db, owner.entityId, "code.exec");
  f.db.createCodingSession({
    id: "s",
    title: "Coding",
    workspaceRoot: root,
    createdBy: actor.name,
  });
  f.db.updateCodingSession("s", { agent: actor.name, writer: actor.name });
  f.engine.commands.registerBuiltin(
    codeCommand({
      db: f.db,
      workspaceRegistry: new WorkspaceRegistry({ roots: [root] }),
      verificationRunner: new VerificationRunner(f.db, (pending) =>
        f.engine.trackBackgroundCommand(pending),
      ),
      getEntity: (id) => f.engine.entities.get(id as EntityId),
      getConnectionProtocol: () => "websocket",
    }),
  );
});

afterEach(async () => {
  await f.dispose();
  rmSync(root, { recursive: true, force: true });
  state.dispose();
});

/** A one-shot attempt as `marina -p` starts it: a time budget and a checks requirement. */
function begin(): CodingArtifactRow {
  const actor = f.engine.entities.get(owner.entityId)!;
  return beginCodingRun(f.db, {
    session: f.db.getCodingSession("s")!,
    owner: actor,
    worker: actor,
    prompt: "Fix the bug",
    profile: "marina",
    verificationRequirement: "checks",
    budgetMs: 600_000,
  });
}

async function send(run: CodingArtifactRow, command: string) {
  await f.engine.dispatchCommand(owner.entityId, command, {
    codingTarget: { sessionId: "s", runId: run.id },
  });
  await f.engine.drainCommands();
}

/** The terminal lifecycle payload, as the headless CLI receives it. */
function terminal() {
  const metadata = f.db
    .listCodingEvents("s")
    .filter((event) => event.kind === "code_lifecycle")
    .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
    .findLast((payload) => payload.terminal === true);
  return terminalCodeLifecycle({
    kind: "message",
    data: { code: { event: "code_lifecycle", sessionId: "s", phase: "completed", metadata } },
    timestamp: Date.now(),
  } as Perception);
}

const attempt = (id: string, budgetForced?: boolean): SweAttempt => ({
  instance_id: id,
  arm: "single",
  replicate: 1,
  exitCode: 3,
  patchBytes: 10,
  costUsd: 0.1,
  durationMs: 1000,
  trajectory: "",
  ...(budgetForced !== undefined ? { budgetForced } : {}),
});

describe("budget-forced Code Mode submissions in the benchmark ledger", () => {
  it("carries a forced submit from the session to the ledger item and `benchmark result`", async () => {
    const run = begin();
    // Inside the budget an unverified summary keeps the attempt active: nothing to label yet.
    await send(run, "code summary First draft");
    expect(f.db.getCodingArtifact(run.id)!.status).toBe("active");
    expect(sessionBudgetForced(f.path)).toBeUndefined();

    // Past the final-answer point the submission is the forced best effort.
    const now = Date.now();
    f.db.updateCodingArtifact(run.id, {
      metadata: {
        ...codingRunMetadata(f.db.getCodingArtifact(run.id)!),
        startedAt: now - 590_000,
        deadlineAt: now + 10_000,
      },
    });
    await send(run, "code summary Best effort at the deadline");
    expect(f.db.getCodingArtifact(run.id)!.status).toBe("submitted");

    // `marina -p --json` reports the label (and never calls the work verified).
    const end = terminal();
    expect(end?.budgetForced).toMatchObject({ reason: "deadline", cap: 600_000 });
    expect(printOutcome(end).status).toBe("unverified");

    // The harness reads the label from the session database.
    expect(sessionBudgetForced(f.path)).toBe(true);
    const result = ledgerResult(
      { resolved_ids: ["forced-1"] },
      [attempt("forced-1", sessionBudgetForced(f.path)), attempt("free-1", false), attempt("x")],
      { arm: { name: "single", model: "m" }, replicate: 1, subsetSeed: 1 },
    );
    expect(result.metadata.budgetForced).toBe(1);
    // Grading is the harness's alone: a forced patch that resolves still counts.
    expect(result.items.map((i) => i.score)).toEqual([1, 0, 0]);

    const raw = JSON.stringify(result);
    const built = ledgerFromHarnessResult(JSON.parse(raw) as HarnessResultFile, {
      targetKind: "model",
      target: "m",
      raw,
      id: "br_swe_forced",
      now: Date.now(),
    });
    f.db.recordBenchmarkLedgerRun(built.run, built.items);
    const items = f.db.getBenchmarkItems("br_swe_forced");
    const label = (id: string) => items.find((i) => i.item_id === id)?.budget_forced;
    expect(label("forced-1")).toBe(1);
    expect(label("free-1")).toBe(0);
    expect(label("x")).toBeNull();
    expect(items.find((i) => i.item_id === "forced-1")?.correct).toBe(1);

    owner.connection.clear();
    await f.engine.dispatchCommand(owner.entityId, "benchmark result br_swe_forced");
    await f.engine.drainCommands();
    expect(stripAnsi(owner.connection.allTextJoined())).toContain("1/3 answers forced at a budget");
  });

  it("labels a budgeted attempt that ended freely false, an unbudgeted or cut-off one unknown", () => {
    const row = (status: string, meta: Record<string, unknown>) => ({
      status,
      metadata_json: JSON.stringify(meta),
    });
    const forced = { reason: "deadline", used: 9, cap: 10, source: "final-request" };
    expect(budgetForcedFromRuns([])).toBeUndefined();
    expect(budgetForcedFromRuns([row("submitted", { taskId: 1 })])).toBeUndefined();
    expect(budgetForcedFromRuns([row("active", { deadlineAt: 5 })])).toBeUndefined();
    expect(budgetForcedFromRuns([row("submitted", { deadlineAt: 5 })])).toBe(false);
    expect(budgetForcedFromRuns([row("failed", { deadlineAt: 5 })])).toBe(false);
    // Implementer forced, reviewer free: the final patch still carries forced work.
    expect(
      budgetForcedFromRuns([
        row("submitted", { deadlineAt: 5, budgetForced: forced }),
        row("submitted", { deadlineAt: 9 }),
      ]),
    ).toBe(true);
    expect(budgetForcedFromRuns([{ status: "submitted", metadata_json: "{" }])).toBeUndefined();
    expect(sessionBudgetForced(join(root, "missing.db"))).toBeUndefined();
  });
});
