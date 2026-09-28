// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cerebras, DeepSeek, Mistral and xAI keys count as "a provider is
 * configured" (agent spawning, readiness) — so marina/default must actually
 * route to them instead of answering 503.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveModel } from "../src/agent/lean-agent-adapter";
import { Engine } from "../src/engine/engine";
import {
  configuredUpstreamProviders,
  describeDefaultUpstream,
} from "../src/net/model-api/upstream";
import { HUGGINGFACE_ENV_KEYS } from "../src/net/model-discovery";
import { roomId } from "../src/types";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "MARINA_DEFAULT_XAI_MODEL",
  ...HUGGINGFACE_ENV_KEYS,
];

const CASES = [
  ["CEREBRAS_API_KEY", "cerebras/gpt-oss-120b"],
  ["DEEPSEEK_API_KEY", "deepseek/deepseek-flash"],
  ["MISTRAL_API_KEY", "mistral/mistral-small-latest"],
  ["XAI_API_KEY", "xai/grok-4.7"],
] as const;

describe("OpenAI-compatible first-party providers", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each(CASES)("%s alone routes marina/default to %s", (envKey, target) => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    expect(describeDefaultUpstream(engine)).toBeUndefined();
    process.env[envKey] = "sk-test";
    expect(describeDefaultUpstream(engine)).toBe(target);
    expect(configuredUpstreamProviders(engine).map((p) => `${p.provider}/${p.model}`)).toEqual([
      target,
    ]);
    // The default id is in pi-ai's catalog, so agents resolve it exactly (priced).
    const model = resolveModel(target);
    expect(model.id).toBe(target.slice(target.indexOf("/") + 1));
    expect(model.cost.input).toBeGreaterThan(0);
  });

  it("the per-provider override still wins", () => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    process.env.XAI_API_KEY = "xai-test";
    process.env.MARINA_DEFAULT_XAI_MODEL = "grok-4.3";
    expect(describeDefaultUpstream(engine)).toBe("xai/grok-4.3");
  });
});
