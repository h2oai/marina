// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Rust SDK (sdks/rust), held to the same contract as the TypeScript, Python and Java ones:
// - it builds with clippy's warnings as errors;
// - its unit tests (and doc examples) pass;
// - its coding types serialize with marina.wire.v1's field names;
// - its operation table matches marina.http.v1;
// - a whole coding run on a live server, with every coding frame checked against the schema;
// - Marina.local through `marina serve`.
// Needs cargo (Rust 1.88+) on PATH, or MARINA_TEST_CARGO; the first build fetches its crates.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { renderRustOperations } from "../scripts/generate-openapi";
import { grant } from "../src/engine/safety-gates";
import * as wire from "../src/protocol/wire";
import type { EntityId } from "../src/types";
import {
  SCRIPTED_TASK,
  type ScriptedCodingServer,
  startScriptedCodingServer,
} from "./fixtures/scripted-coding-server";

const ROOT = resolve(import.meta.dir, "..");
const SDK = join(ROOT, "sdks/rust");
const CARGO = process.env.MARINA_TEST_CARGO ?? "cargo";
const example = (name: string) => join(SDK, "target/debug/examples", name);

function check(schema: TSchema, value: unknown, what: string): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => JSON.stringify(e));
  throw new Error(
    `${what} is not on the wire schema:\n${errors.join("\n")}\n${JSON.stringify(value)}`,
  );
}

async function run(argv: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
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

const cargo = ([sub, ...rest]: string[]) =>
  run([CARGO, sub ?? "build", "--manifest-path", join(SDK, "Cargo.toml"), ...rest]);

const literals = (schema: unknown): string[] =>
  ((schema as { anyOf?: { const: string }[] }).anyOf ?? []).map((s) => s.const).sort();

beforeAll(async () => {
  const built = await cargo(["clippy", "--all-targets", "--", "-D", "warnings"]);
  if (built.code !== 0) throw new Error(`cargo clippy failed:\n${built.stdout}${built.stderr}`);
  const examples = await cargo(["build", "--examples"]);
  if (examples.code !== 0) throw new Error(`cargo build failed:\n${examples.stderr}`);
}, 600_000);

describe("Rust SDK: offline", () => {
  it("passes its own unit tests and doc examples", async () => {
    const result = await cargo(["test"]);
    expect(result.stdout).toContain("5 passed");
    expect(result.stdout).not.toContain("FAILED");
    expect(result.code).toBe(0);
  }, 600_000);

  it("names the wire schema's coding fields and allows its values", async () => {
    const result = await run([example("shape")]);
    expect(result.code).toBe(0);
    const shape = JSON.parse(result.stdout);
    const fields = (schema: TSchema) =>
      Object.keys((schema as { properties: Record<string, unknown> }).properties).sort();
    expect(shape.activity).toEqual(fields(wire.CodingActivity));
    expect(shape.result).toEqual(fields(wire.RunResult));
    const props = wire.CodingActivity.properties as Record<string, unknown>;
    expect([...shape.kinds].sort()).toEqual(literals(props.kind));
    expect([...shape.verifications].sort()).toEqual(literals(wire.Verification));
    expect([...shape.outcomes].sort()).toEqual(
      literals((wire.RunResult.properties as Record<string, unknown>).outcome),
    );
    expect(shape.protocol).toBe(wire.WIRE_PROTOCOL);
  }, 60_000);

  it("carries every HTTP operation (generated) and the repository's version", () => {
    expect(readFileSync(join(SDK, "src/operations.rs"), "utf8")).toBe(renderRustOperations());
    const version = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
    expect(readFileSync(join(SDK, "Cargo.toml"), "utf8")).toContain(`version = "${version}"`);
  });
});

describe("Rust SDK: a coding run on a live server", () => {
  let fixture: ScriptedCodingServer;
  beforeAll(async () => {
    fixture = await startScriptedCodingServer(["rsbuilder"]);
  });
  afterAll(() => fixture.dispose());

  it("runs a task to its result, reviews it, and uses the HTTP APIs", async () => {
    const principal = fixture.db.ensurePrincipal({ type: "service", displayName: "RustMemory" });
    const credential = fixture.db.issueMemoryCredential(principal.principal_id).token;
    const child = Bun.spawn([example("live_coding"), fixture.url, SCRIPTED_TASK, credential], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const [hello = "", ...rest] = out.split("\n");
    if (!hello.startsWith("{")) throw new Error(`Rust said: ${hello}\n${await stderr}`);
    grant(fixture.db, JSON.parse(hello).entity as EntityId, "code.exec");
    child.stdin.write("go\n");
    child.stdin.flush();
    let tail = rest.join("\n");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
    const code = await child.exited;
    if (code !== 0) throw new Error(`live_coding failed (${code}):\n${await stderr}`);
    const report = JSON.parse(tail.trim());

    expect(report.empty).toContain("Empty task");
    expect(report.run_id).toStartWith("task_run_");
    expect(report.result).toMatchObject({
      runId: report.run_id,
      terminal: true,
      phase: "completed",
      outcome: "submitted",
    });
    check(wire.RunResult, report.result, "the Run result");
    // The typed result serializes back to the same protocol fields.
    check(wire.RunResult, report.typed, "the typed Run result");
    expect(report.typed).toMatchObject({ runId: report.run_id, outcome: "submitted" });
    expect(report.submitted).toBe(true);
    expect(report.summary).toContain("rounds up");
    expect(report.last_event_run).toBe(report.run_id);
    expect(report.steps.find((s: { kind: string }) => s.kind === "edit")).toMatchObject({
      path: "source.ts",
      diff: ["-Math.floor(total / size)", "+Math.ceil(total / size)"],
    });
    for (const step of report.steps) check(wire.CodingActivity, step, "a step");
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

describe("Rust SDK: Marina::local", () => {
  let folder: string;
  let home: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "marina-rust-local-"));
    home = mkdtempSync(join(tmpdir(), "marina-rust-home-"));
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("starts the folder's server, logs in as its owner, and stops it on close", async () => {
    const result = await run(
      [
        example("live_local"),
        folder,
        JSON.stringify(["bun", "run", join(ROOT, "scripts/marina.ts")]),
      ],
      // A clean machine: no ~/.marina settings and no provider key.
      {
        HOME: home,
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        GEMINI_API_KEY: "",
      },
    );
    if (result.code !== 0) throw new Error(`live_local failed (${result.code}):\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    expect(report.name).toBe("coder");
    expect(report.alive).toBe(true);
    expect(report.refused).toContain("No model provider configured");
    expect(report.look).toBe(true);
    expect(report.stopped).toBe(true);
    expect(report.missing).toContain("Not a folder");
  }, 120_000);
});
