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
 *
 * The current command and its armed pass are scoped to ONE execution through
 * `runCommandScope()` (an AsyncLocalStorage frame per command). A nested
 * command (macro expansion, `batch`) opens its own frame and the outer frame
 * is visible again when it returns; an interleaved execution of the same
 * entity never sees or clears another execution's pass. Outside any frame the
 * module-level maps are used (test seams and legacy callers).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CodingCommandTarget } from "../sdk/command-target";

export interface GatePass {
  codingTarget?: CodingCommandTarget;
  /** Gate ids the approver authorized for this one run. */
  gateIds: string[];
  /** The command's rank floor is waived for this run. */
  rankWaived: boolean;
  /** The highest rank floor the approval covers (the challenge's minRank). */
  waivedRank?: number;
  /** Entity id of the approver, or undefined for the judge. */
  approverId?: string;
  approverName: string;
  token: string;
}

export type GateRefusalHook = (entityId: string, gateId: string, reason: string) => string;

const PASS_TTL_MS = 5 * 60_000;
const currentCommand = new Map<string, string>();
const currentCodingTarget = new Map<string, CodingCommandTarget>();
const commandPasses = new Map<string, { pass: GatePass; expiresAt: number }>();
const armed = new Map<string, GatePass>();
let refusalHook: GateRefusalHook | undefined;

const passKey = (entityId: string, raw: string, target?: CodingCommandTarget) =>
  JSON.stringify([entityId, raw.trim(), target?.sessionId, target?.runId]);

interface CommandScope {
  entityId: string;
  raw?: string;
  pass?: GatePass;
  /** The request-local coding destination of this one execution. */
  codingTarget?: CodingCommandTarget;
  /** False once the execution returned: detached work it spawned sees nothing. */
  open: boolean;
  parent?: CommandScope;
}

const scopes = new AsyncLocalStorage<CommandScope>();

/** The innermost execution frame of this entity, if the caller runs inside one. */
function scopeFor(entityId: string): CommandScope | undefined {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.entityId === entityId) return scope;
  }
  return undefined;
}

/**
 * Run one command execution in its own frame. The frame starts with no
 * current command and no armed pass, and closes when `fn` settles.
 */
export function runCommandScope<T>(entityId: string, fn: () => Promise<T>): Promise<T> {
  const scope: CommandScope = { entityId, open: true, parent: scopes.getStore() };
  return scopes.run(scope, async () => {
    try {
      return await fn();
    } finally {
      scope.open = false;
      scope.raw = undefined;
      scope.pass = undefined;
      scope.codingTarget = undefined;
    }
  });
}

/**
 * The coding destination (session/run) of the execution running now. Scoped
 * like the current command: a nested frame starts without one and an
 * interleaved execution never sees another execution's target.
 */
export function setCurrentCodingTarget(entityId: string, target?: CodingCommandTarget): void {
  const scope = scopeFor(entityId);
  if (scope) {
    if (scope.open) scope.codingTarget = target;
    return;
  }
  if (target) currentCodingTarget.set(entityId, target);
  else currentCodingTarget.delete(entityId);
}

export function getCurrentCodingTarget(entityId: string): CodingCommandTarget | undefined {
  const scope = scopeFor(entityId);
  if (scope) return scope.open ? scope.codingTarget : undefined;
  return currentCodingTarget.get(entityId);
}

export function setCurrentCommand(entityId: string, raw: string | undefined): void {
  const scope = scopeFor(entityId);
  if (scope) {
    if (scope.open) scope.raw = raw;
    return;
  }
  if (raw === undefined) currentCommand.delete(entityId);
  else currentCommand.set(entityId, raw);
}

export function getCurrentCommand(entityId: string): string | undefined {
  const scope = scopeFor(entityId);
  if (scope) return scope.open ? scope.raw : undefined;
  return currentCommand.get(entityId);
}

function armedPass(entityId: string): GatePass | undefined {
  const scope = scopeFor(entityId);
  if (scope) return scope.open ? scope.pass : undefined;
  return armed.get(entityId);
}

export function grantCommandPass(entityId: string, raw: string, pass: GatePass, now = Date.now()) {
  commandPasses.set(passKey(entityId, raw, pass.codingTarget), {
    pass,
    expiresAt: now + PASS_TTL_MS,
  });
}

/** Single use: returns and removes the pass for this exact input. */
export function claimCommandPass(
  entityId: string,
  raw: string,
  now = Date.now(),
): GatePass | undefined {
  const key = passKey(entityId, raw, getCurrentCodingTarget(entityId));
  const entry = commandPasses.get(key);
  if (!entry) return undefined;
  commandPasses.delete(key);
  return entry.expiresAt >= now ? entry.pass : undefined;
}

export function armGatePass(entityId: string, pass: GatePass | undefined): void {
  const scope = scopeFor(entityId);
  if (scope) {
    if (scope.open) scope.pass = pass;
    return;
  }
  if (pass) armed.set(entityId, pass);
  else armed.delete(entityId);
}

/** Consumes the armed approval for one gate check inside the passed command. */
export function takeArmedGatePass(entityId: string, gateId: string): GatePass | undefined {
  const pass = armedPass(entityId);
  if (!pass?.gateIds.includes(gateId)) return undefined;
  pass.gateIds = pass.gateIds.filter((id) => id !== gateId);
  return pass;
}

/**
 * True when the command running now was approved past a rank floor of at
 * least `min` — an inline floor (src/engine/rank-floor.ts) honours the same
 * approval the router does, but never above the rank the approver vouched for.
 */
export function isRankWaivedForRun(entityId: string, min: number): boolean {
  const pass = armedPass(entityId);
  return !!pass?.rankWaived && (pass.waivedRank ?? 0) >= min;
}

export function setGateRefusalHook(hook: GateRefusalHook | undefined): void {
  refusalHook = hook;
}

/** Called by checkGateForExecution on refusal; returns the (possibly extended) reason. */
export function onGateRefused(entityId: string, gateId: string, reason: string): string {
  if (!refusalHook || getCurrentCommand(entityId) === undefined) return reason;
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
  currentCodingTarget.clear();
  commandPasses.clear();
  armed.clear();
  refusalHook = undefined;
}
