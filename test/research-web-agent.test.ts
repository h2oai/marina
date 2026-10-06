// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SearchProvider } from "../src/engine/search-providers/index";
import type { ModelTurns, TurnFn } from "../src/research/model-turn";
import type { PageRead } from "../src/research/page-reader";
import { ProvenanceCache } from "../src/research/provenance-cache";
import {
  elideOldToolResults,
  findLines,
  parseJsonArray,
  relevantPassages,
  researchEnvironment,
  researchLoop,
  researchTools,
  runResearch,
  verifyCitations,
} from "../src/research/web-agent";

const dirs: string[] = [];
function cache(): ProvenanceCache {
  const d = mkdtempSync(join(tmpdir(), "webagent-"));
  dirs.push(d);
  return new ProvenanceCache(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

const call = (id: string, name: string, args: Record<string, string>): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const text = (t: string) => ({ type: "text" as const, text: t });

/** A scripted model: each turn returns the next scripted message; records every context it saw. */
function scripted(
  script: Array<(ctx: Context) => AssistantMessage>,
): ModelTurns & { seen: Context[] } {
  const seen: Context[] = [];
  let i = 0;
  const turn: TurnFn = async (ctx) => {
    seen.push({ ...ctx, messages: [...ctx.messages] });
    const step = script[Math.min(i++, script.length - 1)]!;
    return step(ctx);
  };
  return {
    spec: "fake/model",
    turn,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    seen,
  };
}

function fakeEnv(pages: Record<string, string>) {
  const c = cache();
  const backend: SearchProvider = {
    name: "fake",
    engines: ["web"],
    search: async (q) => [
      { title: `Result for ${q}`, url: "https://src.org/a", snippet: "snippet", source: "fake" },
    ],
  };
  const read = async (url: string): Promise<PageRead> => {
    const body = pages[url];
    if (body === undefined) {
      c.record({ url, status: 404, error: "HTTP 404" });
      return { url, ok: false, status: 404, text: "", links: [], kind: "web", error: "HTTP 404" };
    }
    c.record({ url, status: 200, text: body });
    return {
      url,
      ok: true,
      status: 200,
      text: body,
      links: [{ text: "next", url: "https://src.org/b" }],
      kind: "web",
    };
  };
  return researchEnvironment({
    cache: c,
    backends: [backend],
    read,
    http: { httpGet: async () => ({ error: "x" }), httpPost: async () => ({ error: "x" }) },
  });
}

describe("research loop", () => {
  test("runs tools, files reads in the provenance cache, and returns the final text", async () => {
    const env = fakeEnv({ "https://src.org/a": "Line one\nThe answer is 42.\nLine three" });
    const model = scripted([
      () => assistant([call("1", "web_search", { query: "answer" })]),
      () =>
        assistant([
          call("2", "fetch_page", { url: "https://src.org/a" }),
          call("3", "find_in_page", { url: "https://src.org/a", pattern: "answer|nothing" }),
        ]),
      () => assistant([text("The answer is 42 https://src.org/a")]),
    ]);
    const r = await researchLoop({ model, env, system: "sys", prompt: "q?", maxTurns: 5 });
    expect(r.text).toBe("The answer is 42 https://src.org/a");
    expect(r.toolCalls).toBe(3);
    expect(r.budgetForced).toBe(false);
    expect(env.cache.readOk("https://src.org/a")).toBe(true);
    const results = r.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
    const fetched = results.find((m) => m.toolName === "fetch_page")!;
    const body = fetched.content[0]!.type === "text" ? fetched.content[0]!.text : "";
    expect(body).toContain("The answer is 42.");
    expect(body).toContain("next → https://src.org/b");
    expect(env.events.map((e) => e.tool).sort()).toEqual([
      "fetch_page",
      "find_in_page",
      "web_search",
    ]);
  });

  test("steers at 75 % and forces a final answer at the cap with tools off", async () => {
    const env = fakeEnv({ "https://src.org/a": "x" });
    const model = scripted([
      (ctx) =>
        ctx.messages.at(-1)?.role === "user" &&
        String((ctx.messages.at(-1) as { content: unknown }).content).includes("[Budget reached]")
          ? assistant([text("best guess")])
          : assistant([
              call(`c${ctx.messages.length}`, "fetch_page", { url: "https://src.org/a" }),
            ]),
    ]);
    const r = await researchLoop({ model, env, system: "s", prompt: "q", maxTurns: 4 });
    expect(r.budgetForced).toBe(true);
    expect(r.text).toBe("best guess");
    const notes = r.messages
      .filter((m): m is ToolResultMessage => m.role === "toolResult")
      .map((m) => (m.content[0]?.type === "text" ? m.content[0].text : ""));
    expect(notes.filter((n) => n.includes("[Budget]")).length).toBe(1);
    expect(model.seen.at(-1)!.messages.at(-1)!.role).toBe("user");
  });

  test("a failed page read is reported to the model as a failure", async () => {
    const env = fakeEnv({});
    const model = scripted([
      () => assistant([call("1", "fetch_page", { url: "https://gone.org/x" })]),
      () => assistant([text("done")]),
    ]);
    const r = await researchLoop({ model, env, system: "s", prompt: "q", maxTurns: 3 });
    const res = r.messages.find((m): m is ToolResultMessage => m.role === "toolResult")!;
    expect(res.isError).toBe(true);
    expect(env.stats.readFailures).toBe(1);
  });
});

describe("runResearch", () => {
  test("single: an answer citing an unopened URL gets one repair pass", async () => {
    const env = fakeEnv({
      "https://src.org/a": "Fact A is true.",
      "https://src.org/b": "Fact B is true.",
    });
    const model = scripted([
      () => assistant([call("1", "fetch_page", { url: "https://src.org/a" })]),
      () => assistant([text("A https://src.org/a and B https://src.org/b")]),
      // repair pass: open b, then answer again
      () => assistant([call("2", "fetch_page", { url: "https://src.org/b" })]),
      () => assistant([text("A https://src.org/a and B https://src.org/b (checked)")]),
    ]);
    const r = await runResearch({
      task: "t",
      env,
      lead: model,
      formation: { kind: "single" },
      maxTurns: 6,
    });
    expect(r.repaired).toBe(true);
    expect(r.answer).toContain("(checked)");
    expect(r.audit.unread).toEqual([]);
    const repairPrompt = model.seen[2]!.messages.at(-1) as { content: string };
    expect(repairPrompt.content).toContain("never opened");
  });

  test("lead: plan, researchers, write, cross-model verification, revision", async () => {
    const env = fakeEnv({ "https://src.org/a": "Fact A is true." });
    const lead = scripted([
      () => assistant([text('["part one", "part two"]')]), // plan
      (ctx) => {
        const last = ctx.messages.at(-1) as Message & { content: unknown };
        if (String(last.content).includes("[Citation verifier]"))
          return assistant([text("Fixed answer https://src.org/a")]);
        return assistant([text("Draft A is false https://src.org/a")]);
      },
    ]);
    const researcher = scripted([
      () => assistant([call("r", "fetch_page", { url: "https://src.org/a" })]),
      () => assistant([text('- Fact A is true. https://src.org/a "Fact A is true."')]),
    ]);
    const verifier = scripted([
      () =>
        assistant([
          text(
            '[{"claim":"A is false","url":"https://src.org/a","verdict":"contradicted","note":"page says true"}]',
          ),
        ]),
    ]);
    const r = await runResearch({
      task: "t",
      env,
      lead,
      researcher,
      verifier,
      formation: { kind: "lead", researchers: 2 },
      maxTurns: 6,
      researcherTurns: 4,
    });
    expect(r.plan).toEqual(["part one", "part two"]);
    expect(r.verification?.problems).toHaveLength(1);
    expect(r.answer).toBe("Fixed answer https://src.org/a");
    // The verifier saw the cached page text, not the open web.
    const vMsg = verifier.seen[0]!.messages[0] as { content: string };
    expect(vMsg.content).toContain("Fact A is true.");
  });
});

describe("helpers", () => {
  test("findLines returns matches with neighbours", () => {
    const out = findLines(
      "a\nb monthly listeners 12M\nc\nd\ne followers",
      "monthly listeners|followers",
    );
    expect(out).toContain("2 match(es)");
    expect(out).toContain("a / b monthly listeners 12M / c");
    expect(findLines("x", "zzz")).toContain("No line matches");
  });

  test("parseJsonArray tolerates prose around the array", () => {
    expect(parseJsonArray('Plan:\n["a", "b", 3]\nok')).toEqual(["a", "b"]);
    expect(parseJsonArray("no array")).toEqual([]);
  });

  test("elideOldToolResults trims the oldest results once over the cap", () => {
    const big = "x".repeat(1000);
    const msgs = [0, 1, 2, 3, 4, 5].map(
      (i) =>
        ({
          role: "toolResult",
          toolCallId: `${i}`,
          toolName: "fetch_page",
          content: [{ type: "text", text: big }],
          isError: false,
          timestamp: 0,
        }) as Message,
    );
    expect(elideOldToolResults(msgs, 3000)).toBe(3);
    const first = (msgs[0] as ToolResultMessage).content[0];
    expect(first?.type === "text" && first.text.includes("elided")).toBe(true);
    const last = (msgs[5] as ToolResultMessage).content[0];
    expect(last?.type === "text" && last.text).toBe(big);
  });

  test("relevantPassages keeps the paragraphs that share terms with the claim", () => {
    const page = [
      "Intro about weather.",
      "Revenue was 12 million dollars in 2025.",
      "Unrelated footer.",
    ].join("\n");
    const out = relevantPassages(page, "revenue 2025 million", 50);
    expect(out).toContain("Revenue was 12 million");
    expect(out).not.toContain("footer");
  });

  test("verifyCitations reports never-read pages without a model call", async () => {
    const c = cache();
    const verifier = scripted([() => assistant([text("[]")])]);
    const r = await verifyCitations(verifier, c, "t", "Claim https://never.org/x");
    expect(r.problems).toEqual([
      {
        claim: "(claims citing this URL)",
        url: "https://never.org/x",
        verdict: "unreadable",
        note: "the page was never read successfully",
      },
    ]);
    expect(verifier.seen).toHaveLength(0);
  });
});

describe("read swarm tool", () => {
  test("offered only with a swarm; reads go through the environment, so barred pages stay unread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rwa-swarm-"));
    try {
      const backend: SearchProvider = {
        name: "fake",
        engines: ["web"],
        search: async () => [
          { title: "Barred", url: "https://barred.example.org/a", snippet: "x", source: "f" },
          { title: "Open", url: "https://open.example.org/b", snippet: "x", source: "f" },
        ],
      };
      const readUrls: string[] = [];
      const read = async (url: string): Promise<PageRead> => {
        readUrls.push(url);
        return {
          url,
          ok: true,
          status: 200,
          text: "The answer is Blue Lake, 12 km long.",
          links: [],
          kind: "web",
        };
      };
      const plain = researchEnvironment({
        cache: new ProvenanceCache(dir),
        backends: [backend],
        read,
      });
      expect(researchTools(plain).map((t) => t.name)).not.toContain("read_swarm");
      const reader = {
        name: "fake-reader",
        complete: async () =>
          JSON.stringify({
            relevant: true,
            candidate: "Blue Lake",
            quotes: [{ clue: 1, quote: "The answer is Blue Lake" }],
            confidence: 0.9,
            more: false,
          }),
      };
      const env = researchEnvironment({
        cache: new ProvenanceCache(dir),
        backends: [backend],
        read,
        exclude: { urls: ["barred.example.org"] },
        swarm: { reader, maxDocs: 4 },
      });
      expect(researchTools(env).map((t) => t.name)).toContain("read_swarm");
      const table = await env.swarm!("Which lake is 12 km long?");
      expect(table).toContain("Read swarm:");
      expect(readUrls).toEqual(["https://open.example.org/b"]);
      expect(env.stats.searchBarred).toBeGreaterThan(0);
      expect(env.stats.swarms).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
