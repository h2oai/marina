// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_ENV_VAR, providerEnvironmentKeys, scrubTestEnvironment } from "./hermetic-env";

describe("test environment hygiene", () => {
  it("deletes optional environment variables instead of assigning undefined", () => {
    const violations: string[] = [];
    const assignment = /process\.env(?:\.[A-Z0-9_]+|\[[^\]]+\])\s*=\s*undefined\b/g;

    for (const path of new Bun.Glob("test/**/*.test.ts").scanSync()) {
      if (path.endsWith("env-hygiene.test.ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(assignment)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${path}:${line}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("scrubs leaked configuration and provider credentials before tests run", () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-hermetic-"));
    try {
      writeFileSync(join(dir, ".env"), "SOME_DOTENV_ONLY_SETTING=1\n");
      const env: Record<string, string | undefined> = {
        MARINA_DECISIONS: "auto",
        MARINA_DAILY_SPEND_CAP_USD: "0",
        MARINA_SOMETHING_NEW: "x",
        OPENROUTER_API_KEY: "k",
        HF_TOKEN: "k",
        OLLAMA_BASE_URL: "http://localhost:11434/v1",
        TAVILY_API_KEY: "k",
        SOME_DOTENV_ONLY_SETTING: "1",
        MARINA_TEST_CONTAINER_IMAGE: "image",
        NODE_ENV: "test",
        PATH: "/bin",
      };
      const removed = scrubTestEnvironment(env, dir);
      expect(Object.keys(env).sort()).toEqual(["MARINA_TEST_CONTAINER_IMAGE", "NODE_ENV", "PATH"]);
      expect(removed).toContain("SOME_DOTENV_ONLY_SETTING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("covers every provider credential model discovery knows", () => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN"])
      expect(providerEnvironmentKeys()).toContain(key);
  });

  it(`keeps the environment under ${KEEP_ENV_VAR}=1`, () => {
    const env = { [KEEP_ENV_VAR]: "1", MARINA_DECISIONS: "auto", OPENAI_API_KEY: "k" };
    expect(scrubTestEnvironment(env, tmpdir())).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe("k");
  });
});
