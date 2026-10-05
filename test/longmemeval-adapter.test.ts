// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun, summarize, toHarness } from "../benchmarks/longmemeval/convert";
import {
  excerpt,
  type LmeTrajectory,
  MAX_RECORD_BYTES,
  renderContext,
  trajectoryRecords,
  truncateBytes,
} from "../benchmarks/longmemeval/records";
import { LME_ACCOUNT, LmeMemoryStore } from "../benchmarks/longmemeval/store";
import { residentMemoryOperation } from "../src/memory/resident-service";

const run = (id: string, goal: string, outcome: string, pages: string[]): LmeTrajectory => ({
  id,
  domain: "web",
  goal,
  outcome,
  start_url: `http://shop.test/${id}`,
  states: pages.map((page, i) => ({
    state_index: i,
    step: i,
    url: `http://shop.test/${id}/${i}`,
    action: i === 0 ? null : `click('${i}')`,
    thought: `step ${i} of ${goal}`,
    accessibility_tree: page,
  })),
});

describe("LongMemEval records", () => {
  it("one observation per state plus one episode, each under the canonical byte limit", () => {
    const huge = "x".repeat(200_000);
    const records = trajectoryRecords(run("t1", "buy socks", "success", ["home", huge]));
    expect(records.map((r) => r.kind)).toEqual(["state", "state", "episode"]);
    expect(records.map((r) => r.key)).toEqual(["lme:t1:0", "lme:t1:1", "lme:t1:episode"]);
    for (const r of records) {
      expect(Buffer.byteLength(r.input.content)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
      expect(r.input.metadata.trajectory_id).toBe("t1");
    }
    expect(records[0]!.input.content).toContain("goal: buy socks");
    expect(records[2]!.input.content).toContain("outcome: success");
    expect(records[2]!.input.content).toContain("click('1')");
  });

  it("truncates by bytes without splitting a character", () => {
    const text = "é".repeat(100);
    const cut = truncateBytes(text, 51);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(51);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncateBytes("short", 100)).toBe("short");
  });

  it("an excerpt keeps the header and the lines that match the query", () => {
    const body = Array.from({ length: 500 }, (_, i) =>
      i === 321 ? "[77] button 'Apply coupon'" : `[${i}] generic filler row ${i}`,
    );
    const content = ["h1", "h2", "h3", "h4", "h5", "h6", ...body].join("\n");
    const out = excerpt(content, "Where is the apply coupon button?", 600);
    expect(out.startsWith("h1\nh2")).toBe(true);
    expect(out).toContain("Apply coupon");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(600);
  });

  it("renders slices in rank order within the budget, never repeating a state", async () => {
    const t = run("t9", "check order", "failure", ["p0", "p1", "p2", "p3"]);
    const records = trajectoryRecords(t);
    const byKey = new Map(records.map((r, i) => [r.key, { id: `r${i}`, ...r.input }]));
    const lookup = {
      state: async (tid: string, i: number) => byKey.get(`lme:${tid}:${i}`),
      episode: async (tid: string) => byKey.get(`lme:${tid}:episode`),
      stateCount: () => 4,
    };
    const hits = [byKey.get("lme:t9:2")!, byKey.get("lme:t9:1")!];
    const { blocks, used } = await renderContext(hits, "order", lookup, {
      contextBytes: 20_000,
      stateBytes: 2_000,
      episodeBytes: 1_000,
      radius: 1,
    });
    expect(blocks).toHaveLength(1); // state 1 was already shown in state 2's slice
    expect(blocks[0]).toContain("around state 3");
    expect(new Set(used).size).toBe(used.length);
    expect(used).toContain("r4"); // the run's episode summary
  });
});

describe("LongMemEval store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-lme-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests canonical records and answers through the resident search", async () => {
    const store = LmeMemoryStore.open(join(dir, "m.db"));
    try {
      store.insert(
        run("a1", "change the store email", "success", ["Settings page", "Email field"]),
      );
      store.insert(
        run("b2", "find the pelican coupon", "failure", [
          "Home",
          "[12] link 'Pelican promo' coupon code PEL-42",
        ]),
      );
      expect(() => store.insert(run("a1", "dup", "success", ["x"]))).toThrow(/duplicate/);
      expect(store.stats()).toEqual({ trajectories: 2, records: 6 });
      // The records are canonical: the resident binding finds them.
      const search = await residentMemoryOperation(store.db, LME_ACCOUNT, {
        operation: "search",
        input: { query: "pelican coupon", limit: 5 },
      });
      expect((search.result as { results: unknown[] }).results.length).toBeGreaterThan(0);
      const q = await store.query("What is the pelican coupon code?");
      expect(q.hits).toBeGreaterThan(0);
      expect(q.items[0]!.value).toContain("not instructions");
      expect(q.items.some((i) => i.value.includes("PEL-42"))).toBe(true);
      expect(q.items.some((i) => i.value.includes("store email"))).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("refuses hybrid without an embedding provider", () => {
    expect(() =>
      LmeMemoryStore.open(join(dir, "h.db"), {
        mode: "hybrid",
        searchLimit: 10,
        context: { contextBytes: 4096, stateBytes: 1024, episodeBytes: 1024, radius: 1 },
      }),
    ).toThrow(/MARINA_MEMORY_EMBEDDINGS/);
  });
});

describe("LongMemEval ledger conversion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-lme-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (domain: string, rows: Record<string, unknown>[]) => {
    const d = join(dir, `marina_lexical_${domain}_small`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "run_args.json"),
      JSON.stringify({ domain, model: "openrouter/qwen/qwen3.5-9b", evaluator_model: "gpt-5.2" }),
    );
    writeFileSync(join(d, "per_question.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    return d;
  };

  it("keeps ids and verdicts only, and pools both domains like the board", () => {
    const secret = "THE GOLD ANSWER";
    const web = write("web", [
      {
        question_id: "q1",
        category: "static",
        score_bool: true,
        is_unknown: false,
        is_abstention_problem: false,
        memory_query_duration_seconds: 0.02,
        answer_gold: secret,
        question_text: secret,
        response_raw: secret,
      },
      {
        question_id: "q2",
        category: "static-abs",
        score_bool: false,
        is_unknown: false,
        is_abstention_problem: true,
        memory_query_duration_seconds: 0.04,
      },
    ]);
    const ent = write("enterprise", [
      {
        question_id: "q3",
        category: "procedure",
        score_bool: false,
        is_unknown: true,
        is_abstention_problem: false,
        memory_query_duration_seconds: 0.03,
      },
    ]);
    const runs = [readRun(web), readRun(ent)];
    const s = summarize(runs);
    expect(s.questions).toBe(3);
    expect(s.accuracy).toBeCloseTo(100 / 3, 6);
    expect(s.latencySeconds).toBeCloseTo(0.03, 6);
    expect(s.abstentionAnsweredWrongRate).toBe(1);
    expect(s.unknownRate).toBeCloseTo(1 / 3, 6);
    const file = toHarness(runs, { benchmark: "longmemeval-v2-small", target: "marina:lexical" });
    expect(file.items?.map((i) => i.id).sort()).toEqual(["enterprise:q3", "web:q1", "web:q2"]);
    expect(JSON.stringify(file)).not.toContain(secret);
  });
});
