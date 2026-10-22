#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run setup:cli` — put `marina` on your PATH, so it works from any folder.
 *
 * Links `<bin>/marina` to this checkout's `scripts/marina.ts` (which finds its
 * own repository through the link). `<bin>` is the first of Bun's global bin
 * folder (`$BUN_INSTALL/bin`, default `~/.bun/bin`) and `~/.local/bin` that is
 * already on PATH, so most installs need no PATH change; with neither on PATH
 * it is Bun's. Nothing edits a shell profile. An existing
 * `marina` that points elsewhere is left alone unless `--force`. Prints
 * whether the folder is on PATH, and the exact line to add when it is not —
 * in the syntax of the user's shell (`$SHELL`: fish gets `fish_add_path`).
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export function cliBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.BUN_INSTALL?.trim() || join(homedir(), ".bun"), "bin");
}

/** The folder `marina` is linked into: the first candidate already on PATH, else Bun's. */
export function linkDir(env: NodeJS.ProcessEnv = process.env): string {
  const bun = cliBinDir(env);
  const onPath = new Set(
    (env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((p) => resolve(p)),
  );
  const local = join(env.HOME?.trim() || homedir(), ".local", "bin");
  return [bun, local].find((dir) => onPath.has(resolve(dir))) ?? bun;
}

export interface SetupResult {
  link: string;
  target: string;
  status: "linked" | "already-linked" | "occupied";
  onPath: boolean;
}

export function setupCli(opts: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): SetupResult {
  const env = opts.env ?? process.env;
  const target = resolve(import.meta.dir, "marina.ts");
  // The shebang only runs when the file is executable.
  chmodSync(target, 0o755);
  const bin = linkDir(env);
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "marina");
  const onPath = (env.PATH ?? "").split(delimiter).some((p) => resolve(p) === resolve(bin));
  let status: SetupResult["status"] = "linked";
  if (existsSync(link) || isLink(link)) {
    const current = isLink(link) ? resolve(bin, readlinkSync(link)) : undefined;
    if (current === target) status = "already-linked";
    else if (!opts.force) return { link, target, status: "occupied", onPath };
    else rmSync(link, { force: true });
  }
  if (status === "linked") symlinkSync(target, link);
  return { link, target, status, onPath };
}

/** The instruction that puts `bin` on PATH, in the syntax of the user's shell. */
export function pathHint(bin: string, env: NodeJS.ProcessEnv = process.env): string {
  const shell = basename(env.SHELL?.trim() ?? "");
  if (shell === "fish") return `run this once (it persists):\n  fish_add_path ${bin}\n`;
  const profile =
    shell === "zsh" ? "~/.zshrc" : shell === "bash" ? "~/.bashrc" : "your shell profile";
  return `add this to ${profile}:\n  export PATH="${bin}:$PATH"\n`;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const r = setupCli({ force: process.argv.includes("--force") });
  if (r.status === "occupied") {
    console.error(
      `${r.link} already exists and is not this Marina. Remove it, or rerun with --force to replace it.`,
    );
    process.exit(1);
  }
  const bin = dirname(r.link);
  process.stdout.write(
    r.onPath
      ? `marina is on your PATH (${r.link} → ${r.target}). Try: marina version\n`
      : `Linked ${r.link} → ${r.target}.\n${bin} is not on your PATH; ${pathHint(bin)}`,
  );
}
