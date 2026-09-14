// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { getInternalModelToken } from "../../src/agent/agent-runtime";
import { Engine } from "../../src/engine/engine";
import { serveMemory } from "../../src/memory/server";
import { setEndpointConfig } from "../../src/net/model-endpoint";
import { WebSocketServer } from "../../src/net/websocket-server";
import { MarinaDB } from "../../src/persistence/database";
import type { MemoryAnswerContract } from "../../src/sdk/memory-answer";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import type { MemoryQueryVocabulary } from "../../src/sdk/memory-expansion";
import type { MemoryOperationRequest } from "../../src/sdk/memory-operations";
import type { MemoryTaskResult } from "../../src/sdk/memory-task";
import { roomId } from "../../src/types";
import { evaluationBudgetFetch } from "./memory-evaluation-budget";

export interface LiveTask {
  task: string;
  contract: MemoryAnswerContract;
  instructions?: string;
  operations: MemoryOperationRequest["operation"][];
  maxTurns?: number;
  expansionVocabulary?: MemoryQueryVocabulary;
}
export interface LiveResult extends MemoryTaskResult {
  usage: {
    model: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    };
  }[];
  pid: number;
  elapsed_ms: number;
  resident: boolean;
  resident_checkpoint: Record<string, unknown> | null;
}

/** Isolated real service/router, explicit upstream spending bound, sanitized
 * child environment. Artifacts belong outside the public repository. */
export function createLiveMemoryRuntime(
  directory: string,
  budget: number,
  options: { inputLimit?: number } = {},
) {
  if (!Number.isFinite(budget) || budget <= 0 || budget > 20)
    throw new Error("Explicit budget must be >0 and <=20 USD");
  process.env.WS_HOST = "127.0.0.1";
  const db = new MarinaDB(`${directory}/world.db`, { durability: "full" });
  db.setSetting("default_model", "openai/gpt-5.6-luna");
  setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-5.6-luna" });
  const engine = new Engine({ db, startRoom: roomId("qualification/start"), tickInterval: 100 });
  engine.registerRoom(roomId("qualification/start"), {
    short: "Memory workshop",
    long: "Private disposable memory qualification",
    exits: {},
  });
  const router = new WebSocketServer(engine, 0);
  router.setDb(db);
  router.start();
  engine.start();
  const memory = serveMemory({ dbPath: `${directory}/memory.db`, port: 0 });
  const owner = memory.db.ensurePrincipal({ type: "service", displayName: "workflow-owner" });
  const credential = memory.db.issueMemoryCredential(owner.principal_id);
  const client = new MarinaMemoryClient(`http://127.0.0.1:${memory.server.port}`, credential.token);
  const spending = {
    ceiling: budget,
    reserved: 0,
    attempts: 0,
    maxAttempts: 600,
    model: "gpt-5.6-luna",
    tokenParameter: "max_completion_tokens" as const,
    outputLimit: 1500,
    inputLimit: options.inputLimit ?? 65536,
    inputPerMillion: 0.25,
    outputPerMillion: 1.2,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = evaluationBudgetFetch(originalFetch, spending);
  const gateToken = crypto.randomUUID();
  const gate = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: spending.inputLimit,
    idleTimeout: 60,
    async fetch(request) {
      if (request.headers.get("Authorization") !== `Bearer ${gateToken}`)
        return new Response("Unauthorized", { status: 401 });
      const body = (await request.json()) as Record<string, unknown>;
      if (
        body.model !== "marina/default" ||
        body.reasoning_effort !== "none" ||
        body.max_completion_tokens !== 1500 ||
        body.max_tokens !== undefined
      )
        return new Response("Unapproved model contract", { status: 400 });
      return fetch(`http://127.0.0.1:${router.getPort()}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getInternalModelToken()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
      });
    },
  });
  return {
    db,
    engine,
    router,
    memory,
    client,
    credential,
    spending,
    async run(
      task: LiveTask,
      space: string,
      condition = "portable",
      resident?: string,
    ): Promise<LiveResult> {
      const child = Bun.spawn(
        [process.execPath, resolve("examples/memory-service/workflow-agent.ts")],
        {
          cwd: directory,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            MARINA_MEMORY_URL: client.url,
            MARINA_MEMORY_TOKEN: credential.token,
            MARINA_MEMORY_SPACE: space,
            MARINA_EVAL_CONDITION: condition,
            MARINA_EVAL_ROUTER_URL: `http://127.0.0.1:${gate.port}`,
            MARINA_EVAL_ROUTER_TOKEN: gateToken,
            ...(resident
              ? {
                  MARINA_RESIDENT_URL: `ws://127.0.0.1:${router.getPort()}`,
                  MARINA_RESIDENT_NAME: resident,
                }
              : {}),
          },
        },
      );
      child.stdin.write(JSON.stringify(task));
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 270000);
      try {
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code) throw new Error(`Workflow agent failed (${code}): ${err.slice(-1500)}`);
        return JSON.parse(out.trim().split("\n").at(-1)!);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      gate.stop(true);
      router.stop();
      await Bun.sleep(30); // Drain socket-close event persistence before closing the DB.
      engine.stop();
      await memory.close();
      db.close();
      globalThis.fetch = originalFetch;
    },
  };
}
