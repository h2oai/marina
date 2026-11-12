// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Python SDK (sdks/python), held to the same contract as the TypeScript one: its unit
// tests, its coding types against marina.wire.v1, its operation table against marina.http.v1,
// a whole coding run on a live server with every coding frame checked against the schema, and
// Marina.local through `marina serve`. Needs python3 (3.10+) on PATH, nothing else.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { renderPythonOperations } from "../scripts/generate-openapi";
import { grant } from "../src/engine/safety-gates";
import * as wire from "../src/protocol/wire";
import type { EntityId } from "../src/types";
import {
  SCRIPTED_TASK,
  type ScriptedCodingServer,
  startScriptedCodingServer,
} from "./fixtures/scripted-coding-server";

const ROOT = resolve(import.meta.dir, "..");
const SDK = join(ROOT, "sdks/python");
const PYTHON = process.env.MARINA_TEST_PYTHON ?? "python3";

function check(schema: TSchema, value: unknown, what: string): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => JSON.stringify(e));
  throw new Error(
    `${what} is not on the wire schema:\n${errors.join("\n")}\n${JSON.stringify(value)}`,
  );
}

async function python(args: string[], options: { env?: Record<string, string> } = {}) {
  const child = Bun.spawn([PYTHON, ...args], {
    cwd: ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const literals = (schema: unknown): string[] =>
  ((schema as { anyOf?: { const: string }[] }).anyOf ?? []).map((s) => s.const).sort();

describe("Python SDK: offline", () => {
  it("passes its own unit tests", async () => {
    const run = await python([
      "-X",
      "dev",
      "-m",
      "unittest",
      "discover",
      "-s",
      join(SDK, "tests"),
      "-p",
      "test_*.py",
    ]);
    expect(run.stderr).toMatch(/\nOK\s*$/);
    expect(run.code).toBe(0);
  }, 60_000);

  it("names the wire schema's coding fields and allows its values", async () => {
    const run = await python([
      "-c",
      `import sys, json, dataclasses; sys.path.insert(0, "${SDK}/src")
import marina.wire as w
print(json.dumps({
  "activity": sorted(f.name for f in dataclasses.fields(w.CodingActivity)),
  "result": sorted(f.name for f in dataclasses.fields(w.RunResult) if f.name != "raw"),
  "kinds": sorted(w.CODING_ACTIVITY_KINDS), "verifications": sorted(w.VERIFICATIONS),
  "outcomes": sorted(w.RUN_OUTCOMES), "protocol": w.WIRE_PROTOCOL}))`,
    ]);
    expect(run.code).toBe(0);
    const py = JSON.parse(run.stdout);
    const fields = (schema: TSchema) =>
      Object.keys((schema as { properties: Record<string, unknown> }).properties)
        .map(snake)
        .sort();
    expect(py.activity).toEqual(fields(wire.CodingActivity));
    expect(py.result).toEqual(fields(wire.RunResult));
    const props = wire.CodingActivity.properties as Record<string, unknown>;
    expect(py.kinds).toEqual(literals(props.kind));
    expect(py.verifications).toEqual(literals(wire.Verification));
    expect(py.outcomes).toEqual(
      literals((wire.RunResult.properties as Record<string, unknown>).outcome),
    );
    expect(py.protocol).toBe(wire.WIRE_PROTOCOL);
  });

  it("carries every HTTP operation (generated) and the repository's version", () => {
    expect(readFileSync(join(SDK, "src/marina/_operations.py"), "utf8")).toBe(
      renderPythonOperations(),
    );
    const version = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
    expect(readFileSync(join(SDK, "pyproject.toml"), "utf8")).toContain(`version = "${version}"`);
    expect(readFileSync(join(SDK, "src/marina/__init__.py"), "utf8")).toContain(
      `__version__ = "${version}"`,
    );
  });
});

describe("Python SDK: a coding run on a live server", () => {
  let fixture: ScriptedCodingServer;
  beforeAll(async () => {
    fixture = await startScriptedCodingServer(["pybuilder"]);
  });
  afterAll(() => fixture.dispose());

  it("runs a task to its result, reviews it, and uses the HTTP APIs", async () => {
    const principal = fixture.db.ensurePrincipal({ type: "service", displayName: "PyMemory" });
    const credential = fixture.db.issueMemoryCredential(principal.principal_id).token;
    const child = Bun.spawn(
      [PYTHON, join(SDK, "tests/live/coding.py"), fixture.url, SCRIPTED_TASK, credential],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let out = "";
    const line = async () => {
      while (!out.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const [first, ...rest] = out.split("\n");
      out = rest.join("\n");
      return first ?? "";
    };
    const hello = await line();
    if (!hello.startsWith("{")) throw new Error(`Python said: ${hello}\n${await stderr}`);
    grant(fixture.db, JSON.parse(hello).entity as EntityId, "code.exec");
    child.stdin.write("go\n");
    child.stdin.flush();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const code = await child.exited;
    if (code !== 0) throw new Error(`coding.py failed (${code}):\n${await stderr}`);
    const report = JSON.parse((out + rest).trim());

    expect(report.empty).toContain("Empty task");
    expect(report.run_id).toStartWith("task_run_");
    expect(report.result).toMatchObject({
      runId: report.run_id,
      terminal: true,
      phase: "completed",
      outcome: "submitted",
    });
    check(wire.RunResult, report.result, "the Run result");
    expect(report.result_fields).toMatchObject({ run_id: report.run_id, submitted: true });
    expect(report.result_fields.summary).toContain("rounds up");
    expect(report.last_event_run).toBe(report.run_id);
    const edit = report.steps.find((s: { kind: string }) => s.kind === "edit");
    expect(edit).toMatchObject({
      path: "source.ts",
      diff: ["-Math.floor(total / size)", "+Math.ceil(total / size)"],
    });
    for (const step of report.steps)
      check(
        wire.CodingActivity,
        Object.fromEntries(Object.entries(step).filter(([, v]) => v !== null)),
        "a step",
      );
    expect(report.frames.length).toBeGreaterThan(5);
    for (const frame of report.frames) check(wire.CodeFrame, frame, "a code frame");
    expect(report.diff).toContain("+  return Math.ceil(total / size);");
    // A command in Code Mode is still a command, not a task for the coder.
    expect(report.look).toContain("Start");
    expect(report.refused).toBeString();
    expect(report.discover).toBeObject();
    expect(report.capability_count).toBeGreaterThan(20);
    expect(report.memory).toEqual({ replayed: true, found: true });
    expect(report.resumed).toEqual({ same: true, new_token: true });
  }, 180_000);
});

describe("Python SDK: Marina.local", () => {
  let folder: string;
  let home: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "marina-py-local-"));
    home = mkdtempSync(join(tmpdir(), "marina-py-home-"));
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("starts the folder's server, logs in as its owner, and stops it on close", async () => {
    const run = await python(
      [
        join(SDK, "tests/live/local.py"),
        folder,
        JSON.stringify(["bun", "run", join(ROOT, "scripts/marina.ts")]),
      ],
      {
        // A clean machine: no ~/.marina settings and no provider key.
        env: {
          HOME: home,
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          OPENROUTER_API_KEY: "",
          GEMINI_API_KEY: "",
        },
      },
    );
    if (run.code !== 0) throw new Error(`local.py failed (${run.code}):\n${run.stderr}`);
    const report = JSON.parse(run.stdout);
    expect(report.name).toBe("coder");
    expect(report.refused).toContain("No model provider configured");
    expect(report.look).toBe(true);
    expect(report.stopped).toBe(true);
    expect(report.missing).toContain("Not a folder");
  }, 120_000);
});
