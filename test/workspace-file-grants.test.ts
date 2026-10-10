// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerRunArgv, resolveContainerRunner } from "../src/coding/container-workspace";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { workspaceFileGrants } from "../src/coding/workspace-file-grants";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";

describe("operator-scoped task files", () => {
  let dir: string;
  let root: string;
  let inputs: string;
  let outputs: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-task-files-"));
    root = join(dir, "workspace");
    inputs = join(dir, "inputs");
    outputs = join(dir, "outputs");
    for (const path of [root, inputs, outputs]) mkdirSync(path);
    writeFileSync(join(inputs, "data.csv"), "name,value\na,3\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads explicit inputs and writes outputs without granting another executable workspace", async () => {
    const registry = new WorkspaceRegistry({
      roots: [root],
      inputRoots: [inputs],
      outputRoots: [outputs],
    });
    const ws = registry.defaultWorkspace();
    expect((await ws.read(join(inputs, "data.csv"))).content).toContain("a,3");
    expect(ws.list(inputs)[0]!.path).toBe(join(inputs, "data.csv"));
    expect((await ws.search("a,3", 10, inputs))[0]!.path).toBe(join(inputs, "data.csv"));
    expect((await ws.writeFile(join(outputs, "summary.json"), '{"total":3}')).ok).toBe(true);
    expect((await ws.editFile(join(outputs, "summary.json"), "3", "4")).ok).toBe(true);
    expect(readFileSync(join(outputs, "summary.json"), "utf8")).toBe('{"total":4}');
    await expect(ws.writeFile(join(inputs, "new.txt"), "no")).rejects.toThrow("read-only");
    await expect(ws.editFile(join(inputs, "data.csv"), "3", "9")).rejects.toThrow("read-only");
    expect(() => registry.resolveRoot(outputs)).toThrow("outside allowed roots");
    expect(() => ws.list(dir)).toThrow("explicitly granted");
    await expect(ws.read("../inputs/data.csv")).rejects.toThrow("escapes");
  });

  it("rejects symlink escapes, including a new output under a symlinked parent", async () => {
    const ws = new LocalWorkspace(root, workspaceFileGrants([inputs], [outputs]));
    symlinkSync(inputs, join(outputs, "escape"));
    await expect(ws.writeFile(join(outputs, "escape", "new.txt"), "bad")).rejects.toThrow(
      "escapes",
    );
    symlinkSync(join(dir, "does-not-exist"), join(outputs, "dangling"));
    await expect(ws.writeFile(join(outputs, "dangling"), "bad")).rejects.toThrow();
    symlinkSync(outputs, join(root, "escape"));
    await expect(ws.writeFile("escape/new.txt", "bad")).rejects.toThrow("escapes");
    mkdirSync(join(outputs, ".git"));
    await expect(ws.writeFile(join(outputs, ".git", "config"), "bad")).rejects.toThrow("metadata");
  });

  it("requires explicit, disjoint operator roots and supports a default root set alone", () => {
    expect(() => workspaceFileGrants([inputs], [inputs])).toThrow("overlap");
    expect(() => new LocalWorkspace(root, workspaceFileGrants([root]))).toThrow("separate");
    const registry = WorkspaceRegistry.fromEnv({
      MARINA_CODE_DEFAULT_ROOT: root,
      MARINA_CODE_INPUT_ROOTS: inputs,
      MARINA_CODE_OUTPUT_ROOTS: outputs,
    });
    expect(registry.hostExecAllowed).toBe(true);
    expect(registry.defaultRoot).toBe(root);
    expect(registry.fileGrants).toHaveLength(2);
  });

  it("makes host/guest mappings explicit, keeps inputs read-only, and refuses patch-mode mounts", () => {
    const grants = workspaceFileGrants([inputs], [outputs]);
    const runner = resolveContainerRunner(
      { image: "python:3.13", runtime: "podman" },
      {},
      () => "/usr/bin/podman",
    );
    const argv = containerRunArgv(runner, root, ["python", "check.py"], "task-test", {
      readOnlyPaths: [],
      fileGrants: grants,
    });
    expect(argv).toContain(`${inputs}:/marina-task/inputs/0:ro`);
    expect(argv).toContain(`${outputs}:/marina-task/outputs/0:rw`);
    expect(argv).toContain("none"); // Network remains independently denied.
    expect(() =>
      containerRunArgv({ ...runner, sync: "patch" }, root, ["true"], "task-test", {
        fileGrants: grants,
      }),
    ).toThrow("never mounts");
  });
});
