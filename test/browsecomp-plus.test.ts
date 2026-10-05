// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BrowseComp-Plus adapter (benchmarks/browsecomp-plus/): the official judge
 * parsing, citation extraction, recall and calibration ports, the tool loop
 * against a scripted model endpoint over a synthetic corpus, the crew shape,
 * judging, the leaderboard summary and the content-free ledger result.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentOptions,
  crewPrompt,
  executeTool,
  runCrew,
  runToolAgent,
  shapeFor,
  shardOf,
  toolSchemas,
} from "../benchmarks/browsecomp-plus/agent";
import { workerPool } from "../benchmarks/browsecomp-plus/corpus-pool";
import {
  leadPrompt,
  parseAngles,
  parseFormation,
  runFormation,
} from "../benchmarks/browsecomp-plus/formations";
import {
  calibrationError,
  extractCitations,
  GRADER_TEMPLATE,
  graderPrompt,
  parseJudgeResponse,
  parseQrels,
  QUERY_TEMPLATE,
  queryPrompt,
  retrievalRecall,
  retrievedDocids,
  summarize,
} from "../benchmarks/browsecomp-plus/official";
import {
  type ArmConfig,
  prepareReplicateDir,
  readFiled,
  resolveArmGroup,
  runArm,
  sampleQueries,
  toBenchmarkResult,
  writeFiled,
} from "../benchmarks/browsecomp-plus/run";
import {
  BudgetExhausted,
  CallSpendGuard,
  isSpendCapRefusal,
  parseMaxUsd,
} from "../benchmarks/call-spend-guard";
import { ledgerFileBody } from "../benchmarks/ledger-file";
import { buildCorpus, closeCorpora } from "../src/engine/search-providers/corpus";

const DOCS = [
  {
    docid: "101",
    title: "Harbour history",
    text: "The old harbour of Port Wren was dredged in 1911 by the engineer Ada Morrow.",
  },
  {
    docid: "102",
    title: "Morrow biography",
    text: "Ada Morrow (1870–1944) was a civil engineer born in Galway.",
  },
  { docid: "103", title: "Recipes", text: "Soda bread needs buttermilk and baking soda." },
];

let dir: string;
let opts: AgentOptions;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "marina-bcp-test-"));
  await buildCorpus("syn", DOCS, { dir, source: "synthetic" });
  opts = {
    corpus: "syn",
    corpusDir: dir,
    k: 5,
    snippetChars: 40,
    docChars: 1000,
    maxTurns: 6,
    timeoutMs: 5000,
  };
});

afterAll(() => {
  closeCorpora();
  rmSync(dir, { recursive: true, force: true });
});

