// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CodeConsole } from "../scripts/code-console";
import { HarnessStore, validateHarness } from "../scripts/code-harness";
import { NativeTerminal } from "../scripts/code-native";
import { CodeTerminal, formatCodePerception, terminalText } from "../scripts/code-terminal";
import { perceptionView, TERMINAL_HISTORY_LIMITS, TerminalViews } from "../scripts/code-views";
import { workflowShortcut } from "../scripts/code-workflow";
import { parseDispatch } from "../scripts/marina";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { RoutingService } from "../src/routing/service";
import type { CommandOptions, CommandResult, MarinaAgent, Perception } from "../src/sdk/client";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

let directory: string;
let terminalEnvironment: DisposableStack;
beforeEach(() => {
  terminalEnvironment = scopeProcessState({ env: { TERM: "xterm-256color" } });
  directory = mkdtempSync(join(tmpdir(), "marina-terminal-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  terminalEnvironment.dispose();
});

function focusedTerminal(columns = 80) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns });
  let transcript = "";
  output.on("data", (data) => {
    transcript += data.toString();
  });
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    views: true,
    line: (line) => lines.push(line),
    interrupt: () => {},
    close: () => {},
  });
  return {
    terminal,
    input,
    output,
    lines,
    transcript: () => terminalText(transcript),
    [Symbol.dispose]() {
      terminal.close();
      input.destroy();
      output.destroy();
    },
  };
}

it("bounds local conversation history, marks gaps and pages through byte-limited entries without skips", () => {
  const views = new TerminalViews({
    ...TERMINAL_HISTORY_LIMITS,
    entries: 9,
    perView: 8,
    totalBytes: 2048,
    entryBytes: 128,
    pageBytes: 180,
    pageEntries: 4,
  });
  for (let n = 0; n < 12; n++)
    views.append("world", `entry-${n}: ${"界".repeat(100)}\x1b]52;c;bad\x07`);
  expect(views.stats().entries).toBe(8);
  expect(views.stats().bytes).toBeLessThanOrEqual(1024);
  expect(views.stats().evicted.world).toBe(4);
  expect(views.badge(1)).toBe("[C*:0 W:12 A:1]");
  views.select("world");
  expect(views.badge(1)).toBe("[C:0 W*:0 A:1]");
  expect(views.snapshot("world")).toContain("4 earlier entries evicted");
  expect(views.snapshot("world")).toContain("excerpt truncated");
  expect(views.snapshot("world")).not.toContain("\ufffd");
  expect(views.snapshot("world")).not.toContain("\x1b");
  for (let n = 10; n >= 4; n--) expect(views.page("older")).toContain(`entry-${n}:`);
  expect(views.page("older")).toContain("No earlier entries");
  views.select("coding");
  views.select("world");
  expect(views.snapshot("world")).toContain("entry-4:");
  for (let n = 5; n <= 11; n++) expect(views.page("newer")).toContain(`entry-${n}:`);
  views.select("coding");
  views.append("all", "Shared connection failure");
  expect(views.snapshot("coding")).toContain("Shared connection failure");
  expect(views.snapshot("world")).toContain("Shared connection failure");
  expect(views.stats().unread.world).toBe(0);
  expect(perceptionView({ kind: "message", timestamp: 0, tag: "tell", data: {} })).toBe("world");
  expect(
    perceptionView({ kind: "message", timestamp: 0, data: { code: { event: "agent_output" } } }),
  ).toBe("coding");
  expect(perceptionView({ kind: "message", timestamp: 0, data: { text: "[world] pretend" } })).toBe(
    "all",
  );
});

it("switches focused conversations with separate Unicode drafts, multiline input and command histories", async () => {
  using fixture = focusedTerminal(24);
  const { input, output, terminal, lines } = fixture;
  input.write("first coding line\\\nrepair 界 suffix\x1b[D".repeat(1));
  input.write("\x1b[D".repeat(5));
  input.write("\x1b[17~"); // F6, coding -> world
  input.write("tell Peer hello\n");
  input.write("world-draft");
  terminal.write("worker private output", "coding");
  expect(fixture.transcript()).not.toContain("worker private output");
  expect(fixture.transcript()).toContain("New activity is waiting");
  output.columns = 36;
  output.emit("resize");
  input.write("\x1b[17~"); // world -> coding, preserve cursor before suffix
  expect(fixture.transcript()).toContain("worker private output");
  input.write("new-\x1b[F\n");
  input.write("\x1b[17~");
  input.write(" continued\n");
  input.write("\x1b[A\n");
  input.write("/view coding\n");
  input.write("\x1b[A\n");
  await until(() => lines.length === 5);
  expect(lines).toEqual([
    "/world tell Peer hello",
    "first coding line\nrepair 界 new-suffix",
    "/world world-draft continued",
    "/world world-draft continued",
    "repair 界 new-suffix",
  ]);
});

