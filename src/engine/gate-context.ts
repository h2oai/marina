// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-command state shared by the router, `checkGateForExecution` and the
 * challenge service (src/engine/challenges.ts), kept dependency-free so
 * safety-gates.ts can read it without an import cycle.
 *
 * - The CURRENT command of an entity: set by the command phase for the length
 *   of one execution (one entity runs strictly FIFO, so there is at most one).
 *   A gate refusal inside that execution — router or imperative site — can
 *   then raise a challenge that re-dispatches exactly this input.
 * - COMMAND passes: an approved challenge leaves a single-use pass for the
 *   exact held input; the router claims it when that input is re-dispatched.
 * - ARMED gate passes: while a passed command runs, the approved gate ids are
 *   armed for that entity so the check inside the handler passes once, with
 *   the approver recorded as witness.
 */

export interface GatePass {
  /** Gate ids the approver authorized for this one run. */
  gateIds: string[];
  /** The command's rank floor is waived for this run. */
  rankWaived: boolean;
  /** Entity id of the approver, or undefined for the judge. */
  approverId?: string;
  approverName: string;
  token: string;
}

export type GateRefusalHook = (entityId: string, gateId: string, reason: string) => string;

const PASS_TTL_MS = 5 * 60_000;
const currentCommand = new Map<string, string>();
const commandPasses = new Map<string, { pass: GatePass; expiresAt: number }>();
const armed = new Map<string, GatePass>();
let refusalHook: GateRefusalHook | undefined;

const passKey = (entityId: string, raw: string) => `${entityId}\u0000${raw.trim()}`;

export function setCurrentCommand(entityId: string, raw: string | undefined): void {
  if (raw === undefined) currentCommand.delete(entityId);
  else currentCommand.set(entityId, raw);
}

export function getCurrentCommand(entityId: string): string | undefined {
  return currentCommand.get(entityId);
}

export function grantCommandPass(entityId: string, raw: string, pass: GatePass, now = Date.now()) {
  commandPasses.set(passKey(entityId, raw), { pass, expiresAt: now + PASS_TTL_MS });
}

/** Single use: returns and removes the pass for this exact input. */
export function claimCommandPass(
  entityId: string,
  raw: string,
  now = Date.now(),
): GatePass | undefined {
  const key = passKey(entityId, raw);
  const entry = commandPasses.get(key);
  if (!entry) return undefined;
  commandPasses.delete(key);
  return entry.expiresAt >= now ? entry.pass : undefined;
}

export function armGatePass(entityId: string, pass: GatePass | undefined): void {
  if (pass) armed.set(entityId, pass);
  else armed.delete(entityId);
}

/** Consumes the armed approval for one gate check inside the passed command. */
export function takeArmedGatePass(entityId: string, gateId: string): GatePass | undefined {
  const pass = armed.get(entityId);
  if (!pass?.gateIds.includes(gateId)) return undefined;
  pass.gateIds = pass.gateIds.filter((id) => id !== gateId);
  return pass;
}

export function setGateRefusalHook(hook: GateRefusalHook | undefined): void {
  refusalHook = hook;
}

/** Called by checkGateForExecution on refusal; returns the (possibly extended) reason. */
export function onGateRefused(entityId: string, gateId: string, reason: string): string {
  if (!refusalHook || !currentCommand.has(entityId)) return reason;
  try {
    return refusalHook(entityId, gateId, reason);
  } catch {
    // A failed challenge must never turn a refusal into a throw.
    return reason;
  }
}

/** Test seam. */
export function resetGateContextForTests(): void {
  currentCommand.clear();
  commandPasses.clear();
  armed.clear();
  refusalHook = undefined;
}
