// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { LocalWorkspace, type WorkspaceRuntime } from "./local-workspace";

export interface WorkspaceChoice {
  label: string;
  root: string;
}

export class WorkspaceRegistry {
  readonly roots: string[];
  readonly defaultRoot: string;
  readonly usesCwdFallback: boolean;

  constructor(opts: { defaultRoot?: string; roots?: string[]; usesCwdFallback?: boolean } = {}) {
    // SECURITY (Finding 2): when no code root is configured, process.cwd() is
    // Marina's OWN source tree. We keep it here only as a READ-ONLY display /
    // resolution fallback so `code doctor`, `code status`, and inspect verbs
    // still work with zero config — but `usesCwdFallback` is latched true and
    // `hostExecAllowed` returns false, so every host mutation/execution path
    // (write/edit/apply/run/patch/build/…) is refused upstream. The cwd is
    // NEVER a writable/executable default; that is the vulnerability this closes.
    const rawRoots = opts.roots && opts.roots.length > 0 ? opts.roots : [process.cwd()];
    this.roots = unique(rawRoots.map((root) => canonicalDirectory(root)));
    this.usesCwdFallback = opts.usesCwdFallback ?? (!opts.roots || opts.roots.length === 0);
    const requestedDefault = opts.defaultRoot
      ? canonicalDirectory(opts.defaultRoot)
      : (this.roots[0] ?? canonicalDirectory(process.cwd()));
    if (!this.isAllowedRoot(requestedDefault)) {
      throw new Error(`Default code workspace is outside allowed roots: ${requestedDefault}`);
    }
    this.defaultRoot = requestedDefault;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceRegistry {
    const roots = splitEnvList(env.MARINA_CODE_ROOTS);
    return new WorkspaceRegistry({
      defaultRoot: env.MARINA_CODE_DEFAULT_ROOT,
      roots: roots.length > 0 ? roots : undefined,
      usesCwdFallback: roots.length === 0 && !env.MARINA_CODE_DEFAULT_ROOT,
    });
  }

  /**
   * True only when at least one code root was explicitly configured
   * (MARINA_CODE_ROOTS / MARINA_CODE_DEFAULT_ROOT). Host mutation/execution
   * must be refused when this is false — the process.cwd() fallback is a
   * read-only display root, never a writable/executable one.
   */
  get hostExecAllowed(): boolean {
    return !this.usesCwdFallback;
  }

  defaultWorkspace(): WorkspaceRuntime {
    return new LocalWorkspace(this.defaultRoot);
  }

  workspaceForRoot(root: string): WorkspaceRuntime {
    return new LocalWorkspace(this.resolveRoot(root).root);
  }

  resolveRoot(input: string): WorkspaceChoice {
    const raw = input.trim();
    if (!raw) return { root: this.defaultRoot, label: basename(this.defaultRoot) };

    const candidates = isAbsolute(raw)
      ? [raw]
      : this.roots.flatMap((root) => [resolve(root, raw), resolve(root, "..", raw)]);
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const resolved = canonicalDirectory(candidate);
      if (this.isAllowedRoot(resolved)) {
        return { root: resolved, label: basename(resolved) };
      }
    }

    const attempted = candidates[0] ?? raw;
    const resolved = existsSync(attempted) ? canonicalDirectory(attempted) : resolve(attempted);
    if (!this.isAllowedRoot(resolved)) {
      throw new Error(`Workspace is outside allowed roots: ${raw}`);
    }
    throw new Error(`Workspace directory not found: ${raw}`);
  }

  listChoices(): WorkspaceChoice[] {
    return this.roots.map((root) => ({ root, label: basename(root) || root }));
  }

  private isAllowedRoot(path: string): boolean {
    return this.roots.some((root) => path === root || path.startsWith(`${root}/`));
  }
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Ensure operator-configured code roots exist and are git working trees, to be
 * called once at boot. Two reasons this can't be left to the Dockerfile:
 *   - The registry canonicalizes each root with realpathSync, which THROWS if
 *     the directory doesn't exist — so a configured-but-missing root breaks the
 *     first `code` command.
 *   - A `mkdir` baked into the image is shadowed by the /app/data bind mount at
 *     runtime, so the directory must be created after the volume is mounted.
 * git init makes checkpoint/revert/diff (which shell out to git) work; without
 * a repo those report "unavailable". No-op when no roots are configured, so the
 * cwd-fallback path is unchanged. Best-effort: problems are returned as
 * warnings for the caller to log, never thrown — boot must not fail on this.
 */
export function ensureConfiguredRoots(env: NodeJS.ProcessEnv = process.env): {
  ensured: string[];
  warnings: string[];
} {
  const configured = splitEnvList(env.MARINA_CODE_ROOTS);
  if (env.MARINA_CODE_DEFAULT_ROOT) configured.push(env.MARINA_CODE_DEFAULT_ROOT.trim());
  const ensured: string[] = [];
  const warnings: string[] = [];
  for (const root of unique(configured.filter(Boolean))) {
    try {
      mkdirSync(root, { recursive: true });
      if (!existsSync(join(root, ".git"))) {
        const res = Bun.spawnSync(["git", "init", "-q"], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (res.exitCode !== 0) {
          warnings.push(
            `git init failed for ${root}: ${new TextDecoder().decode(res.stderr).trim()}`,
          );
          continue;
        }
      }
      ensured.push(root);
    } catch (err) {
      warnings.push(
        `could not prepare code root ${root}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { ensured, warnings };
}

function canonicalDirectory(path: string): string {
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Code workspace root is not a directory: ${path}`);
  }
  return resolved;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
