// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeConsole } from "../scripts/code-console";
import { HarnessStore, validateHarness } from "../scripts/code-harness";
import { NativeTerminal } from "../scripts/code-native";
import { terminalText } from "../scripts/code-terminal";
import { parseDispatch } from "../scripts/marina";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { RoutingService } from "../src/routing/service";
import type { MarinaAgent } from "../src/sdk/client";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { until } from "./helpers";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-terminal-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("selects a runtime, model, dialect and portable harness independently", () => {
  expect(
    parseDispatch([
      "--agent",
      "codex",
      ".",
      "--model",
      "custom",
      "--profile",
      "pi",
      "--harness",
      "team.json",
    ]),
  ).toEqual({
    kind: "code",
    dir: ".",
    agent: "codex",
    model: "custom",
    profile: "pi",
    harness: "team.json",
  });
  for (const flag of ["--agent", "--model", "--profile", "--harness"])
    expect(parseDispatch([flag, "--fresh"])).toEqual({ kind: "usage-error", arg: flag });
});

it("remembers an explicit personal harness and imports only the supported portable fields", () => {
  const store = new HarnessStore(directory);
  expect(store.load()).toBeUndefined();
  const harness = validateHarness({
    version: 1,
    agent: "marina",
    model: "openrouter/chosen-model",
    profile: "claude",
  });
  store.save("coding", harness);
  expect(new HarnessStore(directory).load()).toEqual(harness);
  expect(store.list()).toEqual(["coding"]);
  const path = join(directory, "shared.json");
  writeFileSync(path, JSON.stringify({ version: 1, agent: "pi" }));
  expect(store.load(path)).toEqual({ version: 1, agent: "pi" });
  expect(store.load()).toEqual(harness); // import is not automatic trust/persistence
  expect(readFileSync(store.path, "utf8")).not.toContain("token");
  expect(() => store.save("../escape", harness)).toThrow();
  expect(() => store.load("missing")).toThrow("not found");
  for (const invalid of [
    { version: 2, agent: "pi" },
    { version: 1, agent: "shell" },
    { ...harness, env: { TOKEN: "secret" } },
    { ...harness, model: "id\ncommand" },
  ])
    expect(() => validateHarness(invalid)).toThrow();
});

it("strips terminal escape instructions while preserving ordinary native output", () => {
  expect(terminalText("\x1b[31mhello\x1b[0m\x1b]52;c;c2VjcmV0\x07\nworld\r\b")).toBe(
    "hello\nworld",
  );
});

it("interrupts once when readline and SIGINT report the same physical keypress", async () => {
  const commands: string[] = [];
  let exits = 0;
  const terminal = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string) => {
        commands.push(text);
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {
      exits++;
    },
  });
  terminal.write = () => undefined;
  terminal.observe({
    kind: "message",
    timestamp: 0,
    data: { code: { event: "code_lifecycle", phase: "received" } },
  });
  await Promise.all([terminal.interrupt(), terminal.interrupt()]);
  expect(commands).toEqual(["code stop"]);
  expect(exits).toBe(0);
});

it("runs several native adapters through routing, journals output, resolves input and preserves fast completion", async () => {
  const db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: "owner", name: "Owner" });
  const router = new RoutingService(db, "owner");
  const controls: string[] = [];
  const client = new MarinaRoutingClient({
    url: "http://local.test",
    token: "secret",
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body));
      if (path.endsWith("/sessions")) return Response.json(router.join(body));
      if (path.endsWith("/sync")) return Response.json(router.sync(body));
      const id = path.split("/").at(-2)!;
      if (path.endsWith("/control")) {
        controls.push(body.control.action);
        return Response.json(router.control(id, body));
      }
      if (path.endsWith("/events"))
        return Response.json({ events: router.publish(id, body.events) });
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch,
  });
  const native = new Map<string, AgentOptions>();
  const models: (string | undefined)[] = [];
  const prompts: string[] = [];
  let stopped = 0;
  const adapters: AgentAdapter[] = ["claude", "codex", "pi"].map((id) => ({
    id,
    label: id,
    executable: "fixture",
    async start(options) {
      native.set(id, options);
      models.push(options.model);
      options.state({ status: "idle", nativeSessionId: `${id}-session` });
      return {
        async prompt(text) {
          prompts.push(text);
          options.emit("output", { text: "secret hello\n" });
          if (text.endsWith("failure"))
            options.emit("native.turn/completed", { turn: { status: "failed" } });
          options.state({ status: "idle" }); // can finish before prompt() resolves
        },
        async interrupt() {
          options.state({ status: "idle" });
        },
        stop() {
          stopped++;
        },
      };
    },
  }));
  const output: string[] = [];
  let answers = 0;
  let pendingQuestionSignal: AbortSignal | undefined;
  const runtime = new NativeTerminal({
    url: "http://local.test",
    token: "secret",
    root: directory,
    directory: join(directory, "runner"),
    client,
    adapters,
    write: (text) => output.push(text),
    ask: async (_text, signal) => {
      if (++answers === 1) return "no";
      pendingQuestionSignal = signal;
      return new Promise<string>((resolve) =>
        signal!.addEventListener("abort", () => resolve(""), { once: true }),
      );
    },
    intervalMs: 10,
  });
  try {
    await runtime.start();
    for (const id of ["claude", "codex", "pi"] as const) {
      const agent = await runtime.launch({ version: 1, agent: id, model: "chosen" }, id, "shared");
      const revision = await runtime.prompt(agent.session.id, "hello");
      await runtime.waitForTurn(agent.session.id, revision, 1000);
      expect(runtime.agents.get(agent.session.id)!.state.status).toBe("idle");
    }
    expect(models).toEqual(["chosen", "chosen", "chosen"]);
    expect(prompts).toHaveLength(3);
    expect(output.join("\n")).toContain("[redacted] hello");
    expect(output.join("\n")).not.toContain("secret");
    const codex = [...runtime.agents.values()].find((a) => a.session.kind === "codex")!;
    const denied = native
      .get("codex")!
      .ask({ kind: "permission", title: "Run?", input: { command: "fixture" } });
    expect(await denied).toEqual({ allow: false });
    const approvedElsewhere = native
      .get("codex")!
      .ask({ kind: "permission", title: "Browser approval", input: {} });
    await until(() => !!pendingQuestionSignal);
    await runtime.control(codex.session.id, {
      action: "respond",
      requestId: runtime.agents.get(codex.session.id)!.state.request!.id,
      allow: true,
    });
    expect(await approvedElsewhere).toEqual({ allow: true });
    expect(pendingQuestionSignal!.aborted).toBe(true);
    await runtime.control(codex.session.id, { action: "interrupt" });
    const revision = await runtime.prompt(codex.session.id, "failure");
    await expect(runtime.waitForTurn(codex.session.id, revision, 1000)).rejects.toThrow("failed");
    expect(controls).toContain("respond");
    await until(() => router.events(codex.session.id).events.some((e) => e.kind === "output"));
    expect(router.events(codex.session.id).events.some((e) => e.kind === "harness.selected")).toBe(
      true,
    );
    await expect(runtime.launch({ version: 1, agent: "codex" }, "codex", "shared")).rejects.toThrow(
      "already in use",
    );
  } finally {
    await runtime.stop();
    db.close();
  }
  expect(stopped).toBe(3);
});
