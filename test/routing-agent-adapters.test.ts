// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The native Codex (app-server JSON-RPC) and pi (RPC mode) adapters driven
 * against small fake executables that speak each wire protocol over stdio,
 * plus `prepareAgentWorkspace` in shared and worktree modes on a throwaway
 * git repository. No real agent binaries, no network.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentOptions, BUILTIN_AGENT_ADAPTERS } from "../src/routing/agent-adapters";
import { prepareAgentWorkspace } from "../src/routing/agent-workspace";
import type { RuntimeState } from "../src/sdk/routing-runtime-types";
import { until } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "marina-adapters-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes an executable bun script that answers each stdin JSON line via `onLine`. */
function fakeAgent(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(
    path,
    `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stderr.write("${name} booted\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) onLine(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function harness(executable: string, answers: Array<{ allow: boolean; answer?: string }>) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const states: Array<Partial<RuntimeState>> = [];
  const asked: unknown[] = [];
  const options: AgentOptions = {
    cwd: scratch,
    executable,
    model: "test-model",
    emit: (kind, payload) => events.push({ kind, payload }),
    state: (patch) => states.push(patch),
    ask: async (request) => {
      asked.push(request);
      return answers.shift() ?? { allow: false };
    },
  };
  return { options, events, states, asked };
}

const adapter = (id: string) => BUILTIN_AGENT_ADAPTERS.find((a) => a.id === id)!;
const echoes = (events: Array<{ kind: string; payload: unknown }>) =>
  events.filter((e) => e.kind === "native.echo").map((e) => (e.payload as { msg: unknown }).msg);

describe("builtin adapter registry", () => {
  it("lists claude, codex and pi with their executables", () => {
    expect(BUILTIN_AGENT_ADAPTERS.map((a) => [a.id, a.executable])).toEqual([
      ["claude", "claude"],
      ["codex", "codex"],
      ["pi", "pi"],
    ]);
  });
});

describe("codex adapter", () => {
  const codexBin = fakeAgent(
    "fake-codex",
    `function onLine(m) {
  if (m.method === "initialize") return out({ id: m.id, result: {} });
  if (m.method === "initialized") return;
  if (m.method === "thread/start") {
    out({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    out({ id: "srv-2", method: "item/tool/requestUserInput", params: { questions: [] } });
    out({ id: "srv-3", method: "item/unknown/request", params: {} });
    return out({ id: m.id, result: { thread: { id: process.env.FAKE_THREAD ?? "thread-1" } } });
  }
  if (m.method === "turn/start") {
    out({ id: m.id, result: { turn: { id: "turn-1" } } });
    out({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    out({ method: "item/agentMessage/delta", params: { delta: "hel", itemId: "i1" } });
    out({ method: "item/reasoning/delta", params: { delta: "hidden" } });
    return;
  }
  if (m.method === "turn/interrupt") {
    out({ id: m.id, result: {} });
    return out({ method: "turn/completed", params: {} });
  }
  // Responses to our server requests come back here; echo them for the test.
  out({ method: "echo", params: { msg: m } });
}`,
  );

  it("initializes a thread, answers approvals, streams a turn and interrupts it", async () => {
    const h = harness(codexBin, [{ allow: true }, { allow: true, answer: '{"q1":"yes"}' }]);
    const agent = await adapter("codex").start(h.options);
    expect(h.states).toContainEqual({ nativeSessionId: "thread-1", status: "idle" });
    await until(() => echoes(h.events).length >= 3);
    const replies = echoes(h.events) as Array<Record<string, unknown>>;
    expect(replies.find((r) => r.id === "srv-1")?.result).toEqual({ decision: "accept" });
    expect(replies.find((r) => r.id === "srv-2")?.result).toEqual({ answers: { q1: "yes" } });
    expect(replies.find((r) => r.id === "srv-3")?.error).toMatchObject({ code: -32601 });
    expect(h.events.some((e) => e.kind === "approval.unsupported")).toBe(true);
    expect(h.asked).toHaveLength(2);

    await agent.prompt("hello", "11111111-1111-1111-1111-111111111111");
    await until(() => h.events.some((e) => e.kind === "output"));
    expect(h.events.find((e) => e.kind === "output")?.payload).toMatchObject({ text: "hel" });
    expect(h.events.some((e) => (e.payload as { delta?: string })?.delta === "hidden")).toBe(false);
    await until(() => h.states.some((s) => s.status === "running"));
    await expect(agent.prompt("again", "22222222-2222-2222-2222-222222222222")).rejects.toThrow(
      /busy/,
    );
    await agent.interrupt();
    await until(() => h.states.at(-1)?.status === "idle");
    await agent.interrupt(); // no turn → no request
    await agent.stop();
    await until(() => h.states.at(-1)?.status === "stopped");
    expect(h.events.some((e) => e.kind === "stderr")).toBe(true);
  });

  it("fails when no thread id comes back", async () => {
    const h = harness(codexBin, [{ allow: false }, { allow: false }]);
    h.options.env = { ...process.env, FAKE_THREAD: "" };
    await expect(adapter("codex").start(h.options)).rejects.toThrow(/thread id/);
  });

  it("an unexpected exit reports failure", async () => {
    const dies = fakeAgent(
      "fake-codex-dies",
      `function onLine(m) { if (m.method === "initialize") process.exit(3); }`,
    );
    const h = harness(dies, []);
    await expect(adapter("codex").start(h.options)).rejects.toThrow();
    await until(() => h.states.some((s) => s.status === "failed"));
  });
});

describe("pi adapter", () => {
  const piBin = fakeAgent(
    "fake-pi",
    `function onLine(m) {
  if (m.type === "get_state") return out({ id: m.id, type: "response", data: { sessionId: "pi-s1" } });
  if (m.type === "prompt") {
    out({ id: m.id, type: "response", success: true });
    out({ type: "agent_start" });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    out({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });
    out({ type: "extension_ui_request", id: "u2", method: "select", options: ["a", "b"] });
    out({ type: "extension_ui_request", id: "u3", method: "input" });
    out({ type: "extension_ui_request", id: "u4", method: "notify" });
    return out({ type: "agent_settled" });
  }
  if (m.type === "abort") return out({ id: m.id, type: "response", success: true });
  out({ type: "echo", msg: m });
}`,
  );

  it("reads the session, streams output and answers extension UI requests", async () => {
    const h = harness(piBin, [{ allow: true }, { allow: true, answer: "b" }, { allow: false }]);
    const agent = await adapter("pi").start(h.options);
    expect(h.states).toContainEqual({ nativeSessionId: "pi-s1", status: "idle" });
    await agent.prompt("go", "id-1");
    await until(() => h.events.filter((e) => e.kind === "native.echo").length >= 3);
    const replies = h.events
      .filter((e) => e.kind === "native.echo")
      .map((e) => (e.payload as { msg: Record<string, unknown> }).msg);
    expect(replies.find((r) => r.id === "u1")).toMatchObject({ confirmed: true });
    expect(replies.find((r) => r.id === "u2")).toMatchObject({ value: "b" });
    expect(replies.find((r) => r.id === "u3")).toMatchObject({ cancelled: true });
    expect(h.asked).toHaveLength(3);
    expect((h.asked[1] as { choices?: string[] }).choices).toEqual(["a", "b"]);
    expect(h.events.find((e) => e.kind === "output")?.payload).toEqual({ text: "hi" });
    expect(h.events.some((e) => e.kind === "native.extension_ui_request")).toBe(true);
    await until(() => h.states.at(-1)?.status === "idle");
    expect(h.states.some((s) => s.status === "running")).toBe(true);
    await agent.interrupt();
    await agent.stop();
    await until(() => h.states.at(-1)?.status === "stopped");
  });

  it("a failed get_state stops the process and rejects", async () => {
    const bad = fakeAgent(
      "fake-pi-bad",
      `function onLine(m) { out({ id: m.id, type: "response", success: false, error: "nope" }); }`,
    );
    const h = harness(bad, []);
    await expect(adapter("pi").start(h.options)).rejects.toThrow(/nope/);
  });
});

describe("prepareAgentWorkspace", () => {
  it("shares the directory in shared mode and adds a detached worktree otherwise", async () => {
    const root = realpathSync(mkdtempSync(join(scratch, "repo-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]).toString();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "f.txt"), "x");

    expect(await prepareAgentWorkspace(root, "sub", "shared", scratch, "unused")).toEqual({
      cwd: join(root, "sub"),
      dirty: false,
    });

    const state = join(scratch, "state");
    const result = await prepareAgentWorkspace(root, "sub", "worktree", state, "wt1");
    expect(result.dirty).toBe(true);
    expect(result.cwd).toBe(join(state, "worktrees", "wt1", "sub"));
    expect(git("worktree", "list")).toContain("wt1");

    // A configured root nested inside a repository must not expose its parent.
    await expect(
      prepareAgentWorkspace(join(root, "sub"), ".", "worktree", state, "wt2"),
    ).rejects.toThrow(/outside/);
  });
});
