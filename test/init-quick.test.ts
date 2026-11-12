// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina init` asks at most one question: a key, whose provider it recognises. The instance
// name, world and admin keep their defaults (`--advanced` asks for each).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuredModel, providersForKey } from "../scripts/init";
import { parseEnvironment } from "../src/config/environment";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("providersForKey", () => {
  test("recognises a provider from the key's prefix", () => {
    expect(providersForKey("sk-ant-api03-abc")).toEqual(["anthropic"]);
    expect(providersForKey("sk-or-v1-abc")).toEqual(["openrouter"]);
    expect(providersForKey("gsk_abc")).toEqual(["groq"]);
    expect(providersForKey("AIzaSyAbc")).toEqual(["google"]);
    expect(providersForKey("sk-proj-abc")).toEqual(["openai"]);
    expect(providersForKey("  sk-abc  ")).toEqual(["openai"]);
  });

  test("an unrecognised key is tried against the providers with no documented prefix", () => {
    const candidates = providersForKey("tgp_v1_abc");
    expect(candidates).toContain("together");
    expect(candidates).toContain("nebius");
    expect(candidates).not.toContain("anthropic");
    expect(candidates).not.toContain("openai");
  });
});

describe("configuredModel", () => {
  test("saved settings come first, then the shell's environment", () => {
    expect(configuredModel({ ANTHROPIC_API_KEY: "k" }, {})).toEqual({
      label: "anthropic",
      source: "settings",
    });
    expect(configuredModel({ OLLAMA_BASE_URL: "http://localhost:11434/v1" }, {})?.source).toBe(
      "settings",
    );
    expect(configuredModel({}, { OPENAI_API_KEY: "k" })).toEqual({
      label: "openai (OPENAI_API_KEY)",
      source: "environment",
    });
    expect(configuredModel({ OPENAI_API_KEY: " " }, {})).toBeNull();
  });
});

test("with nothing pasted, setup writes the defaults and asks nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-init-quick-"));
  dirs.push(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
  const proc = Bun.spawn(
    [process.execPath, "--no-env-file", resolve("scripts/init.ts"), "--directory", dir],
    { cwd: dir, env, stdin: new TextEncoder().encode("\n"), stdout: "pipe", stderr: "pipe" },
  );
  const output =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(await proc.exited).toBe(0);
  expect(output).toContain("Connect a model");
  expect(output).not.toContain("Name your instance");
  expect(output).not.toContain("World [");
  expect(output).not.toContain("Admin name");
  expect(output).toContain("marina init --advanced");
  const values = parseEnvironment(readFileSync(join(dir, ".env"), "utf8"));
  expect(values.MARINA_WORLD).toBe("default");
  expect(values.MARINA_NAME).toBe("Marina");
});

test("--advanced with piped input takes each default and never starts a server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-init-advanced-"));
  dirs.push(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
  const proc = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve("scripts/init.ts"),
      "--directory",
      dir,
      "--advanced",
    ],
    { cwd: dir, env, stdin: new TextEncoder().encode("skip\n"), stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 20_000);
  const output =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  clearTimeout(timer);
  expect(await proc.exited).toBe(0);
  expect(output).not.toContain("Starting Marina");
  const values = parseEnvironment(readFileSync(join(dir, ".env"), "utf8"));
  expect(values.MARINA_WORLD).toBe("default");
});
