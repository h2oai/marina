// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forecastTyped, type TypedForecastDeps } from "../src/forecast/typed";
import { predictionResult } from "../src/investigations/results";
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

  it("detaches cancelled source reads while retaining outstanding accounting until settlement", async () => {
    const upstream = deferred<string>();
    let continued = false;
    let detached = false;
    service = new InvestigationService(db, async ({ observation }) => {
      await observation.stage("source_read", "retriever", {}, () => upstream.promise, false);
      continued = true;
      return complete();
    });
    const { attempt } = service.start(owner, request, "cancel-source");
    await until(
      () => db.getInvestigationAttempt(owner.key, attempt.id).accounting.outstanding === 1,
    );
    service.cancel(owner.key, attempt.id);
    const done = service.wait(attempt.id).then(() => {
      detached = true;
    });
    try {
      await until(() => detached, { timeoutMs: 1000 });
      expect(db.getInvestigationAttempt(owner.key, attempt.id).accounting.outstanding).toBe(1);
    } finally {
      upstream.resolve("late private source");
      await done;
      await until(
        () => db.getInvestigationAttempt(owner.key, attempt.id).accounting.outstanding === 0,
      );
    }
    expect(continued).toBe(false);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).result).toBeUndefined();
  });

  it("admits concurrent retries once and dispatches nothing if admission persistence fails", async () => {
    let calls = 0;
    service = new InvestigationService(db, async () => {
      calls++;
      return complete();
    });
    const starts = await Promise.all(
      Array.from({ length: 32 }, async () => service.start(owner, request, "retry")),
    );
    expect(starts.filter((start) => start.created)).toHaveLength(1);
    expect(new Set(starts.map((start) => start.attempt.id)).size).toBe(1);
    await service.wait(starts[0]!.attempt.id);
    expect(calls).toBe(1);
    db.memoryRepository().raw.exec(
      "CREATE TRIGGER refuse_admission BEFORE INSERT ON investigation_admissions BEGIN SELECT RAISE(ABORT,'disk failure'); END",
    );
    expect(() => service.start(owner, request, "failed-write")).toThrow("disk failure");
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(db.listInvestigations(owner.key)).toHaveLength(1);
  });

  it("cancelling a child leaves its sibling and parent budget usable", async () => {
    const hold = deferred<void>();
    let childId = "";
    let siblingCompleted = false;
    service = new InvestigationService(db, async (ctx) => {
      if (!ctx.attempt.parentAttemptId) {
        const child = ctx.child({ ...request, question: "cancel me" }, "cancel-child");
        await until(() => !!childId);
        service.cancel(owner.key, childId);
        expect((await child).state).toBe("cancelled");
        hold.resolve();
        const sibling = await ctx.child({ ...request, question: "keep me" }, "keep-child");
        siblingCompleted = sibling.state === "completed";
      } else if (ctx.attempt.request.question === "cancel me") {
        childId = ctx.attempt.id;
        await ctx.observation.stage("model", "fixture", {}, () => hold.promise);
      } else {
        await ctx.observation.stage("model", "fixture", {}, async () => "done");
      }
      return complete();
    });
    const { attempt } = service.start(owner, request, "isolated-cancel");
    try {
      await service.wait(attempt.id);
      expect(siblingCompleted).toBe(true);
      expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("completed");
    } finally {
      hold.resolve();
    }
  });

  it("dispatches no provider operation when mandatory stage-input capture fails", async () => {
    let calls = 0;
    db.memoryRepository().raw.exec(
      "CREATE TRIGGER refuse_stage_input BEFORE INSERT ON investigation_content WHEN new.label='model:input' BEGIN SELECT RAISE(ABORT,'capture storage failure'); END",
    );
    service = new InvestigationService(db, async ({ observation }) => {
      await observation.stage("model", "fixture", { prompt: "must be recorded" }, async () => {
        calls++;
        return "not reached";
      });
      return complete();
    });
    const { attempt } = service.start(owner, request, "capture-failure");
    await service.wait(attempt.id);
    expect(calls).toBe(0);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("failed");
    expect(db.getInvestigationAttempt(owner.key, attempt.id).error).toContain(
      "capture storage failure",
    );
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

  it("observes the actual typed pipeline without changing answers or upstream request counts", async () => {
    const counts = { model: 0, research: 0, source: 0 };
    const deps: TypedForecastDeps = {
      now: () => new Date("2026-10-16T00:00:00Z"),
      retriever: async () => {
        counts.research++;
        return {
          report: "- Release checks are incomplete [checklist](https://example.org/release)",
          sources: [{ url: "https://example.org/release" }],
          costUsd: 0,
          searches: 1,
          retriever: "fixture",
        };
      },
      analysts: [
        {
          name: "fixture-model",
          complete: async () => {
            counts.model++;
            return JSON.stringify({
              answer: "yes",
              probabilities: { yes: 0.65, no: 0.35 },
              reason: "Release checks are incomplete",
              confidence: 0.6,
            });
          },
        },
      ],
      pageText: async () => {
        counts.source++;
        return "Release checks are incomplete";
      },
      options: {
        plan: false,
        researchRounds: 1,
        runs: 1,
        critique: false,
        verify: false,
        followUp: false,
      },
    };
    const input = {
      question: request.question,
      answer: {
        type: "choice" as const,
        probabilities: true,
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    };
    const baseline = await forecastTyped(input, deps);
    const baselineCounts = { ...counts };
    counts.model = counts.research = counts.source = 0;
    let observed: typeof baseline | undefined;
    service = new InvestigationService(db, async ({ observation }) => {
      observed = await forecastTyped(
        input,
        observation.instrument(
          deps,
          {
            tier: "degraded",
            analysts: ["fixture-model"],
            retriever: "fixture",
            judge: "none",
            notes: ["fixture"],
          },
          () => 0,
        ),
      );
      return { result: predictionResult(request, observed) };
    });
    const { attempt } = service.start(owner, request, "parity");
    await service.wait(attempt.id);
    expect(db.getInvestigationAttempt(owner.key, attempt.id).state).toBe("completed");
    // Wall-clock measurement is expected to differ; every semantic field must match.
    expect({ ...observed, latencyMs: 0 }).toEqual({ ...baseline, latencyMs: 0 });
    expect(counts).toEqual(baselineCounts);
    expect(counts.model).toBeGreaterThan(0);
    expect(counts.research).toBeGreaterThan(0);
  });
});
