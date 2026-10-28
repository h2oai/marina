// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  compactionMaxTokens,
  DEFAULT_COMPACTION_MAX_TOKENS,
  disableReasoningPayload,
  stripLeakedReasoning,
  summaryCallMaxTokens,
  summaryCallModel,
} from "../src/agent/compaction-call";
import { extractPointers } from "../src/agent/context-manager";
import { neutralizeUnusedReasoning, resolveModel } from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";
import {
  noteUpstreamRejection,
  REASONING_HEADROOM_TOKENS,
  resetReasoningControlForTests,
} from "../src/agent/reasoning-control";

afterEach(() => resetReasoningControlForTests());

/** The request body pi-ai would send for the summary call (the request is refused, never sent). */
async function wireBody(model: Model<Api>): Promise<Record<string, unknown>> {
  const call = summaryCallModel(neutralizeUnusedReasoning(model, "off"));
  let body: Record<string, unknown> = {};
  await piModels.completeSimple(
    call,
    { systemPrompt: "Summarize.", messages: [{ role: "user", content: "t", timestamp: 1 }] },
    {
      apiKey: "fixture-key",
      maxTokens: 800,
      maxRetries: 0,
      onPayload: (payload) => disableReasoningPayload(payload, call),
      fetch: (async (_input: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response("fixture", { status: 400 });
      }) as typeof fetch,
    },
  );
  return body;
}

function registry(provider: string, id: string): Model<Api> {
  const model = piModels.getModel(provider as never, id as never) as Model<Api> | undefined;
  if (!model) throw new Error(`fixture model ${provider}/${id} is not in the registry`);
  return model;
}

describe("the compaction call turns reasoning off with each provider's own switch", () => {
  it("Anthropic: thinking disabled", async () => {
    const body = await wireBody(registry("anthropic", "claude-haiku-5-5"));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("OpenAI: the lowest reasoning effort", async () => {
    const body = await wireBody(registry("openai", "gpt-6-luna"));
    expect(body.reasoning).toMatchObject({ effort: "none" });
  });

  it("OpenRouter: reasoning disabled, replacing pi-ai's effort", async () => {
    const body = await wireBody(resolveModel("openrouter/deepseek/deepseek-v4.1-flash"));
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("OpenRouter: a model whose reasoning is mandatory gets a low, excluded effort", async () => {
    const body = await wireBody(resolveModel("openrouter/anthropic/claude-opus-5.5"));
    expect((body.thinking as { type?: string }).type).not.toBe("disabled");
    expect(body.output_config).toMatchObject({ effort: "low" });
    const learned = resolveModel("openrouter/deepseek/deepseek-v4.1-flash");
    noteUpstreamRejection(learned.id, "Reasoning is mandatory for this endpoint");
    expect((await wireBody(learned)).reasoning).toEqual({ effort: "low", exclude: true });
  });

  it("DeepSeek: thinking disabled", async () => {
    const body = await wireBody(registry("deepseek", "deepseek-flash"));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("Qwen thinking format: enable_thinking false", async () => {
    const body = await wireBody(registry("qwen-token-plan", "deepseek-v4-flash"));
    expect(body.enable_thinking).toBe(false);
  });

  it("leaves an unknown non-OpenRouter, non-Anthropic body alone", () => {
    const model = { id: "x", api: "openai-completions", provider: "openai", baseUrl: "http://h" };
    expect(disableReasoningPayload({ model: "x" }, model as Model<Api>)).toBeUndefined();
    expect(
      disableReasoningPayload({}, resolveModel("openrouter/deepseek/deepseek-v4.1-flash"), {
        MARINA_OPENROUTER_REASONING_OFF: "off",
      }),
    ).toBeUndefined();
  });

  it("gives a reasoning-mandatory model headroom above the summary cap", () => {
    expect(summaryCallMaxTokens(resolveModel("openrouter/deepseek/deepseek-v4.1-flash"), 800)).toBe(
      800,
    );
    expect(summaryCallMaxTokens(resolveModel("openrouter/anthropic/claude-opus-5.5"), 800)).toBe(
      800 + REASONING_HEADROOM_TOKENS,
    );
  });
});

describe("compactionMaxTokens", () => {
  it("defaults and honors explicit MARINA_AGENT_COMPACTION_MAX_TOKENS", () => {
    expect(DEFAULT_COMPACTION_MAX_TOKENS).toBe(800);
    expect(compactionMaxTokens({})).toBe(800);
    expect(compactionMaxTokens({ MARINA_AGENT_COMPACTION_MAX_TOKENS: "junk" })).toBe(800);
    expect(compactionMaxTokens({ MARINA_AGENT_COMPACTION_MAX_TOKENS: "0" })).toBe(800);
    expect(compactionMaxTokens({ MARINA_AGENT_COMPACTION_MAX_TOKENS: " 1200 " })).toBe(1200);
    expect(compactionMaxTokens({ MARINA_AGENT_COMPACTION_MAX_TOKENS: "50" })).toBe(50);
    expect(compactionMaxTokens({ MARINA_AGENT_COMPACTION_MAX_TOKENS: "99999" })).toBe(99999);
  });
});

describe("stripLeakedReasoning", () => {
  it("keeps an ordinary summary", () => {
    const s = "Objective: find the doctor.\nVerified facts: doc 33294 names M. A. Barnor.";
    expect(stripLeakedReasoning(s)).toBe(s);
  });

  it("removes think blocks, and drops an unclosed one", () => {
    expect(stripLeakedReasoning("<think>plan it</think>\nObjective: X")).toBe("Objective: X");
    expect(stripLeakedReasoning("Objective: X\n<thinking>half")).toBe("Objective: X");
    expect(stripLeakedReasoning("reasoning about it…</think>Objective: Y")).toBe("Objective: Y");
  });

  it("drops a reply that is only reasoning, and keeps what follows an answer marker", () => {
    expect(stripLeakedReasoning("Thinking Process:\n\n1. **Analyze the Request:** …")).toBe("");
    expect(stripLeakedReasoning("The user wants me to compress the transcript. Let me…")).toBe("");
    expect(
      stripLeakedReasoning("Thinking Process:\n1. Read it.\n\n**Final Output:**\nObjective: Z"),
    ).toBe("Objective: Z");
  });
});

describe("pointer extraction recognises generic id shapes", () => {
  const pointers = (text: string) =>
    extractPointers([{ role: "user", content: text, timestamp: 1 }]);

  it("takes the value of any id-named JSON field, escaped or not", () => {
    expect(pointers('[{"docid":"33294","score":4.2},{"docid": 772}]')).toEqual(["33294", "772"]);
    expect(pointers('{"reservation_id": "4OG6T3", "orderId": 7781, "count": 12}')).toEqual([
      "4OG6T3",
      "7781",
    ]);
    expect(pointers(JSON.stringify({ output: '{"user_id": "noah_ito_3850"}' }))).toContain(
      "noah_ito_3850",
    );
  });

  it("takes lettered # handles and snake_case ids ending in a number", () => {
    expect(
      pointers("order #W9810810 and #12 for lucas_brown_6720 via credit_card_2112420"),
    ).toEqual(["#W9810810", "#12", "lucas_brown_6720", "credit_card_2112420"]);
  });

  it("does not take ordinary words, short numbers or non-id fields", () => {
    expect(pointers('max_tokens set, "count": 12345, "id": "ab", step_2 done')).toEqual([]);
  });
});
