// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The single-model floor: with EVERY vendor key unset and one local
 * OpenAI-compatible model (llama.cpp / Ollama style, mocked here), Marina's
 * model-using features still run — honestly labelled degraded — instead of
 * failing for a missing provider. Only zero models is an error.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AgentRuntime, resolveRouteModel } from "../src/agent/agent-runtime";
import { availableModels, intelligenceScale } from "../src/agent/available-models";
import { modelComplete } from "../src/arena/model-backend";
import { decisionConfigFromEnv, getDecisionProvider, researchJudge } from "../src/decisions/config";
import { defaultRetrieverSpec, forecastDeps, typedForecastDeps } from "../src/forecast/service";
import { forecastTyped } from "../src/forecast/typed";
import { parseVerifyModel } from "../src/net/model-api/verify";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { scopeProcessState } from "./process-state";

/** Every variable that could hand Marina a second model or a vendor service. */
const VENDOR_AND_ROUTING_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HF_TOKEN",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "VIBETHINKER_API_KEY",
  "VIBETHINKER_BASE_URL",
  "MARINA_DECISIONS",
  "MARINA_DECISION_MODEL",
  "MARINA_DECISION_BASE_URL",
  "MARINA_DECISION_API_KEY",
  "MARINA_FORECAST_ANALYSTS",
  "MARINA_FORECAST_RETRIEVER",
  "MARINA_FORECAST_JUDGE",
  "MARINA_FORECAST_PLANNER",
  "MARINA_FORECAST_CRITIC",
  "MARINA_FORECAST_VERIFIER",
  "MARINA_FORECAST_LOOKUPS",
  "MARINA_ROUTES",
  "MARINA_ROUTE_FAST_MODEL",
  "MARINA_ROUTE_POWERFUL_MODEL",
  "MARINA_VERIFY_CHECKER_MODEL",
  "MARINA_DEFAULT_LLAMA_MODEL",
];

function cleared(extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {};
  for (const k of VENDOR_AND_ROUTING_ENV) env[k] = undefined;
  return { ...env, ...extra };
}

