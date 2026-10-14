// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An agent on a first-party model whose direct key hits a usage limit keeps
 * working on the SAME model via OpenRouter (no pause, labelled), and pauses
 * with a route-specific reason only when no other route serves the model.
 * Auth refusals still park via provider-auth. Fake provider fetch only.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { LeanAgentAdapter, operatorStatusOf } from "../src/agent/lean-agent-adapter";
import {
  primeOpenRouterCatalogForTests,
  resetOpenRouterPricesForTests,
} from "../src/agent/provider-cost";
import { resetRouteHealthForTests, routeLimitOf } from "../src/net/model/route-health";
import { until } from "./helpers";

afterEach(() => {
  resetRouteHealthForTests();
  resetOpenRouterPricesForTests();
});

type Internals = {
  client: { command: (cmd: string) => Promise<unknown>; isConnected: () => boolean };
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  cycleWaiter: { wake(): void };
  runAutonomousLoop(): Promise<void>;
  pendingPerceptions: Array<{ text: string; priority: number }>;
  lastUpstreamModel: string | null;
};

const LIMIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "You have reached your specified workspace API usage limits. You will regain access on 2099-11-01 at 00:00 UTC.",
  },
});

const AUTH_BODY = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
});

/** A minimal Anthropic Messages SSE reply (OpenRouter serves Claude in the same shape). */
function anthropicStream(model: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "resting." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeAdapter(respond: (url: URL, body: { model?: string }) => Response) {
  const seen: { host: string; path: string; model?: string; auth?: string | null }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = (await req.json()) as { model?: string };
    seen.push({
      host: url.host,
      path: url.pathname,
      model: body.model,
      auth: req.headers.get("x-api-key") ?? req.headers.get("authorization"),
    });
    return respond(url, body);
  }) as unknown as typeof fetch;
  const adapter = new LeanAgentAdapter(
    { name: "bob", model: "anthropic/claude-opus-5-5", spawnedBy: "Boss" },
    "ws://localhost:39999",
    null,
    "sk-ant-direct",
    undefined,
    undefined,
    fakeFetch,
  );
  const internals = adapter as unknown as Internals;
  const sent: string[] = [];
  internals.client.command = async (cmd: string) => {
    sent.push(cmd);
    return { ok: true };
  };
  internals.client.isConnected = () => true;
  return { adapter, internals, sent, seen };
}

function start(internals: Internals): Promise<void> {
  internals.autonomousLoopRunning = true;
  internals.autonomousMode = true;
  internals.pendingPerceptions.push({ text: "[message] Boss: status?", priority: 50 });
  const loop = internals.runAutonomousLoop();
  internals.cycleWaiter.wake();
  return loop;
}

async function stop(internals: Internals, loop: Promise<void>): Promise<void> {
  internals.autonomousLoopRunning = false;
  internals.autonomousMode = false;
  internals.cycleWaiter.wake();
  await loop;
}

