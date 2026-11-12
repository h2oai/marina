// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The SDK front door, end to end: `Marina.connect` against a live server, a
// coding run driven by a scripted model, every coding frame checked against
// marina.wire.v1; and `Marina.local` / `marina serve` as a real child process.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { grant } from "../src/engine/safety-gates";
import type { MarinaDB } from "../src/persistence/database";
import * as wire from "../src/protocol/wire";
import type { MarinaClient } from "../src/sdk/client";
import {
  budgetArgument,
  CODING_ACTIVITY_KINDS,
  type CodeEvent,
  type CodingActivity,
  codeEventOf,
  MarinaCoding,
  RUN_OUTCOMES,
  type RunResult,
  VERIFICATIONS,
} from "../src/sdk/coding";
import { Marina, serverUrls } from "../src/sdk/marina";
import type { Perception } from "../src/sdk/protocol";
import type { EntityId } from "../src/types";
import {
  SCRIPTED_TASK,
  type ScriptedCodingServer,
  startScriptedCodingServer,
} from "./fixtures/scripted-coding-server";
import { until } from "./helpers";

// The SDK's plain types name the wire schema's fields, both ways (compile time);
// their allowed values are the schema's (below, at run time).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Fields<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };
const activityFields: Same<keyof CodingActivity, Fields<Static<typeof wire.CodingActivity>>> = true;
const resultFields: Same<keyof RunResult, Fields<Static<typeof wire.RunResult>>> = true;
void activityFields;
void resultFields;
const literals = (schema: unknown): string[] =>
  ((schema as { anyOf: { const: string }[] }).anyOf ?? []).map((s) => s.const).sort();

const ROOT = resolve(import.meta.dir, "..");
function check(schema: TSchema, value: unknown): boolean {
  if (Value.Check(schema, value)) return true;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => JSON.stringify(e));
  throw new Error(`Not on the wire schema:\n${errors.join("\n")}\n${JSON.stringify(value)}`);
}

describe("the SDK's coding types are the wire schema's", () => {
  it("allows the same values", () => {
    const props = wire.CodingActivity.properties as Record<string, unknown>;
    expect(literals(props.kind)).toEqual([...CODING_ACTIVITY_KINDS].sort());
    expect(literals(wire.Verification)).toEqual([...VERIFICATIONS].sort());
    const run = wire.RunResult.properties as Record<string, unknown>;
    expect(literals(run.outcome)).toEqual([...RUN_OUTCOMES].sort());
  });
});

describe("reading coding frames", () => {
  const frame = (code: Record<string, unknown>) =>
    ({ kind: "message", timestamp: 1, tag: "code", data: { text: "t", code } }) as Perception;

  it("takes a run's end from the event when its metadata has no phase", () => {
    // A blocked run ends with metadata { runId, reason, terminal, outcome } and phase on the event.
    const event = codeEventOf(
      frame({
        event: "code_lifecycle",
        type: "lifecycle",
        phase: "failed",
        metadata: {
          runId: "task_run_1",
          reason: "blocked",
          terminal: true,
          outcome: "interrupted",
        },
      }),
    );
    expect(event?.result).toEqual({
      runId: "task_run_1",
      reason: "blocked",
      terminal: true,
      outcome: "interrupted",
      phase: "failed",
    });
    expect(check(wire.RunResult, event?.result)).toBe(true);
    // Not an end: no terminal flag.
    expect(
      codeEventOf(frame({ event: "code_lifecycle", type: "lifecycle", metadata: { runId: "r" } }))
        ?.result,
    ).toBeUndefined();
  });

  it("answers exec approvals, and denies when the handler fails or says anything but yes", async () => {
    const listeners: ((p: Perception) => void)[] = [];
    const sent: string[] = [];
    const client = {
      onPerception: (fn: (p: Perception) => void) => listeners.push(fn),
      command: async (text: string) => {
        sent.push(text);
        return [];
      },
    };
    const coding = new MarinaCoding(client as unknown as MarinaClient);
    const ask = (token: string) => {
      for (const fn of listeners)
        fn({
          kind: "message",
          timestamp: 1,
          tag: "code",
          data: { text: "", execApproval: { token, argv: ["make"], cwd: "/w", rendered: "make" } },
        });
    };
    const answers: Record<string, () => unknown> = {
      a: () => true,
      b: () => false,
      c: () => {
        throw new Error("handler broke");
      },
      d: () => "yes",
    };
    coding.onExecApproval((request) => answers[request.token]!() as boolean);
    for (const token of Object.keys(answers)) ask(token);
    await until(() => sent.length === 4);
    expect(sent.sort()).toEqual([
      "code exec-approve a",
      "code exec-deny b",
      "code exec-deny c",
      "code exec-deny d",
    ]);
  });
});

