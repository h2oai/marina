// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider auth refusals: a 401/403 parks the autonomous loop visibly
 * (`provider-auth`), tells the spawner once per outage, and resumes when the
 * credentials change. Transient errors keep the ordinary backoff.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter, operatorStatusOf } from "../src/agent/lean-agent-adapter";
import {
  isProviderAuthError,
  providerAuthProbeMs,
  providerCredentialsFingerprint,
  providerErrorStatus,
} from "../src/agent/provider-auth";
import { until } from "./helpers";

describe("isProviderAuthError", () => {
  it("matches 401/403 and provider invalid-key bodies", () => {
    // pi-ai's openai-completions (proxy) and anthropic-messages shapes.
    expect(
      isProviderAuthError('401: {"type":"authentication_error","message":"invalid x-api-key"}'),
    ).toBe(true);
    expect(
      isProviderAuthError(
        '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe(true);
    expect(isProviderAuthError("401 Incorrect API key provided: sk-xxxx")).toBe(true);
    expect(isProviderAuthError("403 permission_error: model not allowed")).toBe(true);
    expect(isProviderAuthError("No API key for provider: anthropic")).toBe(true);
  });

  it("leaves transient errors alone", () => {
    for (const msg of [
      "429 rate_limit_error: slow down",
      "500 Internal Server Error",
      "503 overloaded_error",
      "fetch failed",
      "ECONNRESET",
      "Request timed out.",
      "upstream returned 4010 tokens",
    ]) {
      expect(isProviderAuthError(msg)).toBe(false);
    }
  });

  it("reads the leading status", () => {
    expect(providerErrorStatus("401: nope")).toBe(401);
    expect(providerErrorStatus("403 nope")).toBe(403);
    expect(providerErrorStatus("No API key")).toBeUndefined();
  });

  it("probes back off from 5 min to a 60 min ceiling", () => {
    expect(providerAuthProbeMs(1)).toBe(300_000);
    expect(providerAuthProbeMs(2)).toBe(600_000);
    expect(providerAuthProbeMs(5)).toBe(3_600_000);
    expect(providerAuthProbeMs(50)).toBe(3_600_000);
  });

  it("fingerprints key values without exposing them", () => {
    const a = providerCredentialsFingerprint([], { ANTHROPIC_API_KEY: "sk-a", PATH: "/x" });
    const b = providerCredentialsFingerprint([], { ANTHROPIC_API_KEY: "sk-b", PATH: "/x" });
    const c = providerCredentialsFingerprint([], { ANTHROPIC_API_KEY: "sk-a", PATH: "/y" });
    expect(a).not.toBe(b);
    expect(a).toBe(c); // non-credential env is ignored
    expect(a).not.toContain("sk-a");
    expect(providerCredentialsFingerprint(["row"], {})).not.toBe(
      providerCredentialsFingerprint([], {}),
    );
  });
});

type Internals = {
  client: { command: (cmd: string) => Promise<unknown>; isConnected: () => boolean };
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  cycleWaiter: { wake(): void };
  startupAuthError: string | null;
  runAutonomousLoop(): Promise<void>;
  sleep(ms: number): Promise<void>;
  lastTurnError(): string | null;
  agent: { prompt(text: string): Promise<void> };
};

const AUTH_BODY = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
});

function okStream(): Response {
  const chunk = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "default",
    choices: [
      { index: 0, delta: { role: "assistant", content: "resting." }, finish_reason: "stop" },
    ],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeAdapter(respond: () => Response) {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return respond();
  }) as unknown as typeof fetch;
  const adapter = new LeanAgentAdapter(
    { name: "bob", model: "marina/default", spawnedBy: "Boss" },
    "ws://localhost:39999",
    null,
    "internal-token",
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
  return { adapter, internals, sent, calls: () => calls };
}

async function stopLoop(internals: Internals, loop: Promise<void>): Promise<void> {
  internals.autonomousLoopRunning = false;
  internals.autonomousMode = false;
  internals.cycleWaiter.wake();
  await loop;
}

