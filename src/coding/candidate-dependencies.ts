// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getErrorMessage } from "../engine/errors";
import type { WorkspaceRunResult } from "./local-workspace";

export const BUN_PREPARATION_POLICY = "bun-frozen-public-no-scripts-v1";
export interface CandidatePreparation {
  result: WorkspaceRunResult;
  policy: typeof BUN_PREPARATION_POLICY;
  lockfileSha256?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Dependency preparation requires object-shaped manifests and a Bun text lockfile.",
    );
  return value as Record<string, unknown>;
}

function safePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || [".", "..", ".git", "node_modules"].includes(part))
  )
    throw new Error("Dependency preparation refuses external or ambiguous workspace/patch paths.");
}

function readInside(root: string, path: string): string {
  safePath(path);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Dependency manifests and patches must be captured files, not symlinks.");
  }
  return readFileSync(current, "utf8");
}

function validateManifest(value: unknown): string[] {
  const manifest = object(value);
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
  ]) {
    if (manifest[key] === undefined) continue;
    for (const spec of Object.values(object(manifest[key]))) {
      // Frozen resolution supports public npm versions/tags/aliases and captured workspaces.
      // Reject file/git/URL protocols before Bun can resolve a changed manifest.
      if (
        typeof spec !== "string" ||
        !/^(?:workspace:[*^~0-9.x<>=| -]+|(?:npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@)?[a-zA-Z0-9.*^~<>=|+ -]+)$/.test(
          spec,
        )
      )
        throw new Error(
          "Dependency preparation supports public npm and captured workspace dependencies only.",
        );
    }
  }
  if (manifest.workspaces !== undefined) {
    const entries = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : object(manifest.workspaces).packages;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string"))
      throw new Error("Unsupported workspace manifest.");
    for (const entry of entries) safePath(entry);
    return entries;
  }
  return [];
}

function rejectCapturedDependencies(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (entry.name === "node_modules")
      throw new Error("Dependency preparation requires a candidate without captured node_modules.");
    if (entry.isDirectory()) rejectCapturedDependencies(join(root, entry.name));
  }
}

/** Called only on a disposable candidate, under the workspace lock and code.exec gate.
 * Deliberately not a general installer: no inherited registry credentials/config, install
 * scripts, live dependency links, or automatic resolution when the lockfile is missing. */
export async function prepareCandidateBunDependencies(
  root: string,
  execute: (command: string[], environment: Record<string, string>) => Promise<WorkspaceRunResult>,
): Promise<CandidatePreparation> {
  const started = Date.now();
  let control: string | undefined;
  let lockfileSha256: string | undefined;
  let command = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
  try {
    rejectCapturedDependencies(root);
    const lockText = readInside(root, "bun.lock");
    lockfileSha256 = createHash("sha256").update(lockText).digest("hex");
    const lock = object(Bun.JSONC.parse(lockText));
    if (lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2)
      throw new Error("Unsupported Bun text lockfile version.");
    const workspaces = object(lock.workspaces);
    if (!("" in workspaces)) throw new Error("Bun lockfile is missing its root workspace.");
    for (const path of Object.keys(workspaces)) {
      if (path) safePath(path);
      const patterns = validateManifest(
        JSON.parse(readInside(root, path ? `${path}/package.json` : "package.json")),
      );
      for (const pattern of patterns) {
        for (const file of new Bun.Glob(
          `${path ? `${path}/` : ""}${pattern}/package.json`,
        ).scanSync({ cwd: root, onlyFiles: true, followSymlinks: false })) {
          const workspacePath = file.slice(0, -"/package.json".length);
          if (!Object.hasOwn(workspaces, workspacePath))
            throw new Error(
              "Dependency preparation requires a frozen lockfile containing every declared workspace.",
            );
        }
      }
    }
    for (const entry of Object.values(object(lock.packages))) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string")
        throw new Error("Unsupported Bun package resolution.");
      const workspace = entry[0].match(/@workspace:(.+)$/);
      if (workspace) {
        if (!Object.hasOwn(workspaces, workspace[1]!))
          throw new Error("Lockfile workspace is not captured.");
      } else if (
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(
          entry[0],
        ) ||
        entry[1] !== "" ||
        typeof entry[3] !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry[3])
      ) {
        throw new Error(
          "Dependency preparation requires integrity-locked public npm packages; custom registries, URLs, Git and file dependencies are unsupported.",
        );
      }
    }
    const manifest = object(JSON.parse(readInside(root, "package.json")));
    for (const source of [manifest, lock]) {
      if (source.patchedDependencies === undefined) continue;
      for (const path of Object.values(object(source.patchedDependencies))) {
        if (typeof path !== "string") throw new Error("Unsupported patch declaration.");
        readInside(root, path);
      }
    }
    control = mkdtempSync(join(tmpdir(), "marina-candidate-deps-"));
    const home = join(control, "home");
    mkdirSync(home);
    const config = join(control, "bunfig.toml");
    writeFileSync(config, '[install]\nregistry = "https://registry.npmjs.org"\n');
    // Generated dependencies are excluded only in this private repository. Captured
    // source may not contain node_modules; the operator's ignore rules stay untouched.
    mkdirSync(join(root, ".git/info"), { recursive: true });
    appendFileSync(join(root, ".git/info/exclude"), "\nnode_modules/\n");
    command = [
      "bun",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--no-progress",
      "--backend=copyfile",
      `--config=${config}`,
      `--cache-dir=${join(control, "cache")}`,
      "--registry=https://registry.npmjs.org",
      "--network-concurrency=8",
    ];
    const result = await execute(command, {
      HOME: home,
      XDG_CONFIG_HOME: home,
      BUN_TMPDIR: control,
      BUN_INSTALL_CACHE_DIR: join(control, "cache"),
    });
    if (readInside(root, "bun.lock") !== lockText)
      throw new Error("Dependency preparation changed the captured lockfile.");
    return { result, policy: BUN_PREPARATION_POLICY, lockfileSha256 };
  } catch (error) {
    // A preparation refusal is failed evidence, never an empty successful check run.
    return {
      result: {
        command,
        exitCode: 1,
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        output: `Dependency preparation failed: ${getErrorMessage(error)}`,
      },
      policy: BUN_PREPARATION_POLICY,
      lockfileSha256,
    };
  } finally {
    if (control) rmSync(control, { recursive: true, force: true });
  }
}
