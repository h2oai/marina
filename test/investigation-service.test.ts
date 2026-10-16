// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InvestigationExecutor, InvestigationService } from "../src/investigations/service";
import { MarinaDB } from "../src/persistence/database";
import type { InvestigationRequest } from "../src/sdk/investigation-types";
import { binaryInvestigation } from "./fixtures/investigations";
import { until } from "./helpers";

const owner = { key: "owner", name: "owner" };
const agent = { key: "agent", name: "agent" };
const request: InvestigationRequest = {
  kind: "prediction",
  question: "Will we ship?",
  limits: { concurrency: 1, calls: 5 },
};
const complete = () => ({ result: structuredClone(binaryInvestigation) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("investigation execution boundaries", () => {
  let db: MarinaDB;
  let directory: string;
  let service: InvestigationService;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-investigation-service-"));
    db = new MarinaDB(join(directory, "world.db"));
    db.createUser({ id: owner.key, name: owner.name });
    db.createUser({ id: agent.key, name: agent.name });
  });
  afterEach(() => {
    service?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  for (const strategy of ["sequential", "parallel"] as const)
    it(`allows ${strategy} nested work with concurrency one`, async () => {
      let calls = 0;
      const executor: InvestigationExecutor = async (ctx) => {
        if (!ctx.attempt.parentAttemptId) {
          const first = ctx.child({ ...request, question: "Child A" }, "child-a");
          if (strategy === "sequential") await first;
          const second = ctx.child({ ...request, question: "Child B" }, "child-b");
          const children = await Promise.all([first, second]);
          expect(children.every((child) => child.state === "completed")).toBe(true);
          expect(new Set(children.map((child) => child.rootAttemptId)).size).toBe(1);
        }
        await ctx.observation.stage(
          "model",
          "fixture",
          { question: ctx.attempt.request.question },
          async () => {
            calls++;
            return "a forecast";
          },
        );
        return complete();
      };
      service = new InvestigationService(db, executor);
      const admitted = service.start(agent, request, "root");
      expect(admitted.attempt.state).toBe("queued");
      await service.wait(admitted.attempt.id);
      expect(db.getInvestigationAttempt(agent.key, admitted.attempt.id).state).toBe("completed");
      expect(calls).toBe(3);
      const same = service.start(agent, request, "root");
      expect(same.created).toBe(false);
      db.getInvestigation(agent.key, same.attempt.caseId);
      db.readInvestigationEvents(agent.key, same.attempt.id);
      expect(calls).toBe(3); // replay/read never invokes the executor
    });

  it("counts failed calls and caps the whole nested episode", async () => {
    let calls = 0;
    service = new InvestigationService(db, async (ctx) => {
      if (!ctx.attempt.parentAttemptId) await ctx.child(request, "child");
      await ctx.observation.stage("model", "fixture", {}, async () => {
        calls++;
        return 1;
      });
      return complete();
    });
    const { attempt } = service.start(
      owner,
      { ...request, limits: { calls: 1, concurrency: 1 } },
      "limited",
    );
    await service.wait(attempt.id);
    expect(calls).toBe(1);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("failed");
    expect(db.getInvestigationAttempt(owner.key, attempt.id).error).toContain("budget exhausted");
  });

  it("keeps cancellation final while recording late settlement", async () => {
    const upstream = deferred<string>();
    let cost = 0;
    let secondCall = false;
    service = new InvestigationService(db, async ({ observation }) => {
      observation.costUsd = () => cost;
      await observation.stage("model", "fixture", { prompt: "private context" }, async () => {
        const text = await upstream.promise;
        cost = 0.17;
        return text;
      });
      secondCall = true;
      return complete();
    });
    const { attempt } = service.start(owner, request, "cancel");
    await until(
      () => db.getInvestigationAttempt(owner.key, attempt.id).accounting.outstanding === 1,
    );
    service.cancel(owner.key, attempt.id);
    await service.wait(attempt.id);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("cancelled");
    upstream.resolve("late text");
    await until(
      () => db.getInvestigationAttempt(owner.key, attempt.id).accounting.knownUsd === 0.17,
    );
    const final = db.getInvestigationAttempt(owner.key, attempt.id);
    expect(final.accounting.outstanding).toBe(0);
    expect(final.result).toBeUndefined();
    expect(secondCall).toBe(false);
    expect(
      db
        .readInvestigationEvents(owner.key, attempt.id)
        .events.some((event) => event.kind === "stage_completed"),
    ).toBe(false);
  });

  it("checks live delegation before every subsequent operation", async () => {
    const proceed = deferred<void>();
    let calls = 0;
    service = new InvestigationService(db, async (ctx) => {
      await proceed.promise;
      await ctx.observation.stage("model", "fixture", {}, async () => {
        calls++;
      });
      return complete();
    });
    const root = db.createInvestigation(owner, request, "grant-root").attempt;
    db.grantInvestigation(owner.key, root.caseId, agent.key, "work");
    const child = service.start(
      agent,
      { ...request, parentAttemptId: root.id },
      "delegated",
    ).attempt;
    await until(() => db.getInvestigationAttempt(owner.key, child.id).state === "running");
    db.grantInvestigation(owner.key, root.caseId, agent.key, null);
    proceed.resolve();
    await service.wait(child.id);
    expect(calls).toBe(0);
    expect(db.getInvestigationAttempt(owner.key, child.id).state).toBe("failed");
  });

  it("stores exact redacted inputs and outputs and does not expose capture gaps as certainty", async () => {
    service = new InvestigationService(db, async ({ observation }) => {
      await observation.stage(
        "model",
        "fixture",
        { prompt: "mail person@example.org" },
        async () => ({ answer: "65 percent" }),
      );
      return complete();
    });
    const { attempt } = service.start(owner, request, "capture");
    await service.wait(attempt.id);
    const event = db
      .readInvestigationEvents(owner.key, attempt.id)
      .events.find((event) => event.kind === "stage_completed")!;
    expect(db.getInvestigationContent(owner.key, event.inputId!).value).toEqual({
      prompt: "mail <email>",
    });
    expect(db.getInvestigationContent(owner.key, event.outputId!).value).toEqual({
      answer: "65 percent",
    });
    expect(db.getInvestigationAttempt(owner.key, attempt.id).result!.capture.gaps).toContain(
      "Secret-shaped text was redacted from captured content",
    );
  });

  it("stops on shutdown without replaying or filing a late answer", async () => {
    const upstream = deferred<void>();
    service = new InvestigationService(db, async ({ observation }) => {
      await observation.stage("model", "fixture", {}, () => upstream.promise);
      return complete();
    });
    const { attempt } = service.start(owner, request, "shutdown");
    await until(
      () => db.getInvestigationAttempt(owner.key, attempt.id).accounting.outstanding === 1,
    );
    service.close();
    upstream.resolve();
    await service.wait(attempt.id);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("interrupted");
    expect(db.getInvestigationAttempt(owner.key, attempt.id).result).toBeUndefined();
  });
});
