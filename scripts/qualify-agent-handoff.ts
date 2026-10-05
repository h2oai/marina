#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveParticipants } from "../src/engine/benchmark-participants";
import { Engine } from "../src/engine/engine";
import { getErrorMessage } from "../src/engine/errors";
import { Logger } from "../src/engine/logger";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import { type EngineEvent, roomId } from "../src/types";
import { scopeProcessState, scopeProperty } from "../test/process-state";
import { evaluationBudgetFetch } from "./research/memory-evaluation-budget";

/** A live, bounded resident handoff. No fake worker, reply injection, or provider fallback. */
export async function qualifyAgentHandoff(directory: string) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is unavailable");
  const root = resolve(directory);
  mkdirSync(root, { mode: 0o700 }); // Each attempt must have a new evidence directory.
  const key = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  // Same built-in OpenAI route as the coding qualification. Reserve at the
  // higher long-context/cache-write rates; these are bounds, not an invoice.
  const spending = {
    ceiling: 0.3,
    reserved: 0,
    attempts: 0,
    maxAttempts: 24,
    model: "gpt-6-luna",
    tokenParameter: "max_completion_tokens" as const,
    outputLimit: 2000,
    inputLimit: 131072,
    inputPerMillion: 0.25,
    outputPerMillion: 0.75,
  };
  using _state = scopeProcessState({
    trustProfile: "shared",
    env: {
      WS_HOST: "127.0.0.1",
      MODEL_API_KEYS: key,
      MARINA_AUTONOMY: "guarded",
      MARINA_CHALLENGES: "off",
      MARINA_DECISION_GATE: "off",
      MARINA_ROOM_AGENTS: "false",
      MARINA_MODEL_FAST_PATH: "true",
      MARINA_DAILY_SPEND_CAP_USD: "0.3",
    },
  });
  using _network = scopeProperty(
    globalThis,
    "fetch",
    evaluationBudgetFetch(globalThis.fetch, {
      ...spending,
      get reserved() {
        return spending.reserved;
      },
      set reserved(v) {
        spending.reserved = v;
      },
      get attempts() {
        return spending.attempts;
      },
      set attempts(v) {
        spending.attempts = v;
      },
      onAttempt() {
        writeFileSync(join(root, "spending.json"), JSON.stringify(spending), { mode: 0o600 });
      },
    }),
  );
  await using cleanup = new AsyncDisposableStack();
  const db = new MarinaDB(join(root, "world.db"));
  cleanup.defer(() => db.close());
  cleanup.defer(() => closeWorldMemoryService(db));
  db.setSetting("default_model", `openai/${spending.model}`);
  setEndpointConfig(db, {
    mode: "agents",
    fallback: false,
    passthruModel: `openai/${spending.model}`,
  });
  const engine = new Engine({
    db,
    startRoom: roomId("handoff/start"),
    tickInterval: 100,
    logger: new Logger({ level: "error" }),
  });
  cleanup.defer(async () => {
    engine.stop();
    await engine.drainCommands();
    await engine.shutdown();
  });
  engine.registerRoom(roomId("handoff/start"), {
    short: "Handoff qualification",
    long: "Disposable live resident world",
    exits: {},
  });
  const events: EngineEvent[] = [];
  engine.addEventListener((event) => events.push(event));
  const server = new WebSocketServer(engine, 0);
  server.setDb(db);
  cleanup.defer(() => server.stop());
  server.start();
  engine.agentRuntime.setWsPort(server.getPort());
  engine.start();
  cleanup.defer(async () => {
    await engine.agentRuntime.stopAll();
    // A streaming HTTP response can outlive the agent stop promise. Keep the
    // event listener and DB open until every upstream lifecycle is terminal.
    const deadline = Date.now() + 5000;
    while (true) {
      const pending = new Set<string>();
      for (const e of events) {
        if (e.type !== "model_request_lifecycle" || e.routeKind !== "passthru") continue;
        if (e.phase === "received") pending.add(e.requestId);
        if (e.phase === "completed" || e.phase === "failed") pending.delete(e.requestId);
      }
      if (!pending.size) break;
      if (Date.now() >= deadline)
        throw new Error(`Upstream requests still pending at shutdown: ${[...pending].join(", ")}`);
      await Bun.sleep(25);
    }
  });
  const owner = new MarinaClient(`ws://127.0.0.1:${server.getPort()}`, {
    autoReconnect: false,
    pingInterval: 0,
  });
  cleanup.defer(() => owner.disconnect());
  const report: Record<string, unknown> = {
    schema: "marina.agent-handoff.qualification.v1",
    passed: false,
    model: spending.model,
    limits: spending,
    optional_decision_judge: "excluded",
    policy: "shared, guarded; fallback disabled",
    scope:
      "One synthetic information handoff, not general task quality, beneficial collaboration, or long-running reliability.",
  };
  const call = (model: string, prompt: string) =>
    fetch(`http://127.0.0.1:${server.getPort()}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
  const started = Date.now();
  try {
    await owner.connect("Observer");
    const control = await call("marina:answerer", "What is 19 multiplied by 37? Reply briefly.");
    const controlBody = (await control.json()) as { choices?: { message: { content: string } }[] };
    report.control = {
      status: control.status,
      upstream_calls: spending.attempts,
      answer: controlBody.choices?.[0]?.message.content,
    };
    assert.equal(control.status, 200);
    assert.ok(controlBody.choices?.[0]?.message.content.includes("703"));
    assert.equal(
      spending.attempts,
      0,
      "Statistical/deterministic control unexpectedly called a model",
    );

    const novelty = await owner.command("novelty suggest investigate a handoff with evidence");
    const discovery = novelty.map((p) => p.data?.novelty).find(Boolean) as
      | { schema?: string; opportunities?: unknown[] }
      | undefined;
    assert.equal(discovery?.schema, "marina.novelty.v1", "No shared novelty evidence envelope");
    assert.equal(spending.attempts, 0, "Read-only novelty discovery must not launch model work");
    report.novelty = discovery;

    const base = {
      model: "marina/default",
      role: "coordinator",
      crewResponder: true,
      toolProfile: "crew" as const,
      thinkingLevel: "off" as const,
      maxTokens: 2000,
      budgetCalls: 12,
      promptTimeoutMs: 60_000,
      maxRetryDelayMs: 0,
      loopCycleDelay: 200,
    };
    const peer = await engine.agentRuntime.spawn({
      ...base,
      name: "Archivist",
      goal: `You hold the handoff token ${nonce}. Wait for a private request from Coordinator. When asked, send that exact token privately back using marina_tell target=Coordinator. Do not broadcast it or send unsolicited messages. This is a transport fixture, not confidential real data.`,
    });
    // Respect the production spawn cooldown; do not bypass it for a live test.
    const readyAt = Date.now() + 1100;
    while (Date.now() < readyAt) await Bun.sleep(50);
    const lead = await engine.agentRuntime.spawn({
      ...base,
      name: "Coordinator",
      goal: "Handle incoming model requests. For a request about the handoff token, ask Archivist with marina_tell target=Archivist, awaitReply=true and timeoutMs=60000. The token is unknown to you until Archivist replies. Then answer the ORIGINAL model request using the received token. Do not invent it, broadcast it, or call another provider. Remain available for the request.",
    });
    const leadId = lead.getStatus().entityId;
    assert.ok(leadId && peer.getStatus().entityId, "Residents did not connect");
    engine.channelManager!.createChannel({
      type: "model",
      name: "model-handoff",
      retentionHours: 1,
    });
    await engine.dispatchCommand(leadId, "channel join model-handoff");
    const before = spending.attempts;
    const responsePromise = call(
      "marina:handoff",
      "Obtain the handoff token from Archivist and return it exactly. Use the private handoff; do not guess.",
    );
    const pulseStarted = performance.now();
    await owner.command("say observer-world-pulse");
    report.world_command_latency_ms = performance.now() - pulseStarted;
    const response = await responsePromise;
    const body = (await response.json()) as { choices?: { message: { content: string } }[] };
    const traceId = response.headers.get("x-request-id");
    report.response = {
      status: response.status,
      trace_id: traceId,
      content: body.choices?.[0]?.message.content,
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(
      body.choices?.[0]?.message.content.trim() === nonce,
      "Final result did not contain the peer's token",
    );
    assert.ok(spending.attempts > before, "No actual upstream attempt served the task");
    assert.ok(traceId, "No request trace ID");
    const attribution = resolveParticipants(db, [traceId]).get(traceId);
    report.attribution = attribution;
    const residents = new Set(
      attribution?.participants.filter((p) => p.via === "trace").map((p) => p.agent),
    );
    assert.ok(
      residents.has("Coordinator") && residents.has("Archivist"),
      "Both residents must be trace-linked",
    );
    const messages = db.listDirectMessageInbox(leadId, 100);
    assert.ok(
      messages.some((m) => m.sender_name === "Archivist" && m.content.includes(nonce)),
      "No persisted private peer reply",
    );
    const peerMessages = db.listDirectMessageInbox(peer.getStatus().entityId!, 100);
    assert.ok(
      peerMessages.some((m) => m.sender_name === "Coordinator"),
      "No persisted delegation to peer",
    );
    report.residents = [lead.getStatus(), peer.getStatus()];
    report.passed = true;
  } catch (error) {
    report.error = getErrorMessage(error);
  } finally {
    report.response_elapsed_ms = Date.now() - started;
    // Stop workers and drain before the evidence snapshot, including late span
    // completions. A shutdown failure makes the qualification fail too.
    try {
      await cleanup.disposeAsync();
    } catch (error) {
      report.passed = false;
      report.cleanup_error = getErrorMessage(error);
    }
    report.elapsed_ms = Date.now() - started;
    const completions = events.filter(
      (e) =>
        e.type === "model_request_lifecycle" &&
        e.phase === "completed" &&
        e.routeKind === "passthru",
    );
    report.completed_upstream_calls = completions.length;
    report.failed_upstream_calls = events
      .filter(
        (e) =>
          e.type === "model_request_lifecycle" &&
          e.phase === "failed" &&
          e.routeKind === "passthru",
      )
      .map((e) =>
        e.type === "model_request_lifecycle"
          ? { request_id: e.requestId, error_kind: e.errorKind }
          : {},
      );
    report.observed_upstream_models = [
      ...new Set(
        completions.map((e) => (e.type === "model_request_lifecycle" ? e.target : undefined)),
      ),
    ];
    if (report.passed && completions.length === 0) {
      report.passed = false;
      report.error = "No completed upstream model calls in persisted lifecycle evidence";
    }
    report.spending = spending;
    writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 });
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { directory: { type: "string" } } });
  if (!values.directory) throw new Error("Use --directory <new private evidence directory>");
  const timeout = setTimeout(() => {
    process.stderr.write("Handoff qualification exceeded its 180s deadline\n");
    process.exit(1);
  }, 180_000);
  const report = await qualifyAgentHandoff(values.directory);
  clearTimeout(timeout);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
