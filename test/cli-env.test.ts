// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnvironment, settingsFiles } from "../scripts/cli-env";

describe("marina CLI settings", () => {
  let home: string;
  let checkout: string;
  let instance: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "marina-cli-env-"));
    checkout = join(home, "checkout");
    instance = join(home, ".marina", "projects", "proj");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(instance, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("layers shell > instance > ~/.marina/.env > checkout, each filling only what is unset", () => {
    writeFileSync(join(checkout, ".env"), "A=checkout\nB=checkout\nC=checkout\nD=checkout\n");
    writeFileSync(join(home, ".marina", ".env"), "A=user\nB=user\nC=user\n");
    writeFileSync(join(instance, ".env"), "A=instance\nB=instance\n");
    const env = cliEnvironment({
      env: { HOME: home, A: "shell" },
      instanceDir: instance,
      checkoutDir: checkout,
    });
    expect([env.A, env.B, env.C, env.D]).toEqual(["shell", "instance", "user", "checkout"]);
    // Without an instance (every command but a folder session or `start`).
    const base = cliEnvironment({ env: { HOME: home }, checkoutDir: checkout });
    expect([base.A, base.B, base.D]).toEqual(["user", "user", "checkout"]);
  });

  it("never reads the project's own .env and works with no settings files at all", () => {
    const project = join(home, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".env"), "OPENAI_API_KEY=the-apps-key\n");
    const files = settingsFiles({
      env: { HOME: home },
      instanceDir: instance,
      checkoutDir: undefined,
    });
    expect(files).toEqual([join(instance, ".env"), join(home, ".marina", ".env")]);
    expect(cliEnvironment({ env: { HOME: home }, checkoutDir: undefined }).OPENAI_API_KEY).toBe(
      undefined,
    );
  });

  it("an explicit --env-file replaces every settings file; --no-env-file keeps them", () => {
    writeFileSync(join(home, ".marina", ".env"), "MARINA_CLI_ENV_PROBE=user\n");
    const module = join(import.meta.dir, "..", "scripts", "cli-env.ts");
    const probe = (flag: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          flag,
          "-e",
          `const { cliEnvironment } = await import(${JSON.stringify(module)});` +
            "console.log(cliEnvironment().MARINA_CLI_ENV_PROBE ?? 'unset')",
        ],
        { cwd: home, env: { PATH: process.env.PATH, HOME: home } },
      )
        .stdout.toString()
        .trim();
    expect(probe("--env-file=/dev/null")).toBe("unset");
    expect(probe("--no-env-file")).toBe("user");
  });

  it("the bin and the native build both opt out of Bun's working-directory .env", () => {
    const root = join(import.meta.dir, "..");
    const bin = readFileSync(join(root, "scripts", "marina.ts"), "utf8").split("\n")[0];
    expect(bin).toBe("#!/usr/bin/env -S bun --no-env-file");
    expect(readFileSync(join(root, "scripts", "build-native.ts"), "utf8")).toContain(
      '"--no-compile-autoload-dotenv"',
    );
  });
});
