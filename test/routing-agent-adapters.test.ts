// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The native Codex (app-server JSON-RPC) and pi (RPC mode) adapters driven
 * against small fake executables that speak each wire protocol over stdio, the
 * Claude adapter's resume confirmation against an injected fake SDK `query`,
 * plus `prepareAgentWorkspace` in shared and worktree modes on a throwaway
 * git repository. No real agent binaries, no network.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentOptions,
  BUILTIN_AGENT_ADAPTERS,
  CLAUDE_RESUME_MISMATCH,
  type ClaudeSdk,
  createClaudeAdapter,
} from "../src/routing/agent-adapters";
import { prepareAgentWorkspace, restoreAgentWorkspace } from "../src/routing/agent-workspace";
import type { RuntimeState } from "../src/sdk/routing-runtime-types";
import { git as gitIn } from "./git-helpers";
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

/**
 * A fake Claude SDK `query`: like the real CLI (see the S6 spike), it emits nothing until the
 * first user message is consumed, then `system/init`. `toolBeforeInit` makes the fake request a
 * tool before `init`; after `init` it always requests one. A tool "runs" only when both the
 * PreToolUse hook and `canUseTool` allow it.
 */
function fakeClaudeSdk(opts: {
  recorded?: string;
  initSessionId: string;
  toolBeforeInit?: boolean;
}) {
  const calls = {
    queries: [] as Array<Record<string, unknown>>,
    consumed: [] as string[],
    toolDecisions: [] as string[],
    toolsRun: 0,
    interrupted: 0,
    closed: 0,
  };
  const sdk: ClaudeSdk = {
    getSessionInfo: (async (id: string) =>
      id === opts.recorded ? { sessionId: id, summary: "s", lastModified: 0 } : undefined) as never,
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      calls.queries.push(options as Record<string, unknown>);
      let closed = false;
      const tryTool = async () => {
        const signal = new AbortController().signal;
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        const hooked = hook ? await hook({} as never, "t1", { signal }) : {};
        const hookDecision = (hooked as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision;
        const decision =
          hookDecision === "deny"
            ? { behavior: "deny" }
            : await options.canUseTool!("Bash", { command: "ls" }, { signal } as never);
        calls.toolDecisions.push(decision?.behavior ?? "none");
        if (decision?.behavior === "allow") calls.toolsRun++;
      };
      async function* run() {
        for await (const message of prompt) {
          if (closed) return;
          calls.consumed.push(String(message.message.content));
          if (calls.consumed.length === 1) {
            if (opts.toolBeforeInit) await tryTool();
            yield { type: "system", subtype: "init", session_id: opts.initSessionId };
            if (closed) return;
          }
          await tryTool();
          yield { type: "result", subtype: "success", session_id: opts.initSessionId };
        }
      }
      const iterator = run();
      return Object.assign(iterator, {
        interrupt: async () => {
          calls.interrupted++;
        },
        close: () => {
          closed = true;
          calls.closed++;
        },
      });
    }) as never,
  };
  return { sdk, calls };
}

