// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/pi-models";
import { checkOutputPayload } from "../src/model/output-payload";
import { providerOutputField } from "../src/sdk/examples/provider-output";
import { scopeProcessState } from "./process-state";

const model: Model<Api> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
};

for (const scenario of [
  {
    name: "Responses minimum exceeds explicit ceiling",
    model: { ...model, maxTokens: 1 },
    cap: 1,
    error: "cannot enforce explicit",
    options: {},
  },
  {
    name: "Responses adapter omits unsupported ceiling",
    model: { ...model, compat: { supportsMaxOutputTokens: false } },
    cap: 100,
    error: "cannot enforce explicit",
    options: {},
  },
  {
    name: "legacy Anthropic adds thinking above explicit ceiling",
    model: {
      ...model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    },
    cap: 100,
    error: "cannot enforce explicit",
    options: { reasoning: "high" },
  },
  {
    name: "legacy Anthropic thinking cannot fit small ceiling",
    model: {
      ...model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      maxTokens: 100,
    },
    cap: 100,
    error: "cannot fit output",
    options: { reasoning: "high" },
  },
]) {
  test(`${scenario.name}: rejects before sending`, async () => {
    let sent = 0;
    let inspected = false;
    const result = await piModels.completeSimple(
      scenario.model as Model<Api>,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: "sk-fixture",
        maxTokens: scenario.cap,
        maxRetries: 0,
        ...(scenario.options as SimpleStreamOptions),
        fetch: (async () => {
          sent++;
          throw new Error("Unexpected network call");
        }) as unknown as typeof fetch,
        onPayload: (payload) => {
          inspected = true;
          checkOutputPayload(payload, scenario.cap, true);
        },
      },
    );
    expect(inspected).toBe(true);
    expect(sent).toBe(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(scenario.error);
  });
}

test("automatic provider semantics remain usable and disclose a changed allowance", () => {
  const details: string[] = [];
  checkOutputPayload({}, 16384, false, (s) => details.push(s));
  checkOutputPayload({ max_output_tokens: 16 }, 1, false, (s) => details.push(s));
  expect(details).toEqual([
    "output allowance requested:16384 sent:provider default",
    "output allowance requested:1 sent:16",
  ]);
});

test("SDK example operator allowance reaches both OpenAI and compatible request fields", () => {
  using _state = scopeProcessState({ env: { PROVIDER_MAX_OUTPUT_TOKENS: "32000" } });
  expect(providerOutputField("https://api.openai.com/v1")).toEqual({
    max_completion_tokens: 32000,
  });
  expect(providerOutputField("http://localhost:11434/v1")).toEqual({ max_tokens: 32000 });
});

test("agent repair and obligations enforce an explicit ceiling before the SDK sends", async () => {
  const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
  using _state = scopeProcessState({
    env: { MARINA_DEFAULT_MAX_TOKENS: "1", MARINA_MODEL_RETRIES: "0" },
  });
  const agent = new LeanAgentAdapter(
    { name: "AuxLimit", model: "openai/gpt-4", maxTokens: 1 },
    "ws://127.0.0.1:39998",
    null,
    "sk-fixture",
  ) as unknown as { auxiliaryOutputOptions(): SimpleStreamOptions };
  let sent = 0;
  const options = agent.auxiliaryOutputOptions();
  const result = await piModels.completeSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      ...options,
      apiKey: "sk-fixture",
      maxRetries: 0,
      fetch: (async () => {
        sent++;
        throw new Error("Unexpected network call");
      }) as unknown as typeof fetch,
    },
  );
  expect(options.maxTokens).toBe(1);
  expect(sent).toBe(0);
  expect(result.errorMessage).toContain("cannot enforce explicit");
});