/** A scripted OpenAI-compatible endpoint: replies in order, records requests. */
function scripted(replies: Record<string, unknown>[], headers: Record<string, string> = {}) {
  const requests: Record<string, unknown>[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const message = replies[Math.min(i++, replies.length - 1)];
    return new Response(
      JSON.stringify({
        choices: [{ message, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
      {
        status: 200,
        headers: { "x-marina-cost-usd": "0.01", "x-request-id": `req-${i}`, ...headers },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

describe("official ports", () => {
  it("keeps the official prompts", () => {
    expect(queryPrompt("Q?")).toContain("Question: Q?");
    expect(QUERY_TEMPLATE).toContain("Exact Answer: {your succinct, final answer}");
    expect(GRADER_TEMPLATE).toContain("0|\\%| and 100|\\%|");
    const g = graderPrompt("q", "r", "a");
    expect(g).toContain("[question]: q\n\n[response]: r\n\n[correct_answer]: a");
  });

  it("parses the judge's plain and bold verdicts", () => {
    expect(
      parseJudgeResponse(
        "extracted_final_answer: Ada\nreasoning: same\ncorrect: yes\nconfidence: 85%",
      ),
    ).toEqual({
      extractedFinalAnswer: "Ada",
      correct: true,
      confidence: 85,
      parseError: false,
    });
    const bold = parseJudgeResponse("**correct:** No\n**confidence:** 140");
    expect(bold.correct).toBe(false);
    expect(bold.confidence).toBe(100);
    expect(parseJudgeResponse("I am not sure").parseError).toBe(true);
  });

  it("extracts citations, qrels, retrieved docids and recall", () => {
    expect(extractCitations("A [12]. B [34, 56]. C 【7】. D [see note]").sort()).toEqual([
      "12",
      "34",
      "56",
      "7",
    ]);
    const qrels = parseQrels("1 Q0 101 1\n1 Q0 102 1\n2 Q0 9 0\n");
    expect(qrels.get("1")).toEqual(["101", "102"]);
    expect(qrels.has("2")).toBe(false);
    expect(retrievalRecall(["101", "999"], qrels.get("1"))).toBe(0.5);
    expect(retrievalRecall(["101"], undefined)).toBeUndefined();
    expect(
      retrievedDocids([
        {
          type: "tool_call",
          tool_name: "search",
          arguments: "{}",
          output: '[{"docid":"5"},{"docid":"6"}]',
        },
        { type: "tool_call", tool_name: "get_document", arguments: "{}", output: '{"docid":"7"}' },
      ]),
    ).toEqual(["5", "6"]);
  });

  it("computes the binned calibration error with the official last-bin quirk", () => {
    const conf = Array.from({ length: 150 }, () => 0.9);
    const right = Array.from({ length: 150 }, () => false);
    expect(calibrationError(conf, right)).toBe(0); // one bin, skipped
    const conf2 = [...Array(100).fill(1), ...Array(100).fill(0.5)];
    const right2 = [...Array(100).fill(false), ...Array(100).fill(true)];
    // Sorted ascending: first bin = the 0.5s (all correct) → |0.5 − 1| = 0.5, weight 1/2.
    expect(calibrationError(conf2, right2)).toBeCloseTo(Math.sqrt(0.5 * 0.25), 10);
  });

  it("summarizes like evaluate_run.py", () => {
    const s = summarize(
      [
        {
          query_id: "1",
          correct: true,
          confidence: 90,
          parseError: false,
          recall: 1,
          searchCalls: 3,
          toolCallCounts: {},
          citedDocids: [],
        },
        {
          query_id: "2",
          correct: false,
          confidence: null,
          parseError: true,
          recall: 0.5,
          searchCalls: 1,
          toolCallCounts: {},
          citedDocids: [],
        },
        {
          query_id: "3",
          correct: false,
          confidence: 20,
          parseError: false,
          searchCalls: 2,
          toolCallCounts: {},
          citedDocids: [],
        },
      ],
      { llm: "m", retriever: "r", link: "l", date: "2026-10-02" },
    );
    expect(s["Accuracy (%)"]).toBe(33.33);
    expect(s["Recall (%)"]).toBe(75);
    expect(s["Search Calls"]).toBe(2);
    expect(s["Calibration Error (%)"]).toBe(0);
    expect(s.per_query_metrics[2]).toEqual({ query_id: "3", correct: false, recall: null });
  });
});

describe("agent loop", () => {
  it("serves search and get_document from the corpus", async () => {
    const tool = async (name: string, args: string) =>
      JSON.parse(await executeTool(name, args, opts)) as Record<string, unknown>;
    const hits = JSON.parse(
      await executeTool("search", '{"query":"Ada Morrow engineer"}', opts),
    ) as {
      docid: string;
      snippet: string;
    }[];
    expect(hits.map((h) => h.docid)).toContain("102");
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(40);
    expect((await tool("get_document", '{"docid":"101"}')).text).toContain("1911");
    expect((await tool("get_document", '{"docid":"nope"}')).error).toContain("not found");
    expect((await tool("search", "not json")).error).toBeDefined();
  });

  it("restricts a sharded search to its own shard", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const hits = JSON.parse(
        await executeTool("search", '{"query":"Ada Morrow harbour soda bread"}', opts, {
          index: i,
          of: 2,
        }),
      ) as { docid: string }[];
      for (const h of hits) {
        expect(shardOf(h.docid, 2)).toBe(i);
        seen.add(h.docid);
      }
    }
    // Together the shards cover every matching document.
    expect([...seen].sort()).toEqual(["101", "102", "103"]);
  });

  it("answers tool calls from a worker pool", async () => {
    const pool = workerPool("syn", dir, 2);
    try {
      const hits = await pool.search("Galway engineer", 3, 20);
      expect(hits[0]!.docid).toBe("102");
      expect((await pool.get("101", 1000))?.text).toContain("1911");
      expect(await pool.get("nope", 10)).toBeUndefined();
    } finally {
      pool.close();
    }
  });

  it("runs tools until a text answer and records the official run format", async () => {
    const { fetchFn, requests } = scripted([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "search", { query: "Port Wren harbour dredged" })],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c2", "get_document", { docid: "102" })],
      },
      {
        role: "assistant",
        content:
          "Explanation: dredged by Morrow [101], born in Galway [102].\nExact Answer: Galway\nConfidence: 80%",
      },
    ]);
    const run = await runToolAgent(
      { baseUrl: "http://m", apiKey: "k", fetch: fetchFn },
      "openrouter/x",
      "7",
      "Where was the engineer born?",
      opts,
    );
    expect(run.record.status).toBe("completed");
    expect(run.record.tool_call_counts).toEqual({ search: 1, get_document: 1 });
    expect(run.record.retrieved_docids).toContain("101");
    expect(run.record.result.at(-1)!.type).toBe("output_text");
    expect(run.costUsd).toBeCloseTo(0.03, 10);
    expect(run.traceIds).toEqual(["req-1", "req-2", "req-3"]);
    expect((requests[0]!.tools as unknown[]).length).toBe(2);
    // The tool reply goes back to the model on the next turn.
    const second = requests[1]!.messages as { role: string; tool_call_id?: string }[];
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("marks a run that hits the turn cap incomplete", async () => {
    const { fetchFn } = scripted([
      { role: "assistant", content: null, tool_calls: [call("c", "search", { query: "bread" })] },
    ]);
    const run = await runToolAgent({ baseUrl: "http://m", fetch: fetchFn }, "m", "1", "q", {
      ...opts,
      maxTurns: 2,
    });
    expect(run.record.status).toBe("incomplete");
    expect(run.calls).toBe(2);
  });

  it("asks a crew in text and measures recall on cited docids", async () => {
    expect(shapeFor("marina:answerer")).toBe("crew");
    expect(shapeFor("marina/verify:openrouter/x")).toBe("tools");
    expect(crewPrompt("Q?", "syn")).toContain("web search engines:corpus:syn");
    const { fetchFn, requests } = scripted([
      { role: "assistant", content: "Explanation: [102]\nExact Answer: Galway\nConfidence: 70%" },
    ]);
    const run = await runCrew(
      { baseUrl: "http://m", fetch: fetchFn },
      "marina:answerer",
      "7",
      "Q?",
      opts,
    );
    expect(run.record.retrieved_docids).toEqual(["102"]);
    expect(run.record.metadata.recall_source).toBe("cited");
    expect(requests[0]!.tools).toBeUndefined();
  });
});

describe("formations", () => {
  it("parses formation specs", () => {
    expect(parseFormation("single")).toEqual({ kind: "single", agents: 1, rounds: 1 });
    expect(parseFormation("ensemble:3")).toEqual({ kind: "ensemble", agents: 3, rounds: 1 });
    expect(parseFormation("blackboard:4x3")).toEqual({ kind: "blackboard", agents: 4, rounds: 3 });
    expect(() => parseFormation("swarm:2")).toThrow("unknown formation");
    expect(() => parseFormation("ensemble:1")).toThrow("2–16");
  });

  it("parses the planner's angles and falls back when it cannot", () => {
    expect(parseAngles('Plan: ["clue A", "clue B"]', 3)).toEqual(["clue A", "clue B", "clue A"]);
    expect(parseAngles("no json here", 2)[1]).toContain("clue number 2");
  });

  it("runs an ensemble: researchers in parallel, then a lead that answers", async () => {
    const seen: { model: string; prompt: string }[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        messages: { content: string }[];
      };
      const prompt = body.messages[0]!.content;
      seen.push({ model: body.model, prompt });
      const isLead = prompt.startsWith("You lead a research team");
      const message =
        !isLead && body.messages.length === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [call("c", "search", { query: "Morrow" })],
            }
          : {
              role: "assistant",
              content: isLead
                ? "Explanation: both agree [102].\nExact Answer: Galway\nConfidence: 85%"
                : "Explanation: [102]\nExact Answer: Galway\nConfidence: 70%",
            };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "x-marina-cost-usd": "0.01" },
      });
    }) as unknown as typeof fetch;
    const run = await runFormation(
      { baseUrl: "http://m", fetch: fetchFn },
      parseFormation("ensemble:2"),
      "7",
      "Where was the engineer born?",
      opts,
      { model: "small", leadModel: "big", leadTurns: 3 },
    );
    expect(run.record.status).toBe("completed");
    expect(run.record.metadata).toMatchObject({ formation: "ensemble:2", lead_model: "big" });
    expect(run.record.tool_call_counts.search).toBe(2);
    expect(run.record.result.at(-1)).toMatchObject({ type: "output_text", agent: "lead" });
    expect(String(run.record.result.at(-1)!.output)).toContain("both agree");
    expect(seen.find((c) => c.model === "big")!.prompt).toContain("[Researcher 2]");
    expect(run.costUsd).toBeCloseTo(0.05, 10); // 2 researchers × 2 turns + 1 lead turn
    expect(leadPrompt("Q", [])).toContain("no researcher produced a report");
  });
});

