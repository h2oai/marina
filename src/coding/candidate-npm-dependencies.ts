// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getErrorMessage } from "../engine/errors";
import {
  type CandidatePreparation,
  dependencyObject,
  readDependencyFile,
  rejectCapturedDependencies,
  validateDependencyManifest,
} from "./candidate-dependencies";
import type { WorkspaceRunResult } from "./local-workspace";

export const NPM_PREPARATION_POLICY = "npm-frozen-public-no-scripts-v1";

/** Disposable snapshots only. No inherited credentials, project config, lifecycle scripts,
 * mutable resolution, local links or non-public registries. Unsupported locks stay unverified. */
export async function prepareCandidateNpmDependencies(
  root: string,
  execute: (command: string[], environment: Record<string, string>) => Promise<WorkspaceRunResult>,
): Promise<CandidatePreparation> {
  const started = Date.now();
  let control: string | undefined;
  let lockfileSha256: string | undefined;
  let command = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    rejectCapturedDependencies(root);
    if (existsSync(join(root, ".npmrc")) || existsSync(join(root, "npm-shrinkwrap.json")))
      throw new Error(
        "Snapshot npm preparation refuses project npm config and shrinkwrap overrides.",
      );
    const manifestText = readDependencyFile(root, "package.json");
    const manifest = dependencyObject(JSON.parse(manifestText));
    if (validateDependencyManifest(manifest).length || manifest.workspaces !== undefined)
      throw new Error("Snapshot npm preparation does not support workspace links.");
    const lockText = readDependencyFile(root, "package-lock.json");
    lockfileSha256 = createHash("sha256").update(lockText).digest("hex");
    const lock = dependencyObject(JSON.parse(lockText));
    if (lock.lockfileVersion !== 3)
      throw new Error("Snapshot npm preparation requires a version 3 package-lock.json.");
    const packages = dependencyObject(lock.packages);
    if (!Object.hasOwn(packages, "")) throw new Error("Npm lockfile is missing its root package.");
    for (const [path, value] of Object.entries(packages)) {
      const pkg = dependencyObject(value);
      validateDependencyManifest(pkg);
      if (!path) continue;
      if (
        !/^(?:node_modules\/(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)(?:\/node_modules\/(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)*$/.test(
          path,
        ) ||
        path.split("/").some((part) => part === "." || part === "..") ||
        pkg.link ||
        pkg.inBundle ||
        typeof pkg.resolved !== "string" ||
        typeof pkg.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity)
      )
        throw new Error("Npm preparation requires integrity-locked public packages without links.");
      const url = new URL(pkg.resolved);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "registry.npmjs.org" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Npm preparation only accepts the public npm registry.");
    }
    control = mkdtempSync(join(tmpdir(), "marina-npm-deps-"));
    const privateHome = join(control, "home");
    mkdirSync(privateHome);
    const userConfig = join(control, "user.npmrc");
    const globalConfig = join(control, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    mkdirSync(join(root, ".git/info"), { recursive: true });
    appendFileSync(join(root, ".git/info/exclude"), "\nnode_modules/\n");
    command = [
      ...command,
      "--include=dev",
      "--registry=https://registry.npmjs.org",
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
      `--cache=${join(control, "cache")}`,
    ];
    const result = await execute(command, { HOME: privateHome, XDG_CONFIG_HOME: privateHome });
    if (
      readDependencyFile(root, "package-lock.json") !== lockText ||
      readDependencyFile(root, "package.json") !== manifestText
    )
      throw new Error("Npm preparation changed the captured dependency manifests.");
    return { result, policy: NPM_PREPARATION_POLICY, lockfileSha256 };
  } catch (error) {
    return {
      result: {
        command,
        exitCode: 1,
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        output: `Dependency preparation failed: ${getErrorMessage(error)}`,
      },
      policy: NPM_PREPARATION_POLICY,
      lockfileSha256,
    };
  } finally {
    if (control) rmSync(control, { recursive: true, force: true });
  }
}