describe("LeanAgentAdapter provider-auth park", () => {
  it("a discovery-turn 401 is reported as a failure, not a completion", async () => {
    const { internals } = makeAdapter(
      () =>
        new Response(AUTH_BODY, { status: 401, headers: { "content-type": "application/json" } }),
    );
    await internals.agent.prompt("Begin.");
    expect(internals.lastTurnError()).toContain("401");
  });

  it("parks on 401, tells the spawner once, retries on key change, resumes on success", async () => {
    let status = 401;
    const { adapter, internals, sent, calls } = makeAdapter(() =>
      status === 401
        ? new Response(AUTH_BODY, { status: 401, headers: { "content-type": "application/json" } })
        : okStream(),
    );
    let fingerprint = "key-a";
    adapter.setCredentialsFingerprint(() => fingerprint);
    const tells = () => sent.filter((c) => c.startsWith("tell Boss"));

    internals.autonomousLoopRunning = true;
    internals.autonomousMode = true;
    const loop = internals.runAutonomousLoop();
    internals.cycleWaiter.wake(); // skip the idle first delay

    await until(() => operatorStatusOf(adapter)?.paused?.kind === "provider-auth");
    const paused = operatorStatusOf(adapter)?.paused;
    expect(paused?.reason).toContain("status:401");
    expect(paused?.reason).toContain("marina/default");
    expect(paused?.until).toBeGreaterThan(Date.now() + 60_000); // slow probe, not a hot loop
    expect(adapter.getStatus().state).not.toBe("error");
    expect(tells()).toHaveLength(1);
    expect(tells()[0]).toContain("[notice] provider rejected key (401, marina/default via /v1)");
    expect(tells()[0]).toContain("readiness providers");
    expect(calls()).toBe(1);

    // Same (still bad) key replaced: the loop calls again at once, is refused
    // again, re-parks — and does not tell the spawner a second time.
    fingerprint = "key-b";
    // Each wake cuts a parked poll or the next cycle delay short.
    const wakeUntil = (cond: () => boolean) =>
      until(() => {
        internals.cycleWaiter.wake();
        return cond();
      });
    await wakeUntil(() => calls() === 2);
    await until(() => operatorStatusOf(adapter)?.paused?.kind === "provider-auth");
    expect(tells()).toHaveLength(1);

    // A working key: the next call succeeds, the park lifts, the spawner hears once.
    status = 200;
    fingerprint = "key-c";
    await wakeUntil(() => calls() === 3);
    await until(() => tells().length === 2);
    expect(tells()[1]).toContain("provider auth ok");
    expect(operatorStatusOf(adapter)?.paused).toBeNull();

    await stopLoop(internals, loop);
  }, 10_000);

  it("a discovery-turn refusal parks the loop without another call", async () => {
    const { adapter, internals, sent, calls } = makeAdapter(() => okStream());
    internals.startupAuthError = "401: invalid x-api-key";
    internals.autonomousLoopRunning = true;
    internals.autonomousMode = true;
    const loop = internals.runAutonomousLoop();
    internals.cycleWaiter.wake();
    await until(() => operatorStatusOf(adapter)?.paused?.kind === "provider-auth");
    expect(calls()).toBe(0);
    expect(sent.filter((c) => c.startsWith("tell Boss"))).toHaveLength(1);
    await stopLoop(internals, loop);
  }, 10_000);

  it("a transient 503 keeps the ordinary backoff (no park, no notice)", async () => {
    // `x-should-retry: false` skips the SDK's own retries so one call is one error.
    const { adapter, internals, sent, calls } = makeAdapter(
      () => new Response("overloaded", { status: 503, headers: { "x-should-retry": "false" } }),
    );
    const backoffs: number[] = [];
    // Record the loop's backoff instead of sleeping it, and stop after the first.
    internals.sleep = async (ms: number) => {
      backoffs.push(ms);
      internals.autonomousLoopRunning = false;
      internals.autonomousMode = false;
    };
    internals.autonomousLoopRunning = true;
    internals.autonomousMode = true;
    const loop = internals.runAutonomousLoop();
    internals.cycleWaiter.wake();
    await loop;
    expect(calls()).toBe(1);
    expect(backoffs).toEqual([5_000]);
    expect(operatorStatusOf(adapter)?.consecutiveErrors).toBe(1);
    expect(operatorStatusOf(adapter)?.paused).toBeNull();
    expect(sent.filter((c) => c.startsWith("tell Boss"))).toHaveLength(0);
  });
});