describe("budget argument", () => {
  it("turns milliseconds and durations into code do's budget", () => {
    expect(budgetArgument(90_000)).toBe("90s");
    expect(budgetArgument(1)).toBe("1s");
    expect(budgetArgument("10m")).toBe("10m");
    expect(() => budgetArgument("ten minutes")).toThrow();
    expect(() => budgetArgument(0)).toThrow();
  });
  it("names one server by its ws and http URLs", () => {
    expect(serverUrls("http://127.0.0.1:3300/")).toEqual({
      ws: "ws://127.0.0.1:3300",
      http: "http://127.0.0.1:3300",
    });
    expect(serverUrls("wss://marina.example/world").http).toBe("https://marina.example/world");
    expect(serverUrls("ws://localhost:3300/ws")).toEqual({
      ws: "ws://localhost:3300/ws",
      http: "http://localhost:3300",
    });
    expect(() => serverUrls("ws://u:p@host")).toThrow();
  });
});

describe("Marina.connect: a coding run, followed to its result", () => {
  let fixture: ScriptedCodingServer;
  let url: string;
  let db: MarinaDB;
  beforeAll(async () => {
    fixture = await startScriptedCodingServer(["builder"]);
    url = fixture.url;
    db = fixture.db;
  });
  afterAll(() => fixture.dispose());

  it("runs a task: typed steps with their diffs, then a Run result, all on the wire schema", async () => {
    const marina = await Marina.connect(url, { name: "builder" });
    try {
      grant(db, marina.session.entityId as EntityId, "code.exec");
      expect(marina.httpUrl).toBe(url.replace("ws:", "http:"));
      const frames: unknown[] = [];
      const stopListening = marina.onEvent((frame) => {
        if (wire.classifyServerFrame(frame as never) === "Code") frames.push(frame);
      });
      const run = await marina.code.run(SCRIPTED_TASK, {
        verification: "candidate",
        timeoutMs: 120_000,
      });
      const events: CodeEvent[] = [];
      for await (const event of run.events) events.push(event);
      const result = await run.result;
      stopListening();

      expect(run.runId).toStartWith("task_run_");
      expect(result).toMatchObject({
        runId: run.runId,
        terminal: true,
        phase: "completed",
        outcome: "submitted",
      });
      expect(result.summary).toContain("rounds up");
      expect(check(wire.RunResult, result)).toBe(true);

      const steps = events.flatMap((e) => (e.activity ? [e.activity] : []));
      const edit = steps.find((s) => s.kind === "edit" && s.path === "source.ts");
      expect(edit?.diff).toEqual(["-Math.floor(total / size)", "+Math.ceil(total / size)"]);
      for (const step of steps) expect(check(wire.CodingActivity, step)).toBe(true);
      expect(events.at(-1)?.result?.runId).toBe(run.runId);
      expect(frames.length).toBeGreaterThan(5);
      for (const frame of frames) expect(check(wire.CodeFrame, frame)).toBe(true);

      expect(await marina.code.diff()).toContain("+  return Math.ceil(total / size);");
      await marina.code.review(result.runId, "approve");
    } finally {
      await marina.close();
    }
  }, 150_000);

  it("refuses an empty task, needs a name or a token, and resumes a dropped session", async () => {
    await expect(Marina.connect(url, {})).rejects.toThrow("name to log in");
    const marina = await Marina.connect(url, { name: "visitor" });
    await expect(marina.code.run("   ")).rejects.toThrow("Empty task");
    // The same session over HTTP: routing signed in with this session's token.
    expect(await marina.routing.discover()).toBeObject();
    const { entityId } = marina.session;
    const token = marina.token;
    await marina.close();
    const resumed = await Marina.connect(url, { token });
    try {
      expect(resumed.session.entityId).toBe(entityId);
      // Each token works once: the reply carried a new one.
      expect(resumed.token).not.toBe(token);
    } finally {
      await resumed.close();
    }
  });
});

describe("Marina.local: the folder's own server", () => {
  const marinaCommand = ["bun", "run", join(ROOT, "scripts/marina.ts")];
  let folder: string;
  let home: string;
  // A clean machine: no ~/.marina settings and no provider key.
  const env = () => ({
    HOME: home,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
  });
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "marina-sdk-local-"));
    home = mkdtempSync(join(tmpdir(), "marina-sdk-home-"));
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("starts the server, logs in as its owner, opens Code Mode in the folder, and stops it", async () => {
    const marina = await Marina.local(folder, { fresh: true, command: marinaCommand, env: env() });
    let pid = 0;
    try {
      expect(marina.session.name).toBe("coder");
      const status = (await (await fetch(`${marina.httpUrl}/api/setup-status`)).json()) as {
        pid: number;
      };
      pid = status.pid;
      // With no model, coding says what to do instead of failing later.
      await expect(marina.code.run("Add a README")).rejects.toThrow("No model provider configured");
      const look = await marina.command("look");
      expect(look.completion).toBe("confirmed");
    } finally {
      await marina.close();
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }, 120_000);

  it("marina serve stops when the program that started it goes away", async () => {
    const child = Bun.spawn([...marinaCommand, "serve", folder, "--fresh", "--json"], {
      env: { ...process.env, ...env() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const announcement = JSON.parse(out) as { protocol: string; pid: number; name: string };
    expect(announcement).toMatchObject({ protocol: "marina.local.v1", name: "coder" });
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(() => process.kill(announcement.pid, 0)).toThrow();
  }, 120_000);

  it("names a folder that does not exist", async () => {
    await expect(Marina.local(join(folder, "missing"), { command: marinaCommand })).rejects.toThrow(
      "Not a folder",
    );
  }, 60_000);
});
