// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import { beginObservedSpend } from "../src/engine/spend-observation";
import { InvestigationService } from "../src/investigations/service";
import { MarinaDB } from "../src/persistence/database";
import { binaryInvestigation } from "./fixtures/investigations";

it("sums unique parent and child receipts, preserving unknown interrupted calls across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-investigation-cost-"));
  const path = join(dir, "world.db");
  let db = new MarinaDB(path);
  const actor = { key: "owner", name: "Owner" };
  db.createUser({ id: actor.key, name: actor.name });
  let service = new InvestigationService(db, async (ctx) => {
    if (!ctx.attempt.parentAttemptId) {
      recordSpend("forecast", 0.3);
      await ctx.child({ kind: "research", question: "child" }, "child");
    } else {
      const call = beginObservedSpend("forecast", "fixture/model")!;
      call.settle(0.2);
      call.settle(0.2); // one upstream call, repeated receipt notification
      beginObservedSpend("search", "fixture/interrupted"); // outstanding when the process ends
    }
    return {
      result: {
        ...structuredClone(binaryInvestigation),
        accounting: { knownUsd: 10, complete: false, outstanding: 0 },
      },
    };
  });
  try {
    const attempt = service.start(actor, { kind: "research", question: "root" }, "root").attempt;
    await service.wait(attempt.id);
    const original = db.getInvestigationAttempt(actor.key, attempt.id);
    expect(original.accounting).toMatchObject({
      knownUsd: 0.5,
      pricedCalls: 2,
      outstanding: 1,
      complete: false,
      reportedUsd: 10,
    });
    service.close();
    db.close();
    db = new MarinaDB(path);
    service = new InvestigationService(db);
    const recovered = db.getInvestigationAttempt(actor.key, attempt.id);
    expect(recovered.accounting.knownUsd).toBe(0.5);
    expect(recovered.accounting.reasons?.join(" ")).toContain("no settled receipt");
    db.eraseInvestigation(actor.key, attempt.caseId);
    expect(() => db.getInvestigationAttempt(actor.key, attempt.id)).toThrow();
  } finally {
    service.close();
    db.close();
    resetSpendLedgerForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("can report complete priced work without equating zero outstanding calls to complete coverage", async () => {
  const db = new MarinaDB(":memory:");
  const actor = { key: "owner", name: "Owner" };
  db.createUser({ id: actor.key, name: actor.name });
  const service = new InvestigationService(db, async (ctx) => {
    recordSpend("forecast", 0.17);
    if (ctx.attempt.request.question === "unknown")
      ctx.observation.accountingGaps.add("External adapter exposes no billing receipts");
    return {
      result: {
        ...structuredClone(binaryInvestigation),
        accounting: { knownUsd: 0.17, complete: false, outstanding: 0 },
      },
    };
  });
  try {
    for (const question of ["known", "unknown"]) {
      const attempt = service.start(actor, { kind: "research", question }, question).attempt;
      await service.wait(attempt.id);
      const accounting = db.getInvestigationAttempt(actor.key, attempt.id).accounting;
      expect(accounting).toMatchObject({
        knownUsd: 0.17,
        pricedCalls: 1,
        outstanding: 0,
        complete: question === "known",
      });
    }
  } finally {
    service.close();
    db.close();
    resetSpendLedgerForTests();
  }
});