describe("claude adapter resume", () => {
  it("is registered as resumable", () => {
    expect(adapter("claude").supportsResume).toBe(true);
  });

  it("resumes the recorded session, holds tools until init confirms it, and replays nothing", async () => {
    const fake = fakeClaudeSdk({
      recorded: "recorded-session",
      initSessionId: "recorded-session",
      toolBeforeInit: true,
    });
    const h = harness("claude", [{ allow: true }]);
    h.options.resumeSessionId = "recorded-session";
    const agent = await createClaudeAdapter(fake.sdk)(h.options);
    try {
      expect(fake.calls.queries[0]).toMatchObject({ resume: "recorded-session", cwd: scratch });
      expect(fake.calls.consumed).toEqual([]);
      await agent.prompt("continue", "33333333-3333-3333-3333-333333333333");
      await until(() => fake.calls.toolDecisions.length === 2);
      expect(fake.calls.consumed).toEqual(["continue"]);
      expect(fake.calls.toolDecisions).toEqual(["deny", "allow"]);
      expect(fake.calls.toolsRun).toBe(1);
      expect(h.asked).toHaveLength(1);
      expect(h.states).toContainEqual({ nativeSessionId: "recorded-session" });
      expect(h.states.some((s) => s.status === "failed")).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("fails a mismatched session before any tool runs", async () => {
    const fake = fakeClaudeSdk({
      recorded: "recorded-session",
      initSessionId: "other-session",
      toolBeforeInit: true,
    });
    const h = harness("claude", [{ allow: true }]);
    h.options.resumeSessionId = "recorded-session";
    const agent = await createClaudeAdapter(fake.sdk)(h.options);
    await agent.prompt("continue", "44444444-4444-4444-4444-444444444444");
    await until(() => h.states.some((s) => s.status === "failed"));
    await until(() => fake.calls.closed > 0);
    expect(h.states.at(-1)).toEqual({ status: "failed", error: CLAUDE_RESUME_MISMATCH });
    expect(fake.calls.toolsRun).toBe(0);
    expect(fake.calls.toolDecisions).toEqual(["deny"]);
    expect(fake.calls.interrupted).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.states.some((s) => s.nativeSessionId === "other-session")).toBe(false);
    await expect(agent.prompt("again", "55555555-5555-5555-5555-555555555555")).rejects.toThrow(
      CLAUDE_RESUME_MISMATCH,
    );
    await agent.stop();
    expect(h.states.at(-1)).toEqual({ status: "failed", error: CLAUDE_RESUME_MISMATCH });
  });

  it("refuses an unknown session id before starting Claude", async () => {
    const fake = fakeClaudeSdk({ recorded: "recorded-session", initSessionId: "x" });
    const h = harness("claude", []);
    h.options.resumeSessionId = "unknown-session";
    await expect(createClaudeAdapter(fake.sdk)(h.options)).rejects.toThrow("no recorded session");
    expect(fake.calls.queries).toEqual([]);
    expect(h.states).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("a fresh session needs no recorded identity and installs no tool hold", async () => {
    const fake = fakeClaudeSdk({ initSessionId: "fresh" });
    const h = harness("claude", [{ allow: true }]);
    const agent = await createClaudeAdapter(fake.sdk)(h.options);
    try {
      expect(fake.calls.queries[0]?.resume).toBeUndefined();
      expect(fake.calls.queries[0]?.hooks).toBeUndefined();
      await agent.prompt("hi", "66666666-6666-6666-6666-666666666666");
      await until(() => fake.calls.toolsRun === 1);
      expect(h.states).toContainEqual({ nativeSessionId: "fresh" });
    } finally {
      await agent.stop();
    }
  });
});

describe("codex adapter", () => {
  it("resumes only the recorded inactive thread with the existing permission policy and no replay", async () => {
    const executable = fakeAgent(
      "fake-codex-resume",
      `function onLine(m) {
      if (m.method === "initialize") return out({ id: m.id, result: {} });
      if (m.method === "initialized") return;
      if (m.method === "thread/read") return out({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: process.env.FAKE_ACTIVE ? "active" : "notLoaded" } } } });
      if (m.method === "thread/resume") {
        out({ method: "echo", params: { msg: m } });
        return out({ id: m.id, result: { thread: { id: m.params.threadId } } });
      }
      return out({ id: m.id, error: { code: -32601, message: "Unexpected replay or new thread" } });
    }`,
    );
    const h = harness(executable, []);
    h.options.resumeSessionId = "recorded-thread";
    const agent = await adapter("codex").start(h.options);
    try {
      expect(h.states).toContainEqual({ nativeSessionId: "recorded-thread", status: "idle" });
      expect(echoes(h.events)).toEqual([
        expect.objectContaining({
          method: "thread/resume",
          params: expect.objectContaining({
            threadId: "recorded-thread",
            cwd: scratch,
            model: "test-model",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
          }),
        }),
      ]);
    } finally {
      await agent.stop();
    }
    h.options.env = { ...process.env, FAKE_ACTIVE: "1" };
    await expect(adapter("codex").start(h.options)).rejects.toThrow("already active");
  });
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
  it("selects the exact recorded session and rejects accidental replacement", async () => {
    const executable = fakeAgent(
      "fake-pi-resume",
      `function onLine(m) {
      if (m.type === "get_state") {
        const n = process.argv.indexOf("--session");
        return out({ id: m.id, type: "response", data: { sessionId: process.env.FAKE_REPLACE ? "new-session" : process.argv[n + 1] } });
      }
      return out({ id: m.id, type: "response", success: false, error: "Unexpected replay" });
    }`,
    );
    const h = harness(executable, []);
    h.options.resumeSessionId = "pi-recorded";
    const agent = await adapter("pi").start(h.options);
    expect(h.states).toContainEqual({ nativeSessionId: "pi-recorded", status: "idle" });
    await agent.stop();
    h.options.env = { ...process.env, FAKE_REPLACE: "1" };
    await expect(adapter("pi").start(h.options)).rejects.toThrow("did not resume");
  });
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
  it("resumes only an existing owned directory and rejects a path changed into a symlink", async () => {
    const root = realpathSync(mkdtempSync(join(scratch, "resume-root-")));
    const state = realpathSync(mkdtempSync(join(scratch, "resume-state-")));
    const worktree = join(state, "worktrees", "owned");
    mkdirSync(worktree, { recursive: true });
    expect(await restoreAgentWorkspace(root, state, root)).toBe(root);
    expect(await restoreAgentWorkspace(root, state, worktree)).toBe(worktree);
    await expect(restoreAgentWorkspace(root, state, scratch)).rejects.toThrow("outside");
    await expect(restoreAgentWorkspace(root, state, join(root, "missing"))).rejects.toThrow();
    if (process.platform !== "win32") {
      const redirected = join(root, "redirected");
      symlinkSync(worktree, redirected);
      await expect(restoreAgentWorkspace(root, state, redirected)).rejects.toThrow(
        "different directory",
      );
    }
  });
  it("shares the directory in shared mode and adds a detached worktree otherwise", async () => {
    const root = realpathSync(mkdtempSync(join(scratch, "repo-")));
    const git = (...args: string[]) => gitIn(root, ...args);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "i");
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