it("keeps pending requests out of conversation composers and binds cancelled answers to their original request", async () => {
  using fixture = focusedTerminal();
  const { input, terminal, lines } = fixture;
  const abort = new AbortController();
  let answered = 0;
  const first = terminal.ask("Session A: approve tool A? [y/N]", abort.signal).then((answer) => {
    answered++;
    return answer;
  });
  const second = terminal.ask("Session B: approve tool B? [y/N]");
  input.write("coding draft");
  input.write("\x1b[17~yes\n");
  expect(lines).toEqual(["/world yes"]);
  expect(answered).toBe(0);
  input.write("world draft");
  input.write("\x1b[18~"); // F7 opens original pending request
  expect(fixture.transcript()).toContain("Session A: approve tool A?");
  input.write("yes");
  input.write("\x1b[17~"); // leave answer as a draft, do not submit
  input.write(" continued\n");
  expect(lines.at(-1)).toBe("/world world draft continued");
  abort.abort();
  expect(await first).toBe("");
  input.write("/view approvals\n");
  expect(fixture.transcript()).toContain("Session B: approve tool B?");
  input.write("no\n");
  expect(await second).toBe("no"); // A's partial yes was discarded
  input.write("/view coding\n continued\n");
  expect(lines.at(-1)).toBe("coding draft continued");
  const shutdown = terminal.ask("Session C: still pending?");
  terminal.close();
  expect(await shutdown).toBe("");
});