/** A tiny local "model" that answers each Marina prompt shape with valid JSON. */
function reply(system: string): string {
  if (system.includes("decision classifier")) {
    return JSON.stringify({ answers: { harmful: { noul: 0.1 } } });
  }
  if (system.includes('"restatement"')) {
    return JSON.stringify({
      restatement: "Will the test event happen?",
      resolutionSource: "the test fixture",
      changes: "nothing",
    });
  }
  if (system.includes('"done": true|false')) return JSON.stringify({ done: true, missing: "" });
  if (system.includes('"verdict": "keep" | "revise"')) {
    return JSON.stringify({ verdict: "keep", confidence: 0.6, reason: "No contrary evidence." });
  }
  if (system.includes('"verdict": "accept" | "correct"')) {
    return JSON.stringify({ verdict: "accept", reason: "Consistent." });
  }
  return JSON.stringify({ answer: "A", confidence: 0.7, reason: "Base rate favours yes." });
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
      const body = (await req.json()) as {
        model?: string;
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
      };
      seen.push(String(body.model));
      const system = (body.messages ?? [])
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const content = reply(system);
      if (body.stream) {
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const usage = `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`;
        return new Response(
          chunk({ role: "assistant", content }, null) +
            chunk({}, "stop") +
            usage +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "c1",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

const localOnly = () =>
  cleared({ LLAMA_BASE_URL: baseUrl, MARINA_DEFAULT_LLAMA_MODEL: "test-model" });

describe("intelligence scale", () => {
  it("nothing configured: tier none, no models", () => {
    using _ = scopeProcessState({ env: cleared() });
    expect(availableModels()).toEqual([]);
    expect(intelligenceScale().tier).toBe("none");
  });

  it("one local runtime: tier single, the local model, an honest summary", () => {
    using _ = scopeProcessState({ env: localOnly() });
    expect(availableModels().map((m) => m.spec)).toEqual(["llama/test-model"]);
    const scale = intelligenceScale();
    expect(scale.tier).toBe("single");
    expect(scale.summary).toContain("verification = self-check");
    expect(scale.summary).toContain("uncalibrated classifier");
  });

  it("several vendors stay multi, local runtime first", () => {
    using _ = scopeProcessState({
      env: cleared({ LLAMA_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k" }),
    });
    const specs = availableModels().map((m) => m.provider);
    expect(specs[0]).toBe("llama");
    expect(specs).toContain("anthropic");
    expect(intelligenceScale().tier).toBe("multi");
  });
});

describe("forecasting on a single local model", () => {
  it("wires without OpenRouter: keyless retrieval, one analyst, labelled degraded", () => {
    using _ = scopeProcessState({ env: localOnly() });
    expect(defaultRetrieverSpec()).toBe("asof");
    const made = forecastDeps();
    if ("error" in made) throw new Error(made.error);
    expect(made.scale.tier).toBe("degraded");
    expect(made.scale.analysts).toEqual(["llama/test-model"]);
    expect(made.scale.retriever).toBe("asof");
    expect(made.scale.judge).toBe("none");
    expect(made.scale.notes.join(" ")).toContain("single model");
  });

  it("errors only when there is no model at all", () => {
    using _ = scopeProcessState({ env: cleared() });
    const made = forecastDeps();
    expect("error" in made && made.error).toContain("No model is available");
  });

  it("a typed forecast runs end to end against the one local model", async () => {
    using _ = scopeProcessState({
      env: {
        ...localOnly(),
        MARINA_FORECAST_RETRIEVER: "closed-book",
        MARINA_FORECAST_LOOKUPS: "",
      },
    });
    const made = typedForecastDeps(process.env, { runs: 2, researchRounds: 1 });
    if ("error" in made) throw new Error(made.error);
    const before = seen.length;
    const answer = await forecastTyped(
      {
        question: "Will the test event happen?",
        answer: {
          type: "choice",
          options: [
            { id: "A", label: "Yes" },
            { id: "B", label: "No" },
          ],
        },
      },
      made.deps,
    );
    expect(answer.prediction).toBe("A");
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.slice(before).every((m) => m === "test-model")).toBe(true);
  }, 30_000);

  it("modelComplete calls a local runtime with no vendor key", async () => {
    using _ = scopeProcessState({ env: localOnly() });
    const { complete } = modelComplete("llama/test-model");
    const text = await complete("You are a careful forecaster.", "hello");
    expect(text).toContain('"answer"');
  });
});

describe("decisions on a single local model", () => {
  it("a chat-classifier backend with no base URL lands on the local runtime", async () => {
    using _ = scopeProcessState({ env: { ...localOnly(), MARINA_DECISIONS: "classifier" } });
    const config = decisionConfigFromEnv();
    expect(config?.baseUrl).toBe(baseUrl);
    expect(config?.model).toBe("test-model");
    const provider = getDecisionProvider();
    if (!provider) throw new Error("no provider");
    const result = await provider.ask({
      state: "rm -rf /tmp/scratch",
      questions: { harmful: { type: "noul", instructions: "Is this harmful?" } },
    });
    expect(result.answers.harmful).toEqual({ type: "noul", noul: 0.1 });
  });

  it("the research judge falls back to the world's backend without OpenRouter", () => {
    using _ = scopeProcessState({ env: { ...localOnly(), MARINA_DECISIONS: "classifier" } });
    expect(researchJudge("jev", process.env, undefined)?.model).toBe("test-model");
  });

  it("with no backend at all the judge is absent (equal weights), not an error", () => {
    using _ = scopeProcessState({ env: localOnly() });
    expect(researchJudge("jev", process.env, undefined)).toBeUndefined();
  });
});

describe("verification and routing on a single model", () => {
  it("marina/verify:default is the one model checking itself", () => {
    using _ = scopeProcessState({ env: localOnly() });
    expect(parseVerifyModel("marina/verify:default")).toEqual({
      proposer: "llama/test-model",
      checker: "llama/test-model",
    });
  });

  it("model:route without a table or tiers has one candidate instead of refusing", async () => {
    using _ = scopeProcessState({ env: localOnly() });
    const events: EngineEvent[] = [];
    const model = await resolveRouteModel(
      { name: "Solo", goal: "answer questions" },
      undefined,
      (e) => events.push(e),
    );
    expect(model).toBe("llama/test-model");
    const route = events.find((e) => e.type === "agent_decision") as
      | { verdict?: string; reason?: string }
      | undefined;
    expect(route?.verdict).toBe("single");
  });
});

describe("seeded agents size down instead of vanishing", () => {
  it("a boot respawn of a vendor model with no key runs on marina/default; an explicit spawn still fails fast", async () => {
    using _ = scopeProcessState({ env: localOnly() });
    const db = new MarinaDB(":memory:");
    const runtime = new AgentRuntime({ db });
    try {
      const config = { name: "Seeded", model: "anthropic/claude-sonnet-5" };
      const explicit = await runtime.spawn(config).then(
        () => "ok",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(explicit).toContain('No API key for provider "anthropic"');
      const respawn = await runtime.spawn(config, { systemRespawn: true }).then(
        () => "ok",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      // Without a WebSocket port the spawn may fail later — but never for the missing key.
      expect(respawn).not.toContain("No API key");
      // The saved config keeps the model it asked for, so a key restores it.
      const saved = db.getAgentConfig("Seeded");
      if (saved) expect(saved.model).toBe("anthropic/claude-sonnet-5");
    } finally {
      await runtime.stopAll();
      db.close();
    }
  });
});
