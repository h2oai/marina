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
import { parseDispatch } from "../scripts/marina";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { RoutingService } from "../src/routing/service";
import type { CommandOptions, CommandResult, MarinaAgent, Perception } from "../src/sdk/client";
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
    for (const text of ["/status", "/diff", "/verify", "/verify live", "/review"])
      await view.submit(text);
    expect(requests.map((request) => request.text)).toEqual([
      "code status",
      "code diff",
      "code verify candidate",
      "code verify start",
      "code review",
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
    expect(requests).toHaveLength(5);
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
