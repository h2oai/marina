// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function allowedDirectory(root: string, directory = ".") {
  const base = await realpath(root);
  const target = await realpath(resolve(base, directory));
  const part = relative(base, target);
  if (part === ".." || part.startsWith("../") || isAbsolute(part))
    throw new Error("Directory is outside this supervisor's configured root");
  return target;
}
export async function prepareAgentWorkspace(
  root: string,
  directory: string | undefined,
  mode: "worktree" | "shared",
  stateDirectory: string,
  id: string,
): Promise<{ cwd: string; dirty: boolean }> {
  const source = await allowedDirectory(root, directory);
  if (mode === "shared") return { cwd: source, dirty: false };
  const git = (args: string[]) => exec("git", ["-C", source, ...args], { maxBuffer: 1_048_576 });
  const top = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
  // A nested configured root must not let a worktree expose a parent project.
  await allowedDirectory(root, top);
  const dirty = !!(await git(["status", "--porcelain"])).stdout;
  const parent = join(stateDirectory, "worktrees");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const destination = join(parent, id);
  await git(["worktree", "add", "--detach", destination, "HEAD"]);
  return { cwd: join(destination, relative(top, source)), dirty };
}
