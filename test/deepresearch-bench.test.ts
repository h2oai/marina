// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DeepResearch Bench adapter: what reaches the generator (prompt, barred
 * sources — never rubrics), the pre-registered split, DRB II's per-task
 * arithmetic, the capped judge proxy, and ledger/lesson records that carry
 * ids and numbers only. No network.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairedDifference } from "../benchmarks/deepresearch/compare";
import {
  BENCHMARK_SELF_EXCLUSIONS,
  parseDrb1,
  parseDrb2,
  selectSplit,
} from "../benchmarks/deepresearch/dataset";
import { recordScoredRun, reportOutcome } from "../benchmarks/deepresearch/ledger";
import { drb2TaskScores } from "../benchmarks/deepresearch/official";
import {
  generateReports,
  generationSpend,
  loadRecords,
  type TaskRecord,
} from "../benchmarks/deepresearch/run";
import { startJudgeProxy } from "../benchmarks/judge-proxy";
import { SpendGuard } from "../src/engine/spend-guard";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import { MarinaDB } from "../src/persistence/database";
import { ResearchInterrupted } from "../src/research/checkpoint";

afterEach(() => resetSpendLedgerForTests());

describe("resumable report generation", () => {
  it("preserves interrupted costs and evidence, and charges only new work on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-generation-"));
    try {
      let interrupt = true;
      let searches = 0;
      const makeLead = () => {
        const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        return {
          usage,
          complete: async (system: string, user: string) => {
            usage.calls++;
            usage.costUsd += 0.01;
            if (system.includes("You plan"))
              return JSON.stringify({
                sections: [
                  { heading: "Coverage", goal: "coverage", queries: ["coverage"] },
                  { heading: "Causes", goal: "causes", queries: ["causes"] },
                ],
              });
            if (system.includes("You write one section")) {
              if (interrupt && user.includes("WRITE SECTION 2:"))
                throw new ResearchInterrupted("test stop");
              return "Coverage was 21% [1].";
            }
            return JSON.stringify({
              title: "Report",
              summary: "Summary",
              conclusion: "Conclusion",
            });
          },
        };
      };
      const guard = (spentUsd = 0) =>
        new SpendGuard({ label: "test", budgetUsd: 2, spentUsd, daily: false, reserveFactor: 0 });
      const input = {
        tasks: parseDrb1('{"id": 1, "language": "en", "prompt": "Coverage and causes"}\n'),
        config: {
          label: "recovery",
          lead: "test/model",
          gapRound: false,
          retrievalIdentity: "fixed",
        },
        retriever: () => async () => {
          searches++;
          return {
            report: '- 2026-01-01 — "Coverage was 21%." [Survey](https://example.org/survey)',
            sources: [
              { url: "https://example.org/survey", title: "Survey", text: "Coverage was 21%." },
            ],
            searches: 1,
            costUsd: 0.1,
            retriever: "fake",
          };
        },
        outDir: dir,
        concurrency: 1,
        makeLead,
        log: () => undefined,
      };
      const firstGuard = guard();
      const first = await generateReports({ ...input, guard: firstGuard });
      expect(first.failed).toBe(1);
      expect(first.stopped).toBe("test stop");
      expect(searches).toBe(2);
      const prior = generationSpend(dir, "recovery");
      expect(prior).toBeCloseTo(0.23);
      expect(firstGuard.spentUsd).toBeCloseTo(prior);
      expect(loadRecords(dir, "recovery")[0]!.report).toBeUndefined();
      interrupt = false;
      const secondGuard = guard(prior);
      expect((await generateReports({ ...input, guard: secondGuard })).done).toBe(1);
      expect(searches).toBe(2);
      expect(generationSpend(dir, "recovery")).toBeCloseTo(0.25);
      expect(secondGuard.spentUsd).toBeCloseTo(0.25);
      expect(loadRecords(dir, "recovery")[0]!.report?.status).toBe("complete");
      expect((await generateReports({ ...input, guard: guard(0.25) })).skipped).toBe(1);
      await expect(
        generateReports({
          ...input,
          config: { ...input.config, retrievalIdentity: "changed" },
          guard: guard(),
        }),
      ).rejects.toThrow("configuration changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const DRB2_ROW = {
  id: "task7",
  idx: 1,
  language: "zh",
  theme: "Finance & Business",
  license: "CC BY 4.0",
  prompt: "请撰写报告。**important** do not view the following article",
  content: {
    task: "请撰写报告。",
    rubric: { info_recall: ["SECRET RUBRIC ITEM"], analysis: [], presentation: [] },
    blocked: {
      title: "The Local Land Finance Transformation with the Synergy of Increment and Inventory",
      authors: ["A"],
      urls: ["https://www.mdpi.com/2073-445X/11/9/1529"],
    },
  },
};

describe("datasets", () => {
  it("DRB II tasks carry the prompt and barred source, never the rubric", () => {
    const [t] = parseDrb2(`${JSON.stringify(DRB2_ROW)}\n`);
    expect(t).toMatchObject({ board: "drb2", id: "idx-1", language: "zh", license: "CC BY 4.0" });
    expect(t?.prompt).toBe(DRB2_ROW.prompt);
    expect(t?.exclude.titles).toEqual([DRB2_ROW.content.blocked.title]);
    expect(t?.exclude.urls).toContain("https://www.mdpi.com/2073-445X/11/9/1529");
    expect(t?.exclude.urls).toContain("huggingface.co/datasets/muset-ai");
    expect(JSON.stringify(t)).not.toContain("SECRET RUBRIC ITEM");
  });

  it("DRB I tasks bar the benchmark's own published pages", () => {
    const [t] = parseDrb1('{"id": 51, "topic": "Finance", "language": "en", "prompt": "Q"}\n');
    expect(t).toMatchObject({ id: "51", language: "en", prompt: "Q", topic: "Finance" });
    expect(t?.exclude.urls).toEqual([...BENCHMARK_SELF_EXCLUSIONS]);
  });

  it("the split is seeded, balanced by language, and leaves non-commercial tasks out", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...DRB2_ROW,
      idx: i + 1,
      language: i % 2 ? "en" : "zh",
      license: i === 3 ? "CC BY-NC 4.0" : "CC BY 4.0",
    }));
    const tasks = parseDrb2(rows.map((r) => JSON.stringify(r)).join("\n"));
    const a = selectSplit(tasks, "seed", { dev: 1, heldout: 3 });
    expect(a).toEqual(selectSplit(tasks, "seed", { dev: 1, heldout: 3 }));
    expect(a.dev).toHaveLength(2);
    expect(a.heldout).toHaveLength(6);
    expect(new Set([...a.dev, ...a.heldout]).size).toBe(8);
    const all = selectSplit(tasks, "seed", { dev: 0, heldout: 20 });
    expect(all.heldout).not.toContain("idx-4");
    expect(
      selectSplit(tasks, "seed", { dev: 0, heldout: 20 }, { includeNonCommercial: true }).heldout,
    ).toContain("idx-4");
    expect(selectSplit(tasks, "other", { dev: 1, heldout: 3 }).heldout).not.toEqual(a.heldout);
  });
});

