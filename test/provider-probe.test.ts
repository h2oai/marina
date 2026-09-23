// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider conformance probe — the check that would have caught both 2026-09
 * Claude 5 passthru failures (thinking block read as the answer; only the first
 * system message forwarded) on day one. Fetch is mocked; no provider is called.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_PROBE_MIN_RANK,
  readinessCommand,
  renderProviderProbe,
} from "../src/engine/commands/readiness";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import {
  buildProviderProbeBody,
  configuredUpstreamProviders,
  evaluateProviderProbe,
  evaluateProviderToolProbe,
  getLastProviderProbe,
  PROVIDER_TOOL_PROBE_NAME,
  type ProviderProbeResult,
  probeConfiguredProviders,
} from "../src/net/model-api";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MARINA_DEFAULT_ANTHROPIC_MODEL",
  "MARINA_DEFAULT_OPENAI_MODEL",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;

beforeEach(() => {
  saved = new Map(PROVIDER_ENV.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_ENV) delete process.env[k];
  originalFetch = globalThis.fetch;
  resetTrustProfileForTests();
  dir = mkdtempSync(join(tmpdir(), "provider-probe-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetTrustProfileForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Everything the probe wrote into system/user slots (Anthropic `system` is an
 *  array of text blocks; OpenAI keeps system-role messages). */
function promptTextOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    system?: string | { text?: string }[];
    messages?: { role: string; content: unknown }[];
  };
  const system = Array.isArray(body.system)
    ? body.system.map((b) => b.text ?? "").join("\n")
    : (body.system ?? "");
  const messages = (body.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  return `${system}\n${messages}`;
}

/** Extract the nonce the probe put in its second system message. */
function nonceOf(init: RequestInit | undefined): string {
  return promptTextOf(init).match(/probe-[0-9a-f]{8}/)?.[0] ?? "";
}

/** The tool-probe nonce, when this request is the tool-call probe. */
function toolNonceOf(init: RequestInit | undefined): string | undefined {
  return promptTextOf(init).match(/tool-[0-9a-f]{8}/)?.[0];
}

const anthropicReply = (blocks: unknown[], stopReason = "end_turn") =>
  new Response(JSON.stringify({ id: "msg_1", content: blocks, stop_reason: stopReason }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const openaiReply = (content: string) =>
  new Response(
    JSON.stringify({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
/** A well-formed tool-call reply from either provider for the tool probe. */
const anthropicToolReply = (nonce: string) =>
  anthropicReply(
    [{ type: "tool_use", id: "toolu_p", name: PROVIDER_TOOL_PROBE_NAME, input: { word: nonce } }],
    "tool_use",
  );
const openaiToolReply = (nonce: string) =>
  new Response(
    JSON.stringify({
      id: "c2",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_p",
                type: "function",
                function: {
                  name: PROVIDER_TOOL_PROBE_NAME,
                  arguments: JSON.stringify({ word: nonce }),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("provider probe primitives", () => {
  it("builds a two-system-message request and judges text + second-system honoring", () => {
    const body = buildProviderProbeBody("probe-abcdef01");
    const messages = body.messages as { role: string; content: string }[];
    expect(messages.filter((m) => m.role === "system")).toHaveLength(2);
    expect(messages[1]!.content).toContain("probe-abcdef01");
    expect(evaluateProviderProbe("probe-abcdef01", "probe-abcdef01")).toEqual({
      textOk: true,
      systemHonored: true,
    });
    expect(evaluateProviderProbe("", "probe-abcdef01")).toEqual({
      textOk: false,
      systemHonored: false,
    });
    expect(evaluateProviderProbe("I do not know.", "probe-abcdef01")).toEqual({
      textOk: true,
      systemHonored: false,
    });
  });

  it("lists only providers that are configured, using the operator's default model for its provider", () => {
    expect(configuredUpstreamProviders(engine)).toEqual([]);
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    db.setSetting("default_model", "anthropic/claude-sonnet-5");
    const targets = configuredUpstreamProviders(engine);
    expect(targets.map((t) => t.provider)).toEqual(["anthropic", "openai"]);
    expect(targets[0]!.model).toBe("claude-sonnet-5");
  });
});

describe("probeConfiguredProviders", () => {
  it("passes a provider whose thinking-first reply, second system message and tool call all come through", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    const toolBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const toolNonce = toolNonceOf(init);
      if (toolNonce) {
        toolBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.includes("anthropic.com")) return anthropicToolReply(toolNonce);
        if (url.includes("openai.com")) return openaiToolReply(toolNonce);
      }
      const nonce = nonceOf(init);
      if (url.includes("anthropic.com"))
        return anthropicReply([
          { type: "thinking", thinking: "…" },
          { type: "text", text: nonce },
        ]);
      if (url.includes("openai.com")) return openaiReply(nonce);
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const results = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(results.map((r) => [r.provider, r.ok, r.textOk, r.systemHonored, r.toolCallOk])).toEqual(
      [
        ["anthropic", true, true, true, true],
        ["openai", true, true, true, true],
      ],
    );
    // The tool schema actually reached both upstreams, in each one's dialect.
    expect(toolBodies).toHaveLength(2);
    const anthropicTools = toolBodies[0]!.tools as { name: string; input_schema: unknown }[];
    expect(anthropicTools[0]!.name).toBe(PROVIDER_TOOL_PROBE_NAME);
    expect(anthropicTools[0]!.input_schema).toBeDefined();
    const openaiTools = toolBodies[1]!.tools as { function: { name: string } }[];
    expect(openaiTools[0]!.function.name).toBe(PROVIDER_TOOL_PROBE_NAME);
    expect(getLastProviderProbe()).toBe(results);
  });

  it("fails a provider that answers the tool probe in text (the tools-dropped class of bug)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("anthropic.com")) throw new Error(`unexpected ${url}`);
      const toolNonce = toolNonceOf(init);
      // Text reply to the tool probe — what the pre-fix proxy produced.
      if (toolNonce) return anthropicReply([{ type: "text", text: `The word is ${toolNonce}` }]);
      return anthropicReply([{ type: "text", text: nonceOf(init) }]);
    }) as typeof fetch;
    const [anthropic] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(anthropic).toMatchObject({
      provider: "anthropic",
      ok: false,
      textOk: true,
      systemHonored: true,
      toolCallOk: false,
    });
    expect(anthropic!.error).toContain("tool call dropped");
    expect(renderProviderProbe([anthropic!]).join("\n")).toContain("tool call dropped");
  });

  it("judges the tool probe reply shape", () => {
    const good = {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                function: { name: PROVIDER_TOOL_PROBE_NAME, arguments: '{"word":"tool-abcdef01"}' },
              },
            ],
          },
        },
      ],
    };
    expect(evaluateProviderToolProbe(good, "tool-abcdef01")).toEqual({ ok: true });
    expect(
      evaluateProviderToolProbe(
        { choices: [{ message: { content: "tool-abcdef01" } }] },
        "tool-abcdef01",
      ).ok,
    ).toBe(false);
    expect(
      evaluateProviderToolProbe(
        {
          choices: [
            { message: { tool_calls: [{ function: { name: "other", arguments: "{}" } }] } },
          ],
        },
        "tool-abcdef01",
      ).error,
    ).toContain("did not name");
    expect(
      evaluateProviderToolProbe(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: PROVIDER_TOOL_PROBE_NAME, arguments: '{"word":"x"}' } },
                ],
              },
            },
          ],
        },
        "tool-abcdef01",
      ).error,
    ).toContain("check word");
  });

  it("fails a provider that returns no text, and one that ignores the second system message", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The pre-fix Claude 5 shape: thinking only — no text block at all.
      if (url.includes("anthropic.com"))
        return anthropicReply([{ type: "thinking", thinking: "…" }]);
      if (url.includes("openai.com")) return openaiReply("I have no check word.");
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const [anthropic, openai] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(anthropic).toMatchObject({ provider: "anthropic", ok: false, textOk: false });
    expect(openai).toMatchObject({
      provider: "openai",
      ok: false,
      textOk: true,
      systemHonored: false,
    });
    const lines = renderProviderProbe([anthropic!, openai!]).join("\n");
    expect(lines).toContain("EMPTY TEXT");
    expect(lines).toContain("SECOND SYSTEM MESSAGE IGNORED");
    expect(lines).toContain("would be dropped for this provider");
  });

  it("fails a provider whose reply was actually served by the fallback provider", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENROUTER_API_KEY = "expired";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const nonce = nonceOf(init);
      if (url.includes("openrouter.ai"))
        return new Response(JSON.stringify({ error: { message: "API key expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("anthropic.com")) return anthropicReply([{ type: "text", text: nonce }]);
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const results = await probeConfiguredProviders(engine, {
      providers: ["openrouter"],
      timeoutMs: 5_000,
    });
    expect(results).toHaveLength(1);
    const [openrouter] = results;
    // The proxy fell back to Anthropic and returned a perfectly good answer —
    // the probe must not credit OpenRouter for it.
    expect(openrouter).toMatchObject({
      provider: "openrouter",
      ok: false,
      status: 200,
      textOk: true,
      systemHonored: true,
    });
    expect(openrouter!.servedBy).toMatch(/^anthropic\//);
    expect(openrouter!.error).toContain("served by fallback anthropic/");
    expect(renderProviderProbe(results).join("\n")).toContain("served by fallback");
  });

  it("reports an upstream error and a transport failure without throwing", async () => {
    process.env.OPENAI_API_KEY = "k";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const [failed] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(failed).toMatchObject({ ok: false });
    expect(failed!.status).not.toBe(200);
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const [down] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(down).toMatchObject({ ok: false });
    expect(down!.error ?? "").not.toBe("");
  });
});

describe("readiness providers command", () => {
  const fixture: ProviderProbeResult[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      ok: true,
      status: 200,
      latencyMs: 812,
      textOk: true,
      systemHonored: true,
      text: "probe-1",
      checkedAt: 0,
    },
  ];
  function run(rank: number, args: string) {
    const sent: string[] = [];
    const cmd = readinessCommand({
      readiness: () => {
        throw new Error("not used");
      },
      probeProviders: async () => fixture,
    });
    const ctx = { send: (_e: EntityId, text: string) => sent.push(text), caller: { rank } };
    const tokens = args.split(/\s+/).filter(Boolean);
    return Promise.resolve(
      cmd.handler(ctx as never, {
        raw: `readiness ${args}`,
        verb: "readiness",
        args,
        tokens,
        entity: "e_1" as EntityId,
        room: roomId("test/start"),
      }),
    ).then(() => sent.join("\n"));
  }

  it("renders the probe for an operator and refuses low rank on a gated instance", async () => {
    setTrustProfile("shared");
    expect(await run(0, "providers")).toContain(`rank ${PROVIDER_PROBE_MIN_RANK}+`);
    expect(await run(PROVIDER_PROBE_MIN_RANK, "providers")).toContain(
      "✓ anthropic/claude-sonnet-5 — HTTP 200 · text ok · second system message honored · tool call not probed · 812 ms",
    );
    setTrustProfile("local");
    expect(await run(0, "providers")).toContain("✓ anthropic/claude-sonnet-5");
  });
});
