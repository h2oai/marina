// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCandidateBunDependencies } from "../src/coding/candidate-dependencies";
import { HostExecForbiddenError, LocalWorkspace } from "../src/coding/local-workspace";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-dependency-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(
    join(root, "bun.lock"),
    JSON.stringify({ lockfileVersion: 2, workspaces: { "": { name: "fixture" } }, packages: {} }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("refuses unsupported resolutions and unsafe manifest paths before executing anything", async () => {
  const cases = [
    { manifest: { dependencies: { dep: "git+https://example.invalid/repo" } } },
    { manifest: { dependencies: { dep: "file:/etc" } } },
    { manifest: { workspaces: ["../escape"] } },
    { manifest: { patchedDependencies: { "dep@1.0.0": "../escape" } } },
    { packages: { dep: ["dep@1.0.0", "https://private.invalid/pkg", {}, "sha512-AAAA"] } },
    { packages: { dep: ["dep@file:../escape"] } },
    { packages: { dep: ["dep@1.0.0", "", {}] } },
    { packages: { dep: ["dep@workspace:missing"] } },
    { workspaces: { "": {}, "../escape": {} } },
  ];
  for (const input of cases) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", ...input.manifest }),
    );
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 2,
        workspaces: input.workspaces ?? { "": {} },
        packages: input.packages ?? {},
      }),
    );
    const prepared = await prepareCandidateBunDependencies(root, async () => {
      throw new Error("UNEXPECTED SPAWN");
    });
    expect(prepared.result.exitCode).toBe(1);
    expect(prepared.result.output).not.toContain("UNEXPECTED SPAWN");
  }
  rmSync(join(root, "package.json"));
  symlinkSync("/etc/passwd", join(root, "package.json"));
  const symlink = await prepareCandidateBunDependencies(root, async () => {
    throw new Error("UNEXPECTED SPAWN");
  });
  expect(symlink.result.output).toContain("not symlinks");
});

it("refuses captured dependencies and forbids host execution at the preparation boundary", async () => {
  mkdirSync(join(root, "node_modules"));
  const workspace = new LocalWorkspace(root);
  expect((await workspace.prepareCandidateDependencies(() => {})).result.output).toContain(
    "without captured node_modules",
  );
  workspace.setHostExecForbidden(true);
  expect(() => workspace.prepareCandidateDependencies(() => {})).toThrow(HostExecForbiddenError);
  workspace.setHostExecForbidden(false);
  await expect(
    workspace.prepareCandidateDependencies(() => {
      throw new Error("access revoked");
    }),
  ).rejects.toThrow("access revoked");
});

it("freezes lock resolution, keeps source and disposes the private config/cache", async () => {
  mkdirSync(join(root, "dep"));
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  writeFileSync(
    join(root, "other/package.json"),
    JSON.stringify({ name: "other", version: "1.0.0" }),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      workspaces: ["dep", "other"],
      dependencies: { dep: "workspace:*", other: "workspace:*" },
    }),
  );
  writeFileSync(
    join(root, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: {
        "": { name: "fixture", dependencies: { dep: "workspace:*" } },
        dep: { name: "dep", version: "1.0.0" },
      },
      packages: { dep: ["dep@workspace:dep"] },
    }),
  );
  const lock = readFileSync(join(root, "bun.lock"));
  const result = await new LocalWorkspace(root).prepareCandidateDependencies(() => {});
  expect(result.result.exitCode).not.toBe(0);
  expect(result.result.output).toContain("frozen");
  expect(readFileSync(join(root, "bun.lock"))).toEqual(lock);
  expect(result.result.command.some((arg) => arg.startsWith("--config="))).toBe(false);
});

it("executes under a private config/cache and disposes those directories on success", async () => {
  const result = await prepareCandidateBunDependencies(root, async (command, environment) => {
    expect(environment.HOME).toContain("marina-candidate-deps-");
    expect(Object.keys(environment).sort()).toEqual([
      "BUN_INSTALL_CACHE_DIR",
      "BUN_TMPDIR",
      "HOME",
      "XDG_CONFIG_HOME",
    ]);
    return {
      command,
      exitCode: 0,
      output: "prepared",
      timedOut: false,
      truncated: false,
      durationMs: 1,
    };
  });
  expect(result.result.exitCode).toBe(0);
  const config = result.result.command
    .find((arg) => arg.startsWith("--config="))!
    .slice("--config=".length);
  expect(existsSync(config)).toBe(false);
});

it("drains large command output concurrently and retains bounded output", async () => {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "bun verbose.ts" } }),
  );
  writeFileSync(
    join(root, "verbose.ts"),
    'for (let i = 0; i < 256; i++) { console.log("a".repeat(4096)); console.error("b".repeat(4096)); }',
  );
  const result = await new LocalWorkspace(root).run(["bun", "run", "test"], 5000, 1024);
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.truncated).toBe(true);
  expect(result.output.length).toBeLessThanOrEqual(1024);
});

it("times out the check process group instead of waiting forever on a child's pipe", async () => {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "bun waiting.ts" } }),
  );
  writeFileSync(join(root, "waiting.ts"), 'setInterval(() => console.log("waiting"), 10);');
  const result = await new LocalWorkspace(root).run(["bun", "run", "test"], 100, 1024);
  expect(result.timedOut).toBe(true);
  expect(result.durationMs).toBeLessThan(4500);
  expect(result.output).toContain("waiting");
});