it("keeps plain output continuous even when focused views are requested", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (data) => {
    text += data.toString();
  });
  const terminal = new CodeTerminal({
    input,
    output,
    views: true,
    line: () => {},
    interrupt: () => {},
    close: () => {},
  });
  try {
    terminal.write("world event", "world");
    terminal.write("coding event", "coding");
    expect(await terminal.ask("invisible approval")).toBe("");
    expect(text).toBe("world event\ncoding event\n");
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it("projects worker pauses ahead of readiness without letting older or settled attempts resume", async () => {
  const output: string[] = [];
  const view = new CodeConsole({
    agent: { getSession: () => null, command: async () => [] } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    sessionId: "selected",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = (text) => {
    output.push(text);
  };
  const event = (
    metadata: Record<string, unknown>,
    event = "worker_state_changed",
    sessionId = "selected",
  ): Perception => ({
    kind: "message",
    timestamp: 0,
    data: { code: { event, sessionId, metadata: { runId: "run", ...metadata } } },
  });
  const status = async () => {
    await view.submit("/agents");
    return output.at(-1)!;
  };
  try {
    view.observe(
      event(
        {
          runStatus: "active",
          verificationReadiness: "ready",
          workerState: "working",
          workerObservedAt: 1,
        },
        "session_status",
      ),
    );
    expect(await status()).toContain("ready for review");
    view.observe(
      event({
        workerState: "paused",
        workerPauseKind: "budget",
        workerReason: "Daily allowance used",
        workerObservedAt: 2,
      }),
    );
    expect(await status()).toContain("paused · model budget · Daily allowance used");
    expect(view.busy()).toBe(true); // the attempt is still active while the worker pauses
    view.observe(event({ workerState: "working", workerObservedAt: 1 }));
    expect(await status()).toContain("paused · model budget");
    view.observe(
      event({ workerState: "working", workerObservedAt: 3 }, "worker_state_changed", "other"),
    );
    expect(await status()).toContain("paused · model budget");
    view.observe(
      event({
        workerState: "waiting",
        workerReason: "Resting until next turn",
        workerObservedAt: 3,
      }),
    );
    expect(await status()).toContain("worker waiting · Resting until next turn");
    view.observe(event({ workerState: "working", workerObservedAt: 4 }));
    expect(await status()).toContain("ready for review");
    for (const settled of ["submitted", "approved", "rejected", "cancelled"]) {
      view.observe(
        event(
          {
            runStatus: settled,
            verificationReadiness: "ready",
            workerState: "working",
            workerObservedAt: 5,
          },
          "session_status",
        ),
      );
      view.observe(
        event({ workerState: "paused", workerPauseKind: "spend-cap", workerObservedAt: 6 }),
      );
      view.observe(event({ workerState: "working", workerObservedAt: 7 }, "unknown_future_event"));
      view.observe(
        event(
          { runStatus: "active", workerState: "working", workerObservedAt: 8 },
          "session_status",
        ),
      );
      expect(await status()).toContain(settled === "submitted" ? "submitted for review" : settled);
      expect(await status()).not.toContain("ready for review");
      expect(view.busy()).toBe(false);
    }
    view.observe(
      event(
        { runId: "next", runStatus: "active", workerState: "working", workerObservedAt: 9 },
        "session_status",
      ),
    );
    view.observe(event({ workerState: "paused", workerObservedAt: 10 }));
    expect(await status()).toContain("marina · working");
    expect(view.busy()).toBe(true);
    expect(
      formatCodePerception({
        ...event({
          workerState: "paused",
          workerPauseKind: "upstream-errors",
          workerReason: "retry later",
        }),
        data: {
          text: "Worker change",
          code: {
            event: "worker_state_changed",
            metadata: {
              workerState: "paused",
              workerPauseKind: "upstream-errors",
              workerReason: "retry later",
            },
          },
        },
      }),
    ).toContain("paused · upstream errors · retry later");
    expect(
      formatCodePerception({
        kind: "message",
        timestamp: 0,
        data: { text: "Future change", code: { event: "worker_state_changed" } },
      }),
    ).toContain("status unknown");
  } finally {
    await view.close(0);
  }
});

it("receives typed worker output in Coding, world messages in World, and redacts before retaining history", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let transcript = "";
  output.on("data", (data) => {
    transcript += data.toString();
  });
  const requests: string[] = [];
  const view = new CodeConsole({
    agent: {
      getSession: () => ({ token: "secret/token" }),
      command: async (text: string) => {
        requests.push(text);
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    sessionId: "selected",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
    terminalStreams: { input, output },
  });
  const p = (data: Record<string, unknown>, tag?: string): Perception => ({
    kind: "message",
    timestamp: 0,
    data,
    tag,
  });
  try {
    await view.start(true);
    await view.submit("/view world");
    view.receive(
      p({
        text: "hidden worker secret/token \x1b]52;c;bad\x07",
        code: {
          event: "agent_output",
          type: "stream",
          sessionId: "selected",
          metadata: { agent: "worker" },
        },
      }),
    );
    expect(terminalText(transcript)).not.toContain("hidden worker");
    view.receive(p({ text: "Peer continuing their task" }, "tell"));
    expect(terminalText(transcript)).toContain("Peer continuing their task");
    view.receive({
      kind: "error",
      timestamp: 0,
      data: { text: "Urgent coding failure", code: { event: "failed", sessionId: "selected" } },
    });
    expect(terminalText(transcript)).toContain("Urgent coding failure");
    input.write("tell Peer responding\n");
    await until(() => requests.includes("/tell Peer responding"));
    await view.submit("/view coding");
    expect(terminalText(transcript)).toContain("hidden worker [redacted]");
    expect(transcript).not.toContain("secret/token");
    expect(transcript).not.toContain("\x1b]52");
    expect(requests).toEqual(["code doctor", "/tell Peer responding"]); // inspection at startup; focus is local
    expect(view.busy()).toBe(false); // agent prose does not manufacture task lifecycle
  } finally {
    await view.close(0);
    input.destroy();
    output.destroy();
  }
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

it("keeps headless task output continuous on a TTY and retains visible legacy approval prompts", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let transcript = "";
  output.on("data", (data) => {
    transcript += data.toString();
  });
  const view = new CodeConsole({
    agent: { getSession: () => null, command: async () => [] } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    sessionId: "selected",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
    terminalStreams: { input, output },
  });
  try {
    await view.start(false);
    view.receive({
      kind: "message",
      timestamp: 0,
      tag: "tell",
      data: { text: "World remains visible" },
    });
    view.receive({
      kind: "message",
      timestamp: 0,
      data: {
        text: "Worker remains visible",
        code: { event: "agent_output", sessionId: "selected" },
      },
    });
    expect(terminalText(transcript)).toContain("World remains visible");
    expect(terminalText(transcript)).toContain("Worker remains visible");
    const answer = view.ask("Visible headless approval? [y/N]");
    expect(terminalText(transcript)).toContain("Visible headless approval?");
    expect(terminalText(transcript)).not.toContain("Input request waiting");
    input.write("no\n");
    expect(await answer).toBe("no");
  } finally {
    await view.close(0);
    input.destroy();
    output.destroy();
  }
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

it("keeps receipts, submitted tasks and world messages distinct without overstating evidence", () => {
  const p = (code: Record<string, unknown>, text: string) => ({
    kind: "message" as const,
    timestamp: 0,
    data: { code, text },
  });
  expect(formatCodePerception(p({ event: "verification_started" }, "Receipt accepted"))).toBe(
    "[checks · running] Receipt accepted",
  );
  expect(
    formatCodePerception(
      p({ event: "verification_finished", status: "complete" }, "Inspect artifact: receipt"),
    ),
  ).toBe("[checks · receipt] Inspect artifact: receipt");
  const evidence = "Candidate evidence: stale. Recipe: whitespace-only. Checks passed.";
  expect(formatCodePerception(p({ event: "verification_ran", status: "complete" }, evidence))).toBe(
    `[checks · result] ${evidence}`,
  );
  expect(
    formatCodePerception(
      p(
        { event: "code_lifecycle", phase: "completed", status: "submitted" },
        "Awaiting owner review",
      ),
    ),
  ).toBe("[task · submitted for review] Awaiting owner review");
  expect(
    formatCodePerception({
      kind: "message",
      timestamp: 0,
      tag: "tell",
      data: { text: "Peer: still working" },
    }),
  ).toBe("[world] [tell] Peer: still working");
  expect(terminalText("safe\u202egnp.exe\u2066\x1b]52;c;c2VjcmV0\x07")).toBe("safegnp.exe");
});

it("routes terminal inspection and verification shortcuts through the selected Marina session", async () => {
  const requests: { text: string; options: unknown }[] = [];
  const output: string[] = [];
  const view = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string, options: unknown) => {
        requests.push({ text, options });
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    sessionId: "selected-session",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = (text) => {
    output.push(text);
  };
  try {
    for (const text of [
      "/status",
      "/diff",
      "/verify",
      "/verify live",
      "/review",
      "/project",
      "/checks",
      "/history",
      "/show artifact-123",
      "/review run-123",
      "/review approve run-123",
      "/review reject run-123",
      "/verify candidate dependencies:bun",
    ])
      await view.submit(text);
    expect(requests.map((request) => request.text)).toEqual([
      "code status",
      "code diff",
      "code verify candidate",
      "code verify start",
      "code review",
      "code doctor",
      "code artifacts kind verification",
      "code artifacts kind task_run",
      "code show artifact-123",
      "code review run-123",
      "code review approve run-123",
      "code review reject run-123",
      "code verify candidate dependencies:bun",
    ]);
    expect(
      requests.every(
        (request) =>
          JSON.stringify(request.options) ===
          JSON.stringify({ codingTarget: { sessionId: "selected-session" } }),
      ),
    ).toBe(true);
    await view.submit("/verify arbitrary shell command");
    await view.submit("/review approve");
    for (const invalid of [
      "/review approve last",
      "/review reject",
      "/review approve run-123 extra",
      "/review accept-unverified run-123 reason",
      "/review approve run-123\n/world quit",
      "/show ../escape",
      "/show a\u0000b",
      "/project unexpected",
      "/verify live dependencies:bun",
    ])
      await view.submit(invalid);
    expect(requests).toHaveLength(13);
    await view.submit("/world\tlook");
    expect(requests.at(-1)).toEqual({ text: "/look", options: undefined });
    await view.submit("/help");
    expect(output.join("\n")).toContain("Detach; world agents and tasks keep running");
    view.observe({
      kind: "message",
      timestamp: 0,
      data: {
        code: { event: "code_lifecycle", phase: "received", sessionId: "selected-session" },
      },
    });
    expect(view.busy()).toBe(true);
    view.completed("someone-elses-session");
    expect(view.busy()).toBe(true);
    view.completed("selected-session");
    expect(view.busy()).toBe(false);
  } finally {
    await view.close(0);
  }
});

it("dispatches /task with candidate verification while preserving freeform requests and refusing native routing", async () => {
  const requests: { text: string; options?: CommandOptions }[] = [];
  const output: string[] = [];
  const create = (agent: "marina" | "codex") => {
    const view = new CodeConsole({
      agent: {
        getSession: () => null,
        command: async (text: string, options?: CommandOptions) => {
          requests.push({ text, options });
          return [];
        },
      } as unknown as MarinaAgent,
      url: "http://fixture",
      root: directory,
      directory,
      sessionId: "project",
      connected: true,
      harness: { version: 1, agent },
      store: new HarnessStore(directory),
      finish: () => {},
    });
    view.write = (text) => {
      output.push(text);
    };
    return view;
  };
  const marina = create("marina");
  const native = create("codex");
  try {
    await marina.submit("/task Fix this parser\nTreat verification:none as literal text");
    expect(requests).toEqual([
      {
        text: "code do verification:candidate -- Fix this parser\nTreat verification:none as literal text",
        options: { codingTarget: { sessionId: "project" } },
      },
    ]);
    expect(marina.busy()).toBe(false); // No claim of admission without server feedback.
    await marina.submit("Keep discussing the approach");
    expect(requests.at(-1)?.text).toBe("Keep discussing the approach");
    await marina.submit("/task");
    await native.submit("/task Fix another file");
    expect(requests).toHaveLength(2);
    expect(output.join("\n")).toContain("Usage: /task <request>");
    expect(output.join("\n")).toContain("native agents keep their own tools");
  } finally {
    await marina.close(0);
    await native.close(0);
  }
});

it("uses run-scoped readiness feedback without turning receipts or stale attempts into verified work", async () => {
  const output: string[] = [];
  const view = new CodeConsole({
    agent: { getSession: () => null, command: async () => [] } as unknown as MarinaAgent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "project",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = (text) => {
    output.push(text);
  };
  const feedback = (
    event: string,
    runId: string,
    metadata: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ): Perception => ({
    kind: "message",
    timestamp: 0,
    data: {
      text: "Source evidence remains available",
      code: {
        event,
        sessionId: "project",
        metadata: { runId, ...metadata },
        ...extra,
      },
    },
  });
  const activity = async () => {
    await view.submit("/agents");
    return output.at(-1)!;
  };
  try {
    view.observe(
      feedback("session_status", "first", {
        runStatus: "active",
        verificationRequirement: "candidate",
        verificationReadiness: "required",
        verification: "missing",
      }),
    );
    expect(await activity()).toContain("verification required");
    expect(view.busy()).toBe(true);
    view.observe(feedback("verification_started", "first", { verificationReadiness: "running" }));
    expect(await activity()).toContain("checks running");
    view.observe(feedback("verification_finished", "first", {}, { status: "complete" }));
    expect(await activity()).toContain("working");
    expect(await activity()).not.toContain("ready for review");
    for (const verification of ["failed", "missing", "stale", "unbound", "unavailable"]) {
      view.observe(
        feedback("verification_ran", "first", {
          verification,
          verificationReadiness: "needs-attention",
        }),
      );
      expect(await activity()).toContain("checks need attention");
    }
    view.observe(
      feedback("verification_ran", "first", {
        verification: "passed",
        verificationReadiness: "ready",
      }),
    );
    expect(await activity()).toContain("ready for review");
    view.observe(feedback("verification_required", "first", { verificationReadiness: "required" }));
    expect(await activity()).toContain("verification required");
    expect(view.busy()).toBe(true); // A held summary is not terminal submission.
    view.observe(
      feedback(
        "code_lifecycle",
        "second",
        { verificationReadiness: "required" },
        { phase: "received" },
      ),
    );
    view.completed("project"); // Legacy callback cannot settle an unidentified attempt.
    view.observe(
      feedback("verification_ran", "first", {
        verification: "passed",
        verificationReadiness: "ready",
      }),
    );
    view.observe(feedback("code_lifecycle", "first", { terminal: true }, { phase: "completed" }));
    view.observe(feedback("code_lifecycle", "first", {}, { phase: "received" }));
    view.observe(
      feedback("session_status", "first", {
        runStatus: "submitted",
        verificationReadiness: "ready",
      }),
    );
    view.observe(
      feedback(
        "verification_ran",
        "second",
        { verificationReadiness: "ready" },
        { sessionId: "foreign" },
      ),
    );
    expect(await activity()).toContain("verification required");
    expect(view.busy()).toBe(true);
    view.observe(
      feedback(
        "code_lifecycle",
        "second",
        { terminal: true, reason: "blocked", outcome: "interrupted" },
        { phase: "failed" },
      ),
    );
    expect(await activity()).toContain("blocked");
    expect(view.busy()).toBe(false);
    view.observe(
      feedback("verification_ran", "second", {
        verificationReadiness: "ready",
        verification: "passed",
      }),
    );
    expect(await activity()).toContain("blocked");
    view.observe(
      feedback("session_status", "second", {
        runStatus: "interrupted",
        reason: "blocked",
        verificationReadiness: "needs-attention",
      }),
    );
    expect(await activity()).toContain("blocked");
    view.observe(
      feedback(
        "code_lifecycle",
        "third",
        { verificationReadiness: "required" },
        { phase: "received" },
      ),
    );
    view.observe(
      feedback(
        "code_lifecycle",
        "third",
        { terminal: true, verification: "passed" },
        { phase: "completed", status: "submitted" },
      ),
    );
    expect(await activity()).toContain("submitted for review");
    expect(await activity()).not.toContain("approved");
    expect(view.busy()).toBe(false);
  } finally {
    await view.close(0);
  }
});

it("renders declared readiness plainly and keeps completed receipts separate from submission", () => {
  const feedback = (event: string, readiness?: string): Perception => ({
    kind: "message",
    timestamp: 0,
    data: {
      text: "Checks passed in a previous workspace",
      code: { event, status: "complete", metadata: { verificationReadiness: readiness } },
    },
  });
  expect(formatCodePerception(feedback("verification_required", "required"))).toStartWith(
    "[verification required]",
  );
  expect(formatCodePerception(feedback("verification_started", "running"))).toStartWith(
    "[checks running]",
  );
  expect(formatCodePerception(feedback("verification_ran", "ready"))).toStartWith(
    "[checks · result · ready for review]",
  );
  expect(formatCodePerception(feedback("verification_ran", "needs-attention"))).toStartWith(
    "[checks · result · checks need attention]",
  );
  expect(formatCodePerception(feedback("verification_finished"))).toStartWith("[checks · receipt]");
  expect(formatCodePerception(feedback("verification_finished", "__proto__"))).not.toContain(
    "ready for review",
  );
});

it("adopts sessions only from confirmed local results and keeps historical review out of live status", async () => {
  const requests: { text: string; options?: CommandOptions }[] = [];
  const output: string[] = [];
  const event = (sessionId: string, name: string, correlated = true): Perception => ({
    kind: "message",
    timestamp: 0,
    ...(correlated ? { command_request_id: `request-${sessionId}` } : {}),
    data: { code: { event: name, sessionId, workspace: `/tmp/${sessionId}` } },
  });
  const result = (perceptions: Perception[], completion = "confirmed") =>
    Object.assign(perceptions, { completion }) as CommandResult;
  let view: CodeConsole;
  const agent = {
    getSession: () => null,
    command: async (text: string, options?: CommandOptions) => {
      requests.push({ text, options });
      if (text === "code status") {
        view.observe({
          kind: "message",
          timestamp: 0,
          data: {
            code: {
              event: "session_status",
              sessionId: options?.codingTarget?.sessionId,
              metadata: { runStatus: "submitted" },
            },
          },
        });
        return result([]);
      }
      const selection: Record<string, [string, string]> = {
        "/code start created": ["created", "session_started"],
        "/code branch branched": ["branched", "session_branched"],
        "/code resume resumed": ["resumed", "session_resumed"],
        "/code": ["entered", "code_mode_entered"],
      };
      if (text === "/code resume unconfirmed")
        return result([event("unconfirmed", "session_resumed")], "unconfirmed");
      if (text === "/code resume uncorrelated")
        return result([event("uncorrelated", "session_resumed", false)]);
      const selected = selection[text];
      if (selected) {
        // Completion can precede the command result for a very fast worker.
        view.completed(selected[0]);
        return result([
          event(...selected),
          {
            kind: "message",
            timestamp: 0,
            command_request_id: `request-${selected[0]}`,
            data: {
              code: {
                event: "code_lifecycle",
                phase: "received",
                sessionId: selected[0],
              },
            },
          },
        ]);
      }
      return result([]);
    },
  } as unknown as MarinaAgent;
  view = new CodeConsole({
    agent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "current",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = (text) => {
    output.push(text);
  };
  try {
    for (const name of [
      "session_started",
      "session_resumed",
      "session_branched",
      "code_mode_entered",
    ]) {
      view.observe(event("unsolicited", name, false));
      view.observe(event("forged-correlation", name));
    }
    for (const line of ["/world code resume unconfirmed", "/world code resume uncorrelated"])
      await view.submit(line);
    await view.submit("/diff");
    expect(requests.at(-1)?.options?.codingTarget?.sessionId).toBe("current");
    for (const [line, selected] of [
      ["/world code start created", "created"],
      ["/world code branch branched", "branched"],
      ["/world code resume resumed", "resumed"],
      ["/world code", "entered"],
    ]) {
      await view.submit(line!);
      await view.submit("/diff");
      expect(requests.at(-1)?.options?.codingTarget?.sessionId).toBe(selected!);
      expect(view.busy()).toBe(false); // fresh submitted status beats stale received
    }
    view.observe({
      kind: "message",
      timestamp: 0,
      data: {
        code: {
          event: "code_lifecycle",
          phase: "received",
          sessionId: "entered",
          metadata: { runId: "new" },
        },
      },
    });
    for (const status of ["approved", "rejected", "cancelled"])
      view.observe({
        kind: "message",
        timestamp: 0,
        data: {
          code: {
            event: "task_run_review",
            status,
            sessionId: "entered",
            metadata: { runId: "old" },
          },
        },
      });
    await view.submit("/agents");
    expect(output.at(-1)).toContain("marina · working");
    expect(view.busy()).toBe(true);
    view.completed("resumed");
    expect(view.busy()).toBe(true);
    await view.submit("/diff");
    expect(requests.at(-1)?.options?.codingTarget?.sessionId).toBe("entered");
  } finally {
    await view.close(0);
  }
});

it("does not let an older command confirmation replace a newer deliberate selection", async () => {
  const older = Promise.withResolvers<CommandResult>();
  const issued = Promise.withResolvers<void>();
  const requestedTargets: (string | undefined)[] = [];
  const selected = (sessionId: string): CommandResult =>
    Object.assign(
      [
        {
          kind: "message" as const,
          timestamp: 0,
          command_request_id: sessionId,
          data: { code: { event: "session_resumed", sessionId } },
        },
      ],
      { completion: "confirmed" as const },
    );
  const view = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string, options?: CommandOptions) => {
        if (text === "/code resume older") {
          issued.resolve();
          return older.promise;
        }
        if (text === "/code resume newer") return selected("newer");
        requestedTargets.push(options?.codingTarget?.sessionId);
        return Object.assign([], { completion: "confirmed" });
      },
    } as unknown as MarinaAgent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "current",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = () => {};
  const first = view.submit("/world code resume older");
  try {
    await issued.promise;
    await view.submit("/world code resume newer");
    older.resolve(selected("older"));
    await first;
    await view.submit("/diff");
    expect(requestedTargets.at(-1)).toBe("newer");
  } finally {
    older.resolve(selected("older"));
    await first;
    await view.close(0);
  }
});

it("preserves a wrapped draft and its editing cursor through output, resize and queued approvals", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 24 });
  let transcript = "";
  output.on("data", (data) => {
    transcript += data.toString();
  });
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    line: (line) => lines.push(line),
    interrupt: () => {},
    close: () => {},
  });
  try {
    terminal.setTarget("marina:really-long-session-identifier");
    terminal.setStatus("verifying");
    const draft = "repair this long source description with 界 and suffix";
    input.write(draft);
    // Put the cursor before suffix. Output must preserve both halves of the line.
    input.write("\x1b[D".repeat(6));
    terminal.write("[world] A peer sent an update");
    const first = terminal.ask("Run a long command in /some/long/repository/directory? [y/N]");
    const second = terminal.ask("Second command? [y/N]");
    input.write("/world tell Peer received\n");
    output.columns = 36;
    output.emit("resize");
    terminal.write("[checks · receipt] A different session finished");
    input.write("no\n");
    expect(await first).toBe("no");
    input.write("no\n");
    expect(await second).toBe("no");
    input.write("new-\x1b[F\n");
    await until(() => lines.length === 2);
    expect(lines).toEqual(["/world tell Peer received", draft.replace("suffix", "new-suffix")]);
    expect(terminalText(transcript)).toContain(
      "Run a long command in /some/long/repository/directory? [y/N]",
    );
    expect(terminalText(transcript)).toContain("Second command? [y/N]");
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it("does not replace the user's yank buffer when an ambient event redraws the input", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 24 });
  output.resume();
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    line: (line) => lines.push(line),
    interrupt: () => {},
    close: () => {},
  });
  try {
    input.write("yank-me\x15other");
    terminal.write("[world] Peer said hello");
    input.write("\x19\n");
    await until(() => lines.length === 1);
    expect(lines).toEqual(["otheryank-me"]);
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it("preserves a multiline task around world input and emits no editing controls to redirected output", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (data) => {
    transcript += data.toString();
  });
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    line: (line) => lines.push(line),
    interrupt: () => {},
    close: () => {},
  });
  try {
    terminal.setTarget("session");
    terminal.setStatus("working");
    input.write("First line\\\n/world say still here\nSecond line\n");
    terminal.write("Check started");
    expect(await terminal.ask("Unseen approval?")).toBe("");
    await until(() => lines.length === 2);
    expect(lines).toEqual(["/world say still here", "First line\nSecond line"]);
    expect(transcript).toBe("Check started\n");
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
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

it("delivers world input and local help during setup while coding input keeps its order", async () => {
  const commands: string[] = [];
  const output: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const terminal = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string) => {
        commands.push(text);
        if (text === "code profile use marina") {
          entered.resolve();
          await release.promise;
        }
        if (text === "/say unavailable") throw new Error("World connection unavailable");
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://local.test",
    root: directory,
    directory,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  terminal.write = (text) => {
    output.push(text);
  };
  const setup = terminal.submit("/use marina");
  const task = terminal.submit("continue coding");
  try {
    await entered.promise;
    await terminal.submit("  /world tell Other still participating  ");
    await terminal.submit("/world channel send work updates continue");
    await terminal.submit("/help");
    expect(commands).toEqual([
      "code profile use marina",
      "/tell Other still participating",
      "/channel send work updates continue",
    ]);
    expect(output.some((text) => text.includes("/world"))).toBe(true);
    await terminal.submit("/world say unavailable");
    expect(output).toContain("World connection unavailable");
    release.resolve();
    await Promise.all([setup, task]);
    expect(commands.at(-1)).toBe("continue coding");
  } finally {
    release.resolve();
    await Promise.all([setup, task]);
    await terminal.close(0);
  }
});

it("keeps approval questions, drafts and world input separate through the real readline handler", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  output.resume();
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    line: (text) => lines.push(text),
    interrupt: () => {},
    close: () => {},
  });
  let answers = 0;
  try {
    input.write("unfinished draft");
    const first = terminal.ask("Session A: allow? ").then((answer) => {
      answers++;
      return answer;
    });
    const second = terminal.ask("Session B: allow? ").then((answer) => {
      answers++;
      return answer;
    });
    input.write("/world tell Other hello\n");
    await until(() => lines.length === 1);
    expect(answers).toBe(0);
    terminal.write("World event while approval is pending");
    input.write("yes\n");
    expect(await first).toBe("yes");
    input.write("/world look\n");
    await until(() => lines.length === 2);
    expect(answers).toBe(1);
    input.write("no\n");
    expect(await second).toBe("no");
    input.write(" continued\n");
    await until(() => lines.length === 3);
    expect(lines).toEqual(["/world tell Other hello", "/world look", "unfinished draft continued"]);
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it("world input cannot settle a cancelled approval or turn shutdown into consent", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  output.resume();
  const lines: string[] = [];
  const terminal = new CodeTerminal({
    input,
    output,
    line: (text) => lines.push(text),
    interrupt: () => {},
    close: () => {},
  });
  const controller = new AbortController();
  try {
    const first = terminal.ask("A? ", controller.signal);
    const second = terminal.ask("B? ");
    input.write("/world say busy\n");
    controller.abort();
    expect(await first).toBe("");
    terminal.close();
    expect(await second).toBe("");
    expect(lines).toEqual(["/world say busy"]);
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it("does not request approval when the prompt output is redirected", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  output.resume();
  const terminal = new CodeTerminal({
    input,
    output,
    line: () => {},
    interrupt: () => {},
    close: () => {},
  });
  try {
    expect(await terminal.ask("Invisible approval? ")).toBe("");
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
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

it("keeps project inspection ordered with coding input while world messages bypass the local wait", async () => {
  const inspected = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const requests: string[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const view = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string) => {
        requests.push(text);
        if (text === "code doctor") {
          started.resolve();
          await inspected.promise;
        }
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "selected",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
    terminalStreams: { input, output },
  });
  const startup = view.start(true);
  try {
    await started.promise;
    const task = view.submit("/task Fix the boundary");
    await view.submit("/world tell Peer still available");
    expect(requests).toEqual(["code doctor", "/tell Peer still available"]);
    inspected.resolve();
    await startup;
    await task;
    expect(requests.at(-1)).toBe("code do verification:candidate -- Fix the boundary");
  } finally {
    inspected.resolve();
    await startup;
    await view.close(0);
    input.destroy();
    output.destroy();
  }
});

it("renders review actions only for their selected session and never transforms hostile text into a shortcut", () => {
  const perception: Perception = {
    kind: "message",
    timestamp: 0,
    data: {
      text: "Task submitted; candidate evidence is stale.",
      code: {
        type: "artifact",
        event: "task_run_review",
        sessionId: "selected",
        commands: ["code show summary-1", "code review approve run-1", "code review reject run-1"],
      },
    },
  };
  const selected = formatCodePerception(perception, "selected");
  expect(selected).toContain("/show summary-1");
  expect(selected).toContain("/review approve run-1");
  expect(selected).toContain("/review reject run-1");
  expect(selected).toContain("evidence is stale");
  expect(selected).toContain("does not commit or push");
  const foreign = formatCodePerception(perception, "other");
  expect(foreign).toContain("In session selected: code review approve run-1");
  expect(foreign).not.toContain("/review approve");
  expect(workflowShortcut("code review approve last")).toBeUndefined();
  expect(workflowShortcut("code review approve run-1\nquit")).toBeUndefined();
  expect(workflowShortcut("code review approve run-1\x1b[31m")).toBeUndefined();
  expect(workflowShortcut("code exec-approve token")).toBeUndefined();
});

it("shows explicit review decisions and unverified acceptance without letting historical reviews stop current work", async () => {
  const output: string[] = [];
  const view = new CodeConsole({
    agent: { getSession: () => null, command: async () => [] } as unknown as MarinaAgent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "selected",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = (text) => {
    output.push(text);
  };
  const event = (code: Record<string, unknown>): Perception => ({
    kind: "message",
    timestamp: 0,
    data: { code: { sessionId: "selected", ...code } },
  });
  try {
    view.observe(
      event({ event: "session_status", metadata: { runId: "first", runStatus: "submitted" } }),
    );
    view.observe(
      event({
        event: "task_run_review",
        status: "approved",
        metadata: { runId: "first", unverifiedAcceptance: { reason: "owner waiver" } },
      }),
    );
    await view.submit("/agents");
    expect(output.at(-1)).toContain("accepted unverified");
    view.observe(
      event({
        event: "session_status",
        metadata: {
          runId: "first",
          runStatus: "submitted",
          reviewStatus: "approved",
          acceptedUnverified: true,
        },
      }),
    );
    await view.submit("/agents");
    expect(output.at(-1)).toContain("accepted unverified");
    view.observe(
      event({ event: "code_lifecycle", phase: "received", metadata: { runId: "second" } }),
    );
    view.observe(
      event({ event: "task_run_review", status: "rejected", metadata: { runId: "first" } }),
    );
    expect(view.busy()).toBe(true);
    await view.submit("/agents");
    expect(output.at(-1)).toContain("working");
  } finally {
    await view.close(0);
  }
});

it("retains a queued workflow destination when an independent world command changes selection", async () => {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const requests: { text: string; options?: CommandOptions }[] = [];
  const view = new CodeConsole({
    agent: {
      getSession: () => null,
      command: async (text: string, options?: CommandOptions) => {
        requests.push({ text, options });
        if (text === "code doctor") {
          entered.resolve();
          await release.promise;
        }
        if (text === "/code resume second")
          return Object.assign(
            [
              {
                kind: "message",
                timestamp: 0,
                command_request_id: "selection",
                data: { code: { event: "session_resumed", sessionId: "second" } },
              },
            ],
            { completion: "confirmed" },
          );
        return [];
      },
    } as unknown as MarinaAgent,
    url: "http://fixture",
    root: directory,
    directory,
    sessionId: "first",
    connected: true,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: () => {},
  });
  view.write = () => {};
  const inspection = view.submit("/project");
  try {
    await entered.promise;
    const check = view.submit("/verify");
    const task = view.submit("/task Fix in the original project");
    await view.submit("/world code resume second");
    release.resolve();
    await inspection;
    await check;
    await task;
    for (const request of requests.filter((request) =>
      [
        "code doctor",
        "code verify candidate",
        "code do verification:candidate -- Fix in the original project",
      ].includes(request.text),
    ))
      expect(request.options?.codingTarget?.sessionId).toBe("first");
    await view.submit("/diff");
    expect(requests.at(-1)?.options?.codingTarget?.sessionId).toBe("second");
  } finally {
    release.resolve();
    await inspection;
    await view.close(0);
  }
});

it("a live panel view preserves coding and world drafts and never turns panel input into a coding task", async () => {
  using fixture = focusedTerminal();
  const { input, terminal, lines } = fixture;
  input.write("unfinished coding draft");
  terminal.setPanelContent("Panel revision one", true);
  input.write("field request a panel draft");
  terminal.write("Another resident says hello", "world");
  terminal.setPanelContent("Panel revision two");
  input.write("\n");
  terminal.selectView("coding");
  input.write(" continued\n");
  await until(() => lines.length === 2);
  expect(lines).toEqual([
    "/panel field request a panel draft",
    "unfinished coding draft continued",
  ]);
});
