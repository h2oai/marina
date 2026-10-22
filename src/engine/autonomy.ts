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
 * - `sovereign` — the all-gates-off switch for a sovereign, self-hosted
 *   Marina with no guests: every permission check is off in every profile,
 *   the core included (`isLocalUngated()` is true). The one posture that
 *   lifts the core, so it is never implied: only this exact value sets it.
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
 *    error (enforced in main.ts alongside the existing ingress gate);
 *    `sovereign` + a non-loopback bind is fatal unless
 *    MARINA_ALLOW_INSECURE_PUBLIC=true, signed in or not
 *    (`assertTrustProfileSafe`).
 * 3. The irreducible core stays gated under every posture but `sovereign` — no `open`
 *    auto-pass and no `earned` optimistic run: credential exfiltration
 *    (`key.manage`), world erasure (`admin.destructive`), raw shell
 *    (`shell.exec`) and arbitrary non-allowlisted host commands
 *    (`code.exec.unrestricted`, which also keeps its independent
 *    exec-approver chain) and real-money orders (`trading.live`). Allowlisted workspace execution (`code.exec`) is
 *    NOT in the core: `open` passes it.
 * 4. The implicit local profile (local, not `guarded`, not `sovereign`) lifts
 *    every gate for the loopback PERSON, but an AGENT's `shell.exec` and
 *    `code.exec.unrestricted` (`LOCAL_AGENT_HELD_GATES`) are held as a
 *    challenge a person approves. Only `sovereign` lifts them for agents.
 */

export type AutonomyPosture = "guarded" | "earned" | "open" | "sovereign";

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
  // Real-money prediction-market orders: each asks a person unless an
  // operator granted the gate (the local profile does not lift it either).
  "trading.live",
]);

/** Gates the IMPLICIT local profile still holds for AGENTS (never for the
 *  loopback person): host shell and arbitrary non-allowlisted host commands.
 *  A held run raises a challenge and runs once a person approves it; only
 *  `MARINA_AUTONOMY=sovereign` lifts it (`isImplicitLocalUngated`). */
export const LOCAL_AGENT_HELD_GATES: ReadonlySet<string> = new Set([
  "shell.exec",
  "code.exec.unrestricted",
]);

export function getAutonomyPosture(env: NodeJS.ProcessEnv = process.env): AutonomyPosture {
  const raw = (env.MARINA_AUTONOMY ?? "").trim().toLowerCase();
  if (raw === "earned" || raw === "open" || raw === "sovereign") return raw;
  return "guarded";
}

/**
 * The posture line when gates are off (`isLocalUngated()`): no posture is in
 * force, so name the state and the switch that turns enforcement on.
 */
export function ungatedPostureNote(env: NodeJS.ProcessEnv = process.env): string {
  if (getAutonomyPosture(env) === "sovereign")
    return "SOVEREIGN — every gate, rank floor and hold is off (audit stays on); unset MARINA_AUTONOMY to enforce them";
  return "gates off for this local operator (audit stays on); an agent's host shell and arbitrary host commands still wait for a person's approval; set MARINA_AUTONOMY=guarded to enforce every gate, sovereign to lift that hold";
}

/** One-line posture description for the boot banner / readiness / prompts. */
export function describeAutonomyPosture(posture: AutonomyPosture = getAutonomyPosture()): string {
  switch (posture) {
    case "sovereign":
      return "SOVEREIGN — every gate (core included), rank floor and hold is off for every principal; audit stays on";
    case "open":
      return "OPEN — standing is descriptive; every gate auto-passes (incl. allowlisted code.exec) except the core (keys, world erasure, shell, unrestricted exec, world code, live trading)";
    case "earned":
      return "EARNED — supervised operations on earnable gates run freely; capability flips when an operator attests the recorded runs or approves held ones; the core stays operator-grant";
    default:
      return "GUARDED — supervised operations are held until a person approves them; approved runs (or an operator grant) make a gate solo; the core stays operator-grant";
  }
}
