import { describe, expect, it } from "bun:test";
import { parseProviderResponse } from "../src/net/model-discovery";

describe("parseProviderResponse", () => {
  it("parses Anthropic /v1/models shape", () => {
    const body = {
      data: [
        { type: "model", id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
        { type: "model", id: "claude-haiku-4-5" },
      ],
    };
    expect(parseProviderResponse("anthropic", body)).toEqual([
      {
        value: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        capabilities: { text: true },
      },
      {
        value: "anthropic/claude-haiku-4-5",
        label: "claude-haiku-4-5",
        capabilities: { text: true },
      },
    ]);
  });

  it("parses OpenAI-compatible /v1/models shape (openai, groq, mistral, xai, cerebras, deepseek)", () => {
    const body = {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model" },
        { id: "gpt-4o-mini", object: "model" },
      ],
    };
    expect(parseProviderResponse("openai", body)).toEqual([
      { value: "openai/gpt-4o", label: "gpt-4o", capabilities: { text: true } },
      { value: "openai/gpt-4o-mini", label: "gpt-4o-mini", capabilities: { text: true } },
    ]);
    // Same shape works for other openai-compatible providers
    expect(parseProviderResponse("groq", { data: [{ id: "llama-3.3-70b-versatile" }] })).toEqual([
      {
        value: "groq/llama-3.3-70b-versatile",
        label: "llama-3.3-70b-versatile",
        capabilities: { text: true },
      },
    ]);
  });

  it("parses OpenRouter shape with context_length + description", () => {
    const body = {
      data: [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Anthropic: Claude Sonnet 4",
          context_length: 200000,
          description: "Strong reasoning",
        },
        { id: "google/gemini-2.5-pro-preview", name: "Google: Gemini 2.5 Pro" },
      ],
    };
    expect(parseProviderResponse("openrouter", body)).toEqual([
      {
        value: "openrouter/anthropic/claude-sonnet-4",
        label: "Anthropic: Claude Sonnet 4",
        contextLength: 200000,
        description: "Strong reasoning",
        capabilities: { text: true },
      },
      {
        value: "openrouter/google/gemini-2.5-pro-preview",
        label: "Google: Gemini 2.5 Pro",
        capabilities: { text: true },
      },
    ]);
  });

  it("parses Google Gemini shape, strips models/ prefix, filters non-generate models", () => {
    const body = {
      models: [
        {
          name: "models/gemini-2.0-flash",
          displayName: "Gemini 2.0 Flash",
          description: "Fast",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding-004",
          displayName: "Embedding 004",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    };
    expect(parseProviderResponse("google", body)).toEqual([
      {
        value: "google/gemini-2.0-flash",
        label: "Gemini 2.0 Flash",
        description: "Fast",
        capabilities: { text: true },
      },
    ]);
  });

  it("returns [] on garbage input", () => {
    expect(parseProviderResponse("openai", null)).toEqual([]);
    expect(parseProviderResponse("openai", {})).toEqual([]);
    expect(parseProviderResponse("anthropic", { data: "nope" })).toEqual([]);
    expect(parseProviderResponse("google", { models: [{}, { name: 42 }] })).toEqual([]);
  });
});
