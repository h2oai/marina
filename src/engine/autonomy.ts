// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Autonomy posture — the operator's declaration of how much of the capability
 * ceiling is open to the agents of this world.
 *
 * Marina is trying to be a world agents would CHOOSE to inhabit. The posture
 * dial exists so a locked ceiling is always a deliberate operator decision,
 * never an accident of unfinished plumbing:
 *
 * - `guarded` (default) — gates behave as designed: supervised attempts run
 *   only inside a witness-granted supervision window, and unattended use is
 *   earned through witnessed demonstrations or operator grants.
 * - `earned` — optimistic supervision: an agent with sufficient standing may
 *   RUN a supervised operation unattended; the demonstration is recorded as
 *   pending, and the flip to unsupervised competence happens only when a
 *   qualified witness attests the recorded demonstration afterwards.
 *   Practice is free; capability is confirmed by review. The core below gets
 *   NO optimistic mode — it still needs a witness window (or a grant).
 * - `open` — the operator declares standing purely descriptive: every gate
 *   auto-passes EXCEPT the irreducible destructive core below. That includes
 *   `code.exec` — allowlisted, workspace-pinned host execution (`code run`,
 *   `code test`, `code apply` …) — which `open` passes by design. For radical,
 *   aggressive Marinas — by explicit operator declaration only.
 *
 * SECURITY INVARIANTS (do not weaken):
 * 1. Posture is read from the environment ONLY. There is deliberately no
 *    command, API route, or DB row that changes it — an agent must never be
 *    able to open its own cage.
 * 2. `open` + a non-loopback bind + passwordless login is a FATAL startup
 *    error (enforced in main.ts alongside the existing ingress gate).
 * 3. The irreducible core stays gated under every posture — no `open`
 *    auto-pass and no `earned` optimistic run: credential exfiltration
 *    (`key.manage`), world erasure (`admin.destructive`), raw shell
 *    (`shell.exec`) and arbitrary non-allowlisted host commands
 *    (`code.exec.unrestricted`, which also keeps its independent
 *    exec-approver chain). Allowlisted workspace execution (`code.exec`) is
 *    NOT in the core: `open` passes it.
 */

export type AutonomyPosture = "guarded" | "earned" | "open";

/** Gates that `open` posture never auto-grants — the "most destructive
 *  possible options". Everything else opens under `open`. */
export const OPEN_POSTURE_CORE: ReadonlySet<string> = new Set([
  "key.manage",
  "admin.destructive",
  "shell.exec",
  "code.exec.unrestricted",
]);

export function getAutonomyPosture(env: NodeJS.ProcessEnv = process.env): AutonomyPosture {
  const raw = (env.MARINA_AUTONOMY ?? "").trim().toLowerCase();
  if (raw === "earned" || raw === "open") return raw;
  return "guarded";
}

/** One-line posture description for the boot banner / readiness / prompts. */
export function describeAutonomyPosture(posture: AutonomyPosture = getAutonomyPosture()): string {
  switch (posture) {
    case "open":
      return "OPEN — standing is descriptive; every gate auto-passes (incl. allowlisted code.exec) except the core (keys, world erasure, shell, unrestricted exec)";
    case "earned":
      return "EARNED — supervised operations run freely; unattended capability flips when a qualified witness attests recorded demonstrations";
    default:
      return "GUARDED — supervised operations need a witness-granted window; unattended capability is earned through witnessed demonstrations or operator grants";
  }
}
