// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { resolveModel } from "../src/agent/lean-agent-adapter";
import { decisionConfigFromEnv } from "../src/decisions/config";
import { Engine } from "../src/engine/engine";
import { describeDefaultUpstream } from "../src/net/model-api/upstream";
import {
  HUGGINGFACE_ENV_KEYS,
  MODEL_DISCOVERY_PROVIDERS,
  parseProviderResponse,
} from "../src/net/model-discovery";
import { roomId } from "../src/types";

/** Every cloud key the fallback order consults — hidden so a local .env can't win. */
const PROVIDER_KEYS = [
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
  "MARINA_DEFAULT_HUGGINGFACE_MODEL",
  ...HUGGINGFACE_ENV_KEYS,
];

describe("Hugging Face provider", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is a known, discoverable provider backed by pi's Hugging Face registry", () => {
    expect(MODEL_DISCOVERY_PROVIDERS).toContain("huggingface");
    const model = resolveModel("huggingface/zai-org/GLM-5.3-Flash");
    expect(model.provider).toBe("huggingface");
    expect(model.id).toBe("zai-org/GLM-5.3-Flash");
    expect(model.baseUrl).toBe("https://router.huggingface.co/v1");
    expect(model.contextWindow).toBeGreaterThan(100_000);
  });

  it("parses the router's OpenAI-compatible model list into huggingface/<hub id> entries", () => {
    const entries = parseProviderResponse("huggingface", {
      object: "list",
      data: [{ id: "zai-org/GLM-5.3-Flash", object: "model", owned_by: "zai-org" }],
    });
    expect(entries[0]).toMatchObject({
      value: "huggingface/zai-org/GLM-5.3-Flash",
      label: "zai-org/GLM-5.3-Flash",
    });
  });

  it("serves marina/default through Hugging Face when it is the only configured provider", () => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    expect(describeDefaultUpstream(engine)).toBeUndefined();
    process.env.HF_TOKEN = "hf_test";
    expect(describeDefaultUpstream(engine)).toBe("huggingface/zai-org/GLM-5.3-Flash");
    process.env.MARINA_DEFAULT_HUGGINGFACE_MODEL = "openai/gpt-oss-120b:cheapest";
    expect(describeDefaultUpstream(engine)).toBe("huggingface/openai/gpt-oss-120b:cheapest");
    // First-party providers stay preferred over the aggregators.
    process.env.OPENAI_API_KEY = "sk-test";
    expect(describeDefaultUpstream(engine)?.startsWith("openai/")).toBe(true);
  });

  it("resolves agent keys from HUGGINGFACE_API_KEY, then HF_TOKEN", () => {
    const runtime = new AgentRuntime({ wsPort: 39997 });
    const resolve = (
      runtime as unknown as { resolveApiKey(model: string): string | undefined }
    ).resolveApiKey.bind(runtime);
    process.env.HF_TOKEN = "hf_token";
    expect(resolve("huggingface/zai-org/GLM-5.3-Flash")).toBe("hf_token");
    process.env.HUGGINGFACE_API_KEY = "hf_primary";
    expect(resolve("huggingface/zai-org/GLM-5.3-Flash")).toBe("hf_primary");
  });

  it("lets a chat-classifier decision backend on the HF router use the HF token", () => {
    const config = decisionConfigFromEnv({
      MARINA_DECISIONS: "chat-classifier",
      MARINA_DECISION_MODEL: "zai-org/GLM-5.3-Flash",
      MARINA_DECISION_BASE_URL: "https://router.huggingface.co/v1",
      HF_TOKEN: "hf_token",
    });
    expect(config?.apiKey).toBe("hf_token");
  });
});