describe("DRB II per-task scores (aggregate_scores.py arithmetic)", () => {
  it("counts 1 as pass, -1 as blocked, 0 as neither, over all rubric items", () => {
    const dims = drb2TaskScores({
      scores: {
        info_recall: { a: { score: 1 }, b: { score: 0 }, c: { score: -1 }, d: { score: 1 } },
        analysis: { e: { score: 1 } },
        presentation: {},
      },
    });
    expect(dims).toEqual({
      inforecall: 0.5,
      analysis: 1,
      presentation: null,
      total: 3 / 5,
      blocked_rate: 1 / 5,
    });
    expect(drb2TaskScores({ error: "batch failed" }).total).toBeNull();
  });
});

describe("judge proxy", () => {
  it("forwards allowed judges with the real key, meters cost, and stops at the cap", async () => {
    const seen: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
    const proxy = startJudgeProxy({
      apiKey: "real-key",
      maxUsd: 0.05,
      allowModels: ["openai/gpt-5.5"],
      fetcher: (async (_url: string, init: RequestInit) => {
        seen.push({
          auth: new Headers(init.headers).get("authorization"),
          body: JSON.parse(String(init.body)),
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { cost: 0.03, prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    try {
      const call = (model: string) =>
        fetch(`${proxy.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer dummy", "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }),
        });
      expect((await call("openai/gpt-5.5")).status).toBe(200);
      expect(seen[0]?.auth).toBe("Bearer real-key");
      expect(seen[0]?.body.usage).toEqual({ include: true });
      expect((await call("anthropic/other")).status).toBe(403);
      expect((await call("openai/gpt-5.5")).status).toBe(200);
      const refused = await call("openai/gpt-5.5");
      expect(refused.status).toBe(429);
      expect(await refused.text()).toContain("spend_cap_reached");
      expect(proxy.spentUsd()).toBeCloseTo(0.06);
      expect(spentTodayUsd()).toBeCloseTo(0.06);
      expect(proxy.calls()).toEqual({ ok: 2, refused: 2, failed: 0 });
      expect(proxy.byModel()["openai/gpt-5.5"]).toMatchObject({ calls: 2, promptTokens: 20 });
    } finally {
      proxy.stop();
    }
  });
});

function record(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    board: "drb2",
    language: "en",
    label: "A",
    lead: "openrouter/anthropic/claude-opus-5.5",
    startedAt: "2026-10-05T00:00:00Z",
    finishedAt: "2026-10-05T00:10:00Z",
    latencyMs: 600_000,
    cost: { leadUsd: 1, checkerUsd: 0, searchUsd: 0.2, totalUsd: 1.2 },
    lessons: 0,
    ...over,
  };
}

describe("records", () => {
  it("files ids and scores into the ledger, and outcomes keep the prompt private", () => {
    const db = new MarinaDB(":memory:");
    try {
      const scores = [
        {
          id: "idx-1",
          score: 0.62,
          dims: { inforecall: 0.5, analysis: 0.8, presentation: 1, total: 0.62 },
        },
        {
          id: "idx-2",
          score: 0.31,
          dims: { inforecall: 0.2, analysis: 0.5, presentation: 0.9, total: 0.31 },
        },
      ];
      const run = recordScoredRun(db, {
        board: "drb2",
        label: "A",
        records: [record("idx-1"), record("idx-2")],
        scores,
        judge: "official",
        judgeUsd: 1.5,
      });
      expect(run.created).toBe(true);
      const items = db.getBenchmarkItems(run.id);
      expect(items.map((i) => [i.item_id, i.correct, i.score])).toEqual([
        ["idx-1", 1, 0.62],
        ["idx-2", 0, 0.31],
      ]);
      const stored = JSON.stringify(db.getBenchmarkRun(run.id));
      expect(stored).toContain("deepresearch-bench-ii");

      const outcome = reportOutcome({
        board: "drb2",
        record: record("idx-2"),
        score: scores[1]!,
        topic: "Finance & Business",
        prompt: "THE SECRET PROMPT TEXT",
        resolvedAt: "2026-10-05T01:00:00Z",
      });
      expect(outcome).toMatchObject({ domain: "research", succeeded: false, score: 0.31 });
      expect(outcome.detail).toContain("weakest inforecall");
      const { privateContext, ...shown } = outcome;
      expect(privateContext).toBe("THE SECRET PROMPT TEXT");
      expect(JSON.stringify(shown)).not.toContain("SECRET");
    } finally {
      db.close();
    }
  });

  it("pairs arms by task, averaging replicates within a task first", () => {
    const a = new Map([
      ["1", [40, 44]],
      ["2", [50]],
      ["3", [30]],
    ]);
    const b = new Map([
      ["1", [45]],
      ["2", [50]],
      ["4", [99]],
    ]);
    const d = pairedDifference(a, b);
    expect(d.n).toBe(2);
    expect(d.mean).toBeCloseTo(1.5);
    expect([d.wins, d.losses, d.ties]).toEqual([1, 0, 1]);
  });
});