describe("arm run", () => {
  it("answers, judges, writes the official artifacts and a content-free ledger result", async () => {
    const out = join(dir, "arm");
    const agentReplies = [
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "search", { query: "Ada Morrow born" })],
      },
      { role: "assistant", content: "Explanation: [102]\nExact Answer: Galway\nConfidence: 90%" },
    ];
    let i = 0;
    const judgeBodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const isJudge = body.model === "judge/qwen";
      if (isJudge) judgeBodies.push(body);
      const message = isJudge
        ? {
            role: "assistant",
            content: "extracted_final_answer: Galway\ncorrect: yes\nconfidence: 90%",
          }
        : agentReplies[i++ % agentReplies.length];
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "x-marina-cost-usd": isJudge ? "0.001" : "0.02" },
      });
    }) as unknown as typeof fetch;
    const endpoint = { baseUrl: "http://m", fetch: fetchFn };
    const queries = [{ query_id: "7", query: "SECRET QUESTION", answer: "SECRET ANSWER" }];
    const arm = await runArm(queries, {
      model: "openrouter/x",
      endpoint,
      agent: opts,
      judge: { endpoint, model: "judge/qwen", timeoutMs: 5000 },
      concurrency: 2,
      qrels: new Map([["7", ["102", "101"]]]),
      outDir: out,
    });
    expect(arm.items[0]!.eval).toMatchObject({
      correct: true,
      confidence: 90,
      searchCalls: 1,
      recall: 1, // the search returned both evidence documents
    });
    expect(judgeBodies[0]).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      max_tokens: 4096,
      reasoning: { enabled: false },
    });
    expect(existsSync(join(out, "runs", "run_7.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(out, "evals", "run_7_eval.json"), "utf8")).judge_result.correct,
    ).toBe(true);
    const result = toBenchmarkResult(arm, {
      endpoint: "http://m",
      judgeModel: "judge/qwen",
      concurrency: 2,
      seed: 1,
    });
    expect(result.config.name).toBe("browsecomp-plus");
    expect(result.items[0]).toMatchObject({ id: "7", correct: true, judge: "correct" });
    const filed = JSON.stringify(
      ledgerFileBody(result, { fileTo: "http://m", targetKind: "model", target: "openrouter/x" }),
    );
    expect(filed).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("samples a stable seeded subset", () => {
    const qs = Array.from({ length: 50 }, (_, i) => ({
      query_id: String(i + 1),
      query: "",
      answer: "",
    }));
    const a = sampleQueries(qs, 10, 3).map((q) => q.query_id);
    expect(a).toEqual(sampleQueries([...qs].reverse(), 10, 3).map((q) => q.query_id));
    expect(a).not.toEqual(sampleQueries(qs, 10, 4).map((q) => q.query_id));
    expect(sampleQueries(qs, undefined, 1)).toHaveLength(50);
    // A held-out split at the next offset of the same shuffle is disjoint.
    const held = sampleQueries(qs, 10, 3, 10).map((q) => q.query_id);
    expect(held).toHaveLength(10);
    expect(held.filter((id) => a.includes(id))).toEqual([]);
  });
});