describe("agent loop: usage-limited direct route", () => {
  it("serves the same model via OpenRouter without pausing, and says so once", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const { adapter, internals, sent, seen } = makeAdapter((url) =>
      url.host === "api.anthropic.com"
        ? new Response(LIMIT_BODY, { status: 400, headers: { "content-type": "application/json" } })
        : anthropicStream("anthropic/claude-opus-5.5"),
    );
    adapter.setRouteKeyResolver((p) => (p === "openrouter" ? "sk-or-test" : undefined));
    const loop = start(internals);
    // Each wake cuts the next cycle delay short; a fresh message gives it work.
    await until(() => {
      if (internals.pendingPerceptions.length === 0)
        internals.pendingPerceptions.push({ text: "[message] Boss: status?", priority: 50 });
      internals.cycleWaiter.wake();
      return seen.some((s) => s.host === "openrouter.ai");
    });
    await until(() => sent.some((c) => c.startsWith("tell Boss")));
    await stop(internals, loop);

    expect(seen[0]).toMatchObject({ host: "api.anthropic.com", model: "claude-opus-5-5" });
    const or = seen.find((s) => s.host === "openrouter.ai")!;
    // The SAME model, OpenRouter's id, OpenRouter's key — never the direct key.
    expect(or.model).toBe("anthropic/claude-opus-5.5");
    expect(or.auth).toContain("sk-or-test");
    expect(or.auth).not.toContain("sk-ant-direct");
    const tell = sent.find((c) => c.startsWith("tell Boss"))!;
    expect(tell).toContain("model:anthropic/claude-opus-5-5 via:openrouter");
    expect(tell).toContain("Anthropic API (direct key): usage limit until 2099-11-01 00:00 UTC");
    expect(tell).not.toContain("budget");
    expect(operatorStatusOf(adapter)?.paused).toBeNull();
    expect(internals.lastUpstreamModel).toBe("openrouter/anthropic/claude-opus-5.5");
    expect(routeLimitOf("anthropic")?.resetAt).toBe(Date.parse("2099-11-01T00:00:00Z"));
  }, 10_000);

  it("with no other route: pauses naming the route and the reset, tells the spawner once", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const { adapter, internals, sent } = makeAdapter(
      () =>
        new Response(LIMIT_BODY, { status: 400, headers: { "content-type": "application/json" } }),
    );
    adapter.setRouteKeyResolver(() => undefined);
    const loop = start(internals);
    await until(() => operatorStatusOf(adapter)?.paused?.kind === "route-limit");
    const paused = operatorStatusOf(adapter)!.paused!;
    expect(paused.reason).toBe(
      "Anthropic API (direct key) usage limit until 2099-11-01 00:00 UTC — no other route serves anthropic/claude-opus-5-5",
    );
    expect(paused.until).toBe(Date.parse("2099-11-01T00:00:00Z"));
    const tells = sent.filter((c) => c.startsWith("tell Boss"));
    expect(tells).toHaveLength(1);
    expect(tells[0]).toContain("OPENROUTER_API_KEY would serve the same model");
    expect(tells[0]).not.toContain("model budget exhausted");
    await stop(internals, loop);
  }, 10_000);

  it("an auth refusal on the direct key still parks via provider-auth", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const { adapter, internals, seen } = makeAdapter(
      () =>
        new Response(AUTH_BODY, { status: 401, headers: { "content-type": "application/json" } }),
    );
    adapter.setRouteKeyResolver((p) => (p === "openrouter" ? "sk-or-test" : undefined));
    const loop = start(internals);
    await until(() => operatorStatusOf(adapter)?.paused?.kind === "provider-auth");
    expect(seen.every((s) => s.host === "api.anthropic.com")).toBe(true);
    expect(routeLimitOf("anthropic")).toBeUndefined();
    await stop(internals, loop);
  }, 10_000);
});

describe("discovery turn: usage-limited direct route", () => {
  it("records the limit and runs the discovery turn via OpenRouter", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const { adapter, internals, seen } = makeAdapter((url) =>
      url.host === "api.anthropic.com"
        ? new Response(LIMIT_BODY, { status: 400, headers: { "content-type": "application/json" } })
        : anthropicStream("anthropic/claude-opus-5.5"),
    );
    adapter.setRouteKeyResolver((p) => (p === "openrouter" ? "sk-or-test" : undefined));
    const i = internals as unknown as {
      bootstrap(): Promise<void>;
      lastTurnError(): string | null;
      loadCheckpointSummary(): Promise<string | null>;
      recallInheritedWisdom(): Promise<string>;
      refreshLoopPreferences(): Promise<void>;
      platformMemory: { getFocus(): Promise<unknown>; saveFocus(f: unknown): Promise<unknown> };
    };
    i.loadCheckpointSummary = async () => null;
    i.recallInheritedWisdom = async () => "";
    i.refreshLoopPreferences = async () => {};
    i.platformMemory.getFocus = async () => null;
    i.platformMemory.saveFocus = async () => ({ success: true });
    // Not autonomous: bootstrap runs the discovery turn and returns before the loop.
    internals.autonomousMode = false;
    await i.bootstrap();
    expect(seen[0]).toMatchObject({ host: "api.anthropic.com" });
    expect(
      seen.some((s) => s.host === "openrouter.ai" && s.model === "anthropic/claude-opus-5.5"),
    ).toBe(true);
    expect(i.lastTurnError()).toBeNull();
    expect(routeLimitOf("anthropic")?.resetAt).toBe(Date.parse("2099-11-01T00:00:00Z"));
  }, 10_000);
});
