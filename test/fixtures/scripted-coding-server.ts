// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A live Marina whose coder runs on a scripted model: given the task "lastPage loses a
// partial last page", it edits source.ts, runs the checks on the change, waits for them to
// pass, and hands in. SDK tests in every language drive one coding run against it. One run
// per server: the script does not reset.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine/engine";
import { Logger } from "../../src/engine/logger";
import { closeWorldMemoryService } from "../../src/memory/world-service";
import { setEndpointConfig } from "../../src/net/model/model-endpoint";
import { WebSocketServer } from "../../src/net/websocket-server";
import { MarinaDB } from "../../src/persistence/database";
import { roomId } from "../../src/types";
import { scopeProcessState, scopeProperty } from "../process-state";

/** The task the scripted coder knows how to do. */
export const SCRIPTED_TASK = "lastPage loses a partial last page; fix it";

export interface ScriptedCodingServer {
  url: string;
  db: MarinaDB;
  engine: Engine;
  workspace: string;
  dispose(): Promise<void>;
}

/** Start it. `admins` are the login names that run as operators. */
export async function startScriptedCodingServer(admins: string[]): Promise<ScriptedCodingServer> {
  let stage = 0;
  const scratch = mkdtempSync(join(tmpdir(), "marina-scripted-coding-"));
  const workspace = join(scratch, "project");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "source.ts"),
    "export function lastPage(total: number, size: number) {\n  return Math.floor(total / size);\n}\n",
  );
  writeFileSync(
    join(workspace, "acceptance.test.ts"),
    'import { expect, test } from "bun:test";\nimport { lastPage } from "./source";\ntest("pages", () => { expect(lastPage(10, 3)).toBe(4); expect(lastPage(9, 3)).toBe(3); });\n',
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ private: true, scripts: { test: "bun test" } }),
  );
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: workspace,
    });
  git("init", "--quiet", "--template=");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");

  const cleanup = new AsyncDisposableStack();
  cleanup.use(
    scopeProcessState({
      trustProfile: "shared",
      env: {
        WS_HOST: "127.0.0.1",
        OPENAI_API_KEY: "scripted-provider-only",
        OPENROUTER_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        MARINA_ADMINS: admins.join(","),
        MARINA_CODE_ROOTS: workspace,
        MARINA_CODE_DEFAULT_ROOT: workspace,
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
        MARINA_DECISION_GATE: "off",
        MARINA_DECISIONS: "off",
        MARINA_DECISION_ENGINE: undefined,
        MARINA_MEMORY_EMBEDDINGS: "none",
        MARINA_CORPUS_EMBEDDINGS: "none",
        MARINA_ROOM_AGENTS: "false",
        MARINA_CODE_VERIFY_DEPENDENCIES: "check",
      },
    }),
  );
  const network = globalThis.fetch;
  // The scripted coder: fix the bug, run the checks on the change, hand it in.
  const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.hostname === "127.0.0.1" || target.hostname === "localhost") return network(request);
    if (target.href !== "https://api.openai.com/v1/chat/completions")
      throw new Error(`The scripted model does not serve ${target.href}`);
    const body = (await request.json()) as {
      model: string;
      stream?: boolean;
      messages?: unknown[];
      tools?: { function: { name: string } }[];
    };
    // Act only once the task has been handed over (not in the startup prompt).
    const transcript = JSON.stringify(body.messages ?? []);
    const assigned = transcript.includes("partial last page");
    const names = body.tools?.map((t) => t.function.name) ?? [];
    let tool: { name: string; arguments: string } | undefined;
    const call = (name: string, args: Record<string, unknown>) => {
      if (!names.includes(name) && names.includes("marina_code")) {
        args = { action: name.replace("marina_code_", ""), ...args };
        name = "marina_code";
      }
      if (names.includes(name)) tool = { name, arguments: JSON.stringify(args) };
    };
    if (!assigned) {
      // waiting for the task
    } else if (stage === 0) {
      call("marina_code_edit", {
        path: "source.ts",
        oldText: "Math.floor(total / size)",
        newText: "Math.ceil(total / size)",
      });
      if (tool) stage = 1;
    } else if (stage === 1) {
      call("marina_code_verify", { verificationMode: "candidate" });
      if (tool) stage = 2;
    } else if (stage === 2 && /verification: passed/.test(transcript)) {
      // Hand in only once the checks on the change have passed.
      call("marina_code_summary", {
        text: "lastPage rounded down, so a partial last page was lost; it now rounds up. The acceptance test passes.",
      });
      if (tool) stage = 3;
    }
    const message = tool
      ? {
          role: "assistant",
          tool_calls: [{ id: `call_${stage}`, type: "function", function: tool }],
        }
      : { role: "assistant", content: "Done." };
    const usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 };
    const base = { id: crypto.randomUUID(), model: body.model, created: 1 };
    const finish = tool ? "tool_calls" : "stop";
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      });
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] }
      : message;
    return new Response(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  cleanup.use(scopeProperty(globalThis, "fetch", provider));

  const db = new MarinaDB(join(scratch, "world.db"));
  // The coder calls Marina's own /v1 (chat completions), forwarded to the scripted provider.
  db.setSetting("default_model", "marina/default");
  setEndpointConfig(db, {
    mode: "passthru",
    fallback: false,
    passthruModel: "openai/gpt-6-luna",
  });
  const engine = new Engine({
    db,
    startRoom: roomId("sdk/start"),
    tickInterval: 100,
    logger: new Logger({ level: "error" }),
  });
  engine.registerRoom(roomId("sdk/start"), { short: "Start", long: "Start", exits: {} });
  const server = new WebSocketServer(engine, 0);
  server.setDb(db);
  server.start();
  engine.agentRuntime.setWsPort(server.getPort());
  engine.start();
  const url = `ws://127.0.0.1:${server.getPort()}`;
  return {
    url,
    db,
    engine,
    workspace,
    async dispose() {
      await engine.agentRuntime.stopAll();
      server.stop();
      engine.stop();
      await engine.drainCommands();
      await engine.shutdown();
      closeWorldMemoryService(db);
      db.close();
      await cleanup.disposeAsync();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