describe("spend guard", () => {
  it("trips at the cap, on the server's daily cap, and validates --max-usd", () => {
    const g = new CallSpendGuard(0.05);
    g.add(0.02);
    g.add(Number.NaN);
    expect(g.stoppedBy).toBeUndefined();
    g.add(0.03);
    expect(g.stoppedBy).toContain("$0.05");
    expect(() => g.check()).toThrow(BudgetExhausted);
    const s = new CallSpendGuard();
    s.trip("server cap");
    expect(() => s.check()).toThrow("server cap");
    expect(isSpendCapRefusal(429, '{"error":{"code":"spend_cap_reached"}}')).toBe(true);
    expect(isSpendCapRefusal(429, '{"error":{"code":"rate_limited"}}')).toBe(false);
    expect(parseMaxUsd(undefined)).toBeUndefined();
    expect(parseMaxUsd("2.5")).toBe(2.5);
    expect(() => parseMaxUsd("0")).toThrow();
    expect(() => parseMaxUsd("abc")).toThrow();
  });

  /** An agent that searches forever at $0.02 a call; the judge costs $0.001. */
  function looping(status = 200, body?: string) {
    let calls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls++;
      const req = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body) return new Response(body, { status, headers: { "x-marina-cost-usd": "0" } });
      const message =
        req.model === "judge/qwen"
          ? { role: "assistant", content: "correct: yes" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [call(`c${calls}`, "search", { query: "harbour" })],
            };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "x-marina-cost-usd": "0.02" },
      });
    }) as unknown as typeof fetch;
    return { fetchFn, calls: () => calls };
  }

  it("stops an arm cleanly: stopped queries are not run, never scored, never written", async () => {
    const out = join(dir, "guarded");
    const { fetchFn, calls } = looping();
    const guard = new CallSpendGuard(0.1);
    const endpoint = { baseUrl: "http://m", fetch: fetchFn, guard };
    const queries = ["1", "2", "3"].map((id) => ({ query_id: id, query: "q", answer: "a" }));
    const arm = await runArm(queries, {
      model: "openrouter/x",
      endpoint,
      agent: { ...opts, maxTurns: 4 },
      judge: { endpoint, model: "judge/qwen", timeoutMs: 5000 },
      concurrency: 1,
      outDir: out,
    });
    // Query 1 hits the 4-turn cap ($0.08, a genuine incomplete); query 2 is cut by the cap.
    expect(arm.items.map((i) => i.query.query_id)).toEqual(["1"]);
    expect(arm.items[0]!.run.record.status).toBe("incomplete");
    expect(arm.notRun).toEqual(["2", "3"]);
    expect(arm.stoppedBy).toContain("spend cap $0.1");
    expect(guard.spent).toBeCloseTo(0.1, 6);
    expect(calls()).toBe(5);
    expect(existsSync(join(out, "runs", "run_1.json"))).toBe(true);
    expect(existsSync(join(out, "runs", "run_2.json"))).toBe(false);
    expect(existsSync(join(out, "evals", "run_2_eval.json"))).toBe(false);
  });

  it("stops a formation, not just one researcher, and treats the server cap as a stop", async () => {
    const { fetchFn } = looping(
      429,
      JSON.stringify({ error: { message: "daily cap", code: "spend_cap_reached" } }),
    );
    const guard = new CallSpendGuard();
    const run = await runFormation(
      { baseUrl: "http://m", fetch: fetchFn, guard },
      parseFormation("ensemble:2"),
      "9",
      "q",
      opts,
      { model: "openrouter/x", leadTurns: 2 },
    );
    expect(run.stoppedBy).toContain("daily spend cap");
    expect(run.record.status).toBe("incomplete");
    expect(run.record.metadata.stopped_by).toBeDefined();
  });

  it("resumes: answered queries are reused, not re-run or re-paid", async () => {
    const out = join(dir, "resume");
    const answer = { role: "assistant", content: "Exact Answer: Galway\nConfidence: 80%" };
    let agentCalls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (req.model !== "judge/qwen") agentCalls++;
      const message =
        req.model === "judge/qwen"
          ? { role: "assistant", content: "extracted_final_answer: Galway\ncorrect: yes" }
          : answer;
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "x-marina-cost-usd": "0.01" },
      });
    }) as unknown as typeof fetch;
    const endpoint = { baseUrl: "http://m", fetch: fetchFn };
    const queries = ["1", "2"].map((id) => ({ query_id: id, query: "q", answer: "Galway" }));
    const base = {
      model: "openrouter/x",
      endpoint,
      agent: opts,
      judge: { endpoint, model: "judge/qwen", timeoutMs: 5000 },
      concurrency: 1,
      outDir: out,
    };
    await runArm(queries.slice(0, 1), base);
    expect(agentCalls).toBe(1);
    const arm = await runArm(queries, { ...base, resume: true });
    expect(agentCalls).toBe(2);
    expect(arm.resumed).toEqual(["1"]);
    expect(arm.items.map((i) => [i.query.query_id, i.eval.correct])).toEqual([
      ["1", true],
      ["2", true],
    ]);
    expect(arm.costUsd).toBeCloseTo(0.02, 6);
  });

  it("resume re-runs errored and judge-errored queries, and reuses genuine outcomes", async () => {
    const out = join(dir, "resume-errors");
    let outage = true;
    let agentCalls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as Record<string, unknown>;
      const judging = req.model === "judge/qwen";
      if (!judging) agentCalls++;
      const prompt = JSON.stringify(req.messages);
      // During the outage query 1's agent call and query 2's judge call fail.
      if (
        outage &&
        ((!judging && prompt.includes("query one")) || (judging && prompt.includes("query two")))
      ) {
        return new Response("upstream down", { status: 502 });
      }
      const message = judging
        ? { role: "assistant", content: "extracted_final_answer: Galway\ncorrect: yes" }
        : { role: "assistant", content: "Exact Answer: Galway\nConfidence: 80%" };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "x-marina-cost-usd": "0.01" },
      });
    }) as unknown as typeof fetch;
    const endpoint = { baseUrl: "http://m", fetch: fetchFn };
    const queries = [
      { query_id: "1", query: "query one", answer: "Galway" },
      { query_id: "2", query: "query two", answer: "Galway" },
      { query_id: "3", query: "query three", answer: "Galway" },
    ];
    const base = {
      model: "openrouter/x",
      endpoint,
      agent: opts,
      judge: { endpoint, model: "judge/qwen", timeoutMs: 5000 },
      concurrency: 1,
      outDir: out,
    };
    const first = await runArm(queries, base);
    expect(first.items.map((i) => [i.query.query_id, i.eval.correct])).toEqual([
      ["1", false],
      ["2", false],
      ["3", true],
    ]);
    outage = false;
    const callsBefore = agentCalls;
    const again = await runArm(queries, { ...base, resume: true });
    // Only query 3 is reused; the run error and the judge error are run again.
    expect(again.resumed).toEqual(["3"]);
    expect(again.retried.sort()).toEqual(["1", "2"]);
    expect(agentCalls - callsBefore).toBe(2);
    expect(again.items.map((i) => i.eval.correct)).toEqual([true, true, true]);
  });

  const config = (over: Partial<ArmConfig> = {}): ArmConfig => ({
    model: "openrouter/x",
    formation: "single",
    leadModel: null,
    leadTurns: 12,
    judgeModel: "judge/qwen",
    corpus: "browsecomp-plus",
    k: 5,
    snippetChars: 512,
    docChars: 20000,
    maxTurns: 30,
    maxTokens: null,
    seed: 1,
    offset: 0,
    limit: 10,
    queriesHash: "abc",
    ...over,
  });

  it("refuses to resume a replicate under another configuration", () => {
    const rep = join(dir, "cfg", "rep1");
    expect(prepareReplicateDir(rep, config(), false).adopted).toBe(false);
    expect(prepareReplicateDir(rep, config(), true).adopted).toBe(false);
    for (const change of [
      { judgeModel: "judge/other" },
      { k: 10 },
      { maxTurns: 12 },
      { seed: 2 },
      { queriesHash: "def" },
    ] satisfies Partial<ArmConfig>[]) {
      expect(() => prepareReplicateDir(rep, config(change), true)).toThrow(
        `different configuration (${Object.keys(change)[0]})`,
      );
    }
    // Without --resume the replicate starts over and records the new configuration;
    // an earlier filing marker no longer describes it.
    writeFiled(rep, { runId: "bench_old", group: "g" });
    prepareReplicateDir(rep, config({ k: 10 }), false);
    expect(readFiled(rep)).toBeUndefined();
    expect(() => prepareReplicateDir(rep, config({ k: 10 }), true)).not.toThrow();
  });

  it("adopts a replicate directory from before the configuration was recorded", () => {
    const rep = join(dir, "legacy", "rep1");
    mkdirSync(join(rep, "runs"), { recursive: true });
    expect(prepareReplicateDir(rep, config(), true).adopted).toBe(true);
    expect(() => prepareReplicateDir(rep, config({ k: 3 }), true)).toThrow("different");
  });

  it("a resumed arm keeps its replicate group, so new replicates join the filed ones", () => {
    const out = join(dir, "grouped");
    const reps = [join(out, "rep1"), join(out, "rep2")];
    let fresh = 0;
    const next = () => `rep:g:${++fresh}`;
    expect(resolveArmGroup(out, { resume: false, replicateDirs: reps, fresh: next })).toBe(
      "rep:g:1",
    );
    // An interrupted run resumed later files rep 2 into the SAME group.
    expect(resolveArmGroup(out, { resume: true, replicateDirs: reps, fresh: next })).toBe(
      "rep:g:1",
    );
    expect(() =>
      resolveArmGroup(out, { explicit: "other", resume: true, replicateDirs: reps, fresh: next }),
    ).toThrow("files into group rep:g:1");
    // A directory with only a filing marker (no group.json) recovers the group from it.
    const old = join(dir, "marker-only");
    const oldReps = [join(old, "rep1")];
    mkdirSync(oldReps[0]!, { recursive: true });
    writeFiled(oldReps[0]!, { runId: "bench_1", group: "rep:old:1" });
    expect(readFiled(oldReps[0]!)).toEqual({ runId: "bench_1", group: "rep:old:1" });
    expect(resolveArmGroup(old, { resume: true, replicateDirs: oldReps, fresh: next })).toBe(
      "rep:old:1",
    );
  });
});

