// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of Marina's own source that decide what Marina may do and how
 * it judges itself: gates, trust and authority, the as-of fence, the
 * promotion rule, the trial and ship steps themselves, the processes that
 * check a change (CI, package scripts) and configuration. A change an agent
 * ships that touches any of them is opened as a pull request but never
 * queued to merge by Marina; a person reads it and queues it. People shipping
 * their own change are not held. `MARINA_SELF_IMPROVE_PROTECTED=off` lifts
 * the hold (an operator's choice, like every restriction here).
 */
import type { GitRunner } from "./code-trial";

/** Path prefixes (directories end with `/`) and exact files, relative to the repository root. */
export const PROTECTED_PATHS: readonly string[] = [
  // Gates, authority and trust.
  "src/engine/safety-gates.ts",
  "src/engine/gate-context.ts",
  "src/engine/rank-floor.ts",
  "src/engine/challenges.ts",
  "src/engine/role-guard.ts",
  "src/engine/trust-profile.ts",
  "src/engine/evidence-fence.ts",
  "src/engine/command-phase-coordinator.ts",
  "src/engine/auth-coordinator.ts",
  "src/auth/",
  "src/net/auth-middleware.ts",
  "src/net/owner-authorization.ts",
  "src/net/url-guard.ts",
  "src/net/host-allowlist.ts",
  "src/net/bind-safety.ts",
  "src/coding/exec-approver.ts",
  "src/coding/host-git.ts",
  // How Marina judges a change.
  "src/engine/benchmark-promotion.ts",
  "src/engine/live-promotion.ts",
  "src/engine/fishing-margin.ts",
  "src/engine/default-resolution.ts",
  "src/stats/",
  "src/decisions/earned-judge.ts",
  // Improving its own code: these steps themselves.
  "src/coding/self-checkout.ts",
  "src/coding/code-trial.ts",
  "src/coding/code-ship.ts",
  "src/coding/protected-paths.ts",
  "src/world/child-marina.ts",
  // What checks a change, and how the server is configured.
  ".github/",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  ".bun-version",
  "config/",
  "Dockerfile",
  "docker-compose.yml",
];

export function isProtectedPath(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  return PROTECTED_PATHS.some((entry) => (entry.endsWith("/") ? p.startsWith(entry) : p === entry));
}

/** Files changed between two commits that are protected (renames count on both sides). */
export function protectedChanges(
  git: GitRunner,
  tree: string,
  base: string,
  head: string,
): string[] {
  const out = git(tree, ["diff", "--name-only", "--no-renames", base, head]);
  if (out.exitCode !== 0) throw new Error(`git diff failed: ${out.stderr.slice(-300)}`);
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isProtectedPath);
}

/** Whether an agent's protected change is held for a person (default yes). */
export function protectedHold(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_SELF_IMPROVE_PROTECTED?.trim().toLowerCase() !== "off";
}
