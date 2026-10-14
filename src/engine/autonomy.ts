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
 * - `guarded` (default) — gates behave as designed: a supervised attempt is
 *   held as a challenge and runs once a person approves it; approvals from
 *   outside the requester's lineage are the demonstrations that make the gate
 *   its own (src/engine/safety-gates.ts), or an operator grants it.
 * - `earned` — `guarded` plus optimistic supervision for the earnable gates:
 *   an entity whose standing clears a gate's floor RUNS the supervised
 *   operation at once; the run is recorded as a pending demonstration that
 *   counts only once an operator attests it (`witness attest`). Practice is
 *   free; capability is confirmed by review. The core below gets NO
 *   optimistic mode — it stays operator-grant (a held run, approved once).
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
  // Room and command code runs inside the engine (a static denylist, not a
  // process boundary), so authoring it stays gated even under `open`.
  "world.code",
]);

export function getAutonomyPosture(env: NodeJS.ProcessEnv = process.env): AutonomyPosture {
  const raw = (env.MARINA_AUTONOMY ?? "").trim().toLowerCase();
  if (raw === "earned" || raw === "open") return raw;
  return "guarded";
}

/**
 * The posture line when gates are off (`isLocalUngated()`): no posture is in
 * force, so name the state and the switch that turns enforcement on.
 */
export function ungatedPostureNote(): string {
  return "gates off for this local operator (audit stays on); set MARINA_AUTONOMY=guarded to enforce them";
}

/** One-line posture description for the boot banner / readiness / prompts. */
export function describeAutonomyPosture(posture: AutonomyPosture = getAutonomyPosture()): string {
  switch (posture) {
    case "open":
      return "OPEN — standing is descriptive; every gate auto-passes (incl. allowlisted code.exec) except the core (keys, world erasure, shell, unrestricted exec)";
    case "earned":
      return "EARNED — supervised operations on earnable gates run freely; capability flips when an operator attests the recorded runs or approves held ones; the core stays operator-grant";
    default:
      return "GUARDED — supervised operations are held until a person approves them; approved runs (or an operator grant) make a gate solo; the core stays operator-grant";
  }
}