describe("Marina harness options (off = the official harness)", () => {
  it("pages long documents and search results, and shows the matching window when asked", async () => {
    const paged = {
      ...opts,
      docChars: 20,
      docPaging: true,
      searchPaging: true,
      snippet: "matched" as const,
    };
    const first = JSON.parse(await executeTool("get_document", '{"docid":"101"}', paged)) as {
      text: string;
      next_offset: number;
      total_chars: number;
    };
    expect(first.text).toHaveLength(20);
    expect(first.total_chars).toBe(DOCS[0]!.text.length);
    const next = JSON.parse(
      await executeTool("get_document", `{"docid":"101","offset":${first.next_offset}}`, paged),
    ) as { text: string; offset: number };
    expect(next.offset).toBe(20);
    expect(DOCS[0]!.text.slice(20, 40)).toBe(next.text);
    const page2 = JSON.parse(
      await executeTool("search", '{"query":"Ada Morrow engineer","page":2}', { ...paged, k: 1 }),
    ) as { docid: string }[];
    const page1 = JSON.parse(
      await executeTool("search", '{"query":"Ada Morrow engineer"}', { ...paged, k: 1 }),
    ) as { docid: string; snippet: string }[];
    expect(page2[0]?.docid).not.toBe(page1[0]?.docid);
    expect(
      toolSchemas(5, { docPaging: true }).at(1)?.function.parameters.properties,
    ).toHaveProperty("offset");
    // The official tool schema is unchanged.
    expect(Object.keys(toolSchemas(5)[1]!.function.parameters.properties)).toEqual(["docid"]);
  });
});
