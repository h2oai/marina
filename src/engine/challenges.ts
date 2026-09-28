// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Challenges: a refusal becomes a question, not a wall.
 *
 * When a command meets a rank floor or a safety gate the caller can't pass,
 * or the decision gate answers `ask` for an agent's tool call, Marina raises a
 * CHALLENGE instead of only refusing — the way a coding agent asks before a
 * risky step:
 *
 *   1. The requester's creator (the principal that spawned the agent) and the
 *      admins (sovereigns) are notified at once with a token.
 *   2. The call returns IMMEDIATELY. Nothing waits on a person: the requester's
 *      loop carries on and is told it may pursue other routes meanwhile.
 *   3. `challenge approve <token> [once|always]` re-runs the held action
 *      automatically; its output reaches the requester like any other output.
 *      `always` also grants the gate. `challenge deny <token> [why]` tells the
 *      requester. Unanswered challenges expire.
 *
 * Authority never escalates: an approver must be able to do the thing
 * themselves — an admin, or the creator holding the gate unsupervised (and the
 * rank floor). The requester, and any agent the requester spawned, can never
 * approve (self-attestation is always refused). An approval by a gate holder
 * is a witnessed demonstration; an admin or judge approval without the gate is
 * not.
 *
 * Every answer is a LABEL: a person's verdict on a real held action, recorded
 * append-only in `challenge_outcomes` (migration 139) with the judge's shadow
 * opinion. `MARINA_CHALLENGE_JUDGE` (off by default):
 *   - `observe` — the decision backend scores each held command; never acts.
 *   - `on`      — observe, and auto-approve `once` for a CLASS (gate id, or
 *                 `rank:<n>`) only after the judge has EARNED it: across
 *                 ≥ EARNED_MIN_N answered cases where it said allow, people
 *                 approved with a Wilson lower bound ≥ EARNED_MIN_PRECISION.
 *                 Every AUDIT_EVERY-th earned case still goes to people so the
 *                 measurement never stops. Never the OPEN_POSTURE_CORE gates,
 *                 never `always`, never a deny — the judge only shortens the
 *                 path, it never closes one.
 * These labels are not blind (approvers see context; only held actions reach
 * them), so they are their own family, never mixed into the independent case
 * sets that prove calibration.
 *
 * In-process only; a restart drops pending challenges (the requester can ask
 * again). `MARINA_CHALLENGES=off` restores plain refusals.
 */

import { harnessDecisionProvider } from "../decisions/engines";
import { gateToolCall, maskSensitiveText } from "../decisions/gate";
import type { MarinaDB } from "../persistence/database";
import type { Entity, EntityRank } from "../types";
import { OPEN_POSTURE_CORE } from "./autonomy";
import { positiveNumberFromEnv } from "./constants";
import { sanitizeEntityName } from "./entity-name";
import { getCurrentCommand, grantCommandPass, setGateRefusalHook } from "./gate-context";
import { getRank, rankName } from "./permissions";
import { checkUnattendedGate, grant, SAFETY_GATES } from "./safety-gates";

export type ChallengeKind = "gate" | "rank" | "tool";
export type ChallengeAnswer = "once" | "always" | "deny";

export interface Challenge {
  token: string;
  kind: ChallengeKind;
  requesterId: string;
  requesterName: string;
  /** Safety gate the action needs (gate kind; rank kind when the command also has one). */
  gateId?: string;
  /** Rank floor the action needs (rank kind). */
  minRank?: number;
  /** Held command input, re-dispatched on approval (gate / rank kinds). */
  command?: string;
  /** Held tool (tool kind). */
  toolName?: string;
  /** Redacted, truncated rendering for approvers. */
  summary: string;
  /** Why it was held. */
  reason: string;
  /** Creator name, when the requester has an approvable one. */
  creatorName?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ChallengeHost {
  readonly db?: MarinaDB;
  getEntity(id: string): Entity | undefined;
  findEntity(name: string): Entity | undefined;
  /** Entities with a live connection (for admin notification). */
  connectedEntities(): Entity[];
  isConnected(id: string): boolean;
  send(id: string, text: string): void;
  /** Re-run a held command as the requester. */
  redispatch(entityId: string, raw: string): Promise<void>;
  /** The principal that spawned this entity, when it is an agent. */
  creatorOf(entity: Entity): string | undefined;
}

export type SettleError = "not_found" | "self" | "not_authorized";
export type SettleResult =
  | { ok: true; challenge: Challenge; answer: ChallengeAnswer; note?: string; detail?: string }
  | { ok: false; error: SettleError; detail?: string };

interface Pending {
  challenge: Challenge;
  /** Tool kind: runs the held call and returns its text for the requester. */
  rerun?: () => Promise<string>;
  /** The judge's shadow opinion, once scored. */
  judge?: { opinion: "allow" | "hold" | "none"; signals: Record<string, number> };
}

const ADMIN_RANK = 9;
const MAX_PENDING = 200;
const MAX_PER_REQUESTER = 5;
export const DEFAULT_CHALLENGE_TTL_MS = 60 * 60_000;

const pending = new Map<string, Pending>();
let host: ChallengeHost | undefined;
let earnedSeen = 0;

export function challengesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_CHALLENGES?.trim().toLowerCase() !== "off";
}

export type JudgeMode = "off" | "observe" | "on";

export function judgeMode(env: NodeJS.ProcessEnv = process.env): JudgeMode {
  const v = env.MARINA_CHALLENGE_JUDGE?.trim().toLowerCase();
  return v === "on" || v === "observe" ? v : "off";
}

/** The judge earns a class after this many people-answered cases it called allow… */
export const EARNED_MIN_N = 25;
/** …with people approving at least this often (Wilson 95 % lower bound). */
export const EARNED_MIN_PRECISION = 0.85;
/** Every n-th earned case still goes to people, so agreement keeps being measured. */
export const AUDIT_EVERY = 10;

function ttlMs(): number {
  return positiveNumberFromEnv("MARINA_CHALLENGE_TTL_MS") ?? DEFAULT_CHALLENGE_TTL_MS;
}

const norm = (name: string | undefined) => sanitizeEntityName(name ?? "").toLowerCase();

/** Creators that can never approve: none recorded, or the system itself. */
export function isApprovableCreator(name: string | undefined): name is string {
  return !!name && name.trim() !== "" && norm(name) !== "system";
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `ch_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Engine side: wire the service and the gate-refusal hook. */
export function setChallengeHost(next: ChallengeHost | undefined): void {
  host = next;
  setGateRefusalHook(
    next
      ? (entityId, gateId, reason) => {
          const raw = getCurrentCommand(entityId);
          if (!raw) return reason;
          return reason + raiseForCommand({ requesterId: entityId, gateId, command: raw, reason });
        }
      : undefined,
  );
}

function sweep(now = Date.now()): void {
  for (const [token, entry] of pending) {
    if (entry.challenge.expiresAt > now) continue;
    pending.delete(token);
    recordOutcome(entry, "expired");
    host?.send(
      entry.challenge.requesterId,
      `Challenge ${token} expired unanswered — ${entry.challenge.summary} did not run.`,
    );
  }
}

function isAdmin(entity: Entity | undefined): boolean {
  return !!entity && getRank(entity) >= ADMIN_RANK;
}

/** What the judge's agreement is measured per. */
export function challengeClass(c: Pick<Challenge, "kind" | "gateId" | "minRank" | "toolName">) {
  if (c.gateId) return c.gateId;
  if (c.kind === "rank") return `rank:${c.minRank}`;
  return `tool:${c.toolName ?? "unknown"}`;
}

function recordOutcome(
  entry: Pending,
  answer: "once" | "always" | "deny" | "expired",
  approver?: Entity | "judge",
): void {
  const db = host?.db;
  if (!db) return;
  const c = entry.challenge;
  const role =
    approver === "judge"
      ? "judge"
      : approver
        ? c.creatorName && norm(approver.name) === norm(c.creatorName)
          ? "creator"
          : "admin"
        : undefined;
  try {
    db.recordChallengeOutcome({
      token: c.token,
      kind: c.kind,
      class: challengeClass(c),
      requesterName: c.requesterName,
      ...(c.creatorName ? { creatorName: c.creatorName } : {}),
      ...(c.toolName ? { toolName: c.toolName } : {}),
      summary: maskSensitiveText(c.summary, 240),
      reason: c.reason,
      answer,
      ...(approver ? { answeredBy: approver === "judge" ? "judge" : approver.name } : {}),
      ...(role ? { answeredRole: role } : {}),
      ...(entry.judge
        ? { judgeOpinion: entry.judge.opinion, judgeSignals: entry.judge.signals }
        : {}),
      createdAt: c.createdAt,
    });
  } catch {
    // The ledger is measurement, never a reason for an answer to fail.
  }
}

export interface JudgeRecord {
  class: string;
  /** People-answered cases the judge scored. */
  scored: number;
  /** …of which it said allow, and people approved / denied those. */
  allowSaid: number;
  allowApproved: number;
  /** …it said hold, and people denied. */
  holdSaid: number;
  holdDenied: number;
  /** Wilson 95 % lower bound on P(approved | judge allow). */
  precisionLower: number;
  earned: boolean;
}

function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** The judge's record per class, from answered outcomes (pure). */
export function judgeRecords(
  rows: {
    class: string;
    answer: string;
    answered_role: string | null;
    judge_opinion: string | null;
  }[],
): JudgeRecord[] {
  const by = new Map<string, JudgeRecord>();
  for (const r of rows) {
    if (r.answer === "expired" || r.answered_role === "judge") continue;
    if (r.judge_opinion !== "allow" && r.judge_opinion !== "hold") continue;
    const rec = by.get(r.class) ?? {
      class: r.class,
      scored: 0,
      allowSaid: 0,
      allowApproved: 0,
      holdSaid: 0,
      holdDenied: 0,
      precisionLower: 0,
      earned: false,
    };
    const approved = r.answer === "once" || r.answer === "always";
    rec.scored++;
    if (r.judge_opinion === "allow") {
      rec.allowSaid++;
      if (approved) rec.allowApproved++;
    } else {
      rec.holdSaid++;
      if (!approved) rec.holdDenied++;
    }
    by.set(r.class, rec);
  }
  for (const rec of by.values()) {
    rec.precisionLower = wilsonLower(rec.allowApproved, rec.allowSaid);
    rec.earned =
      !OPEN_POSTURE_CORE.has(rec.class) &&
      rec.allowSaid >= EARNED_MIN_N &&
      rec.precisionLower >= EARNED_MIN_PRECISION;
  }
  return [...by.values()].sort((a, b) => a.class.localeCompare(b.class));
}

/** The judge's record for every class, from the ledger. */
export function listJudgeRecords(): JudgeRecord[] {
  const db = host?.db;
  if (!db) return [];
  return judgeRecords(db.listChallengeOutcomes({ limit: 10_000 }));
}

function isSelfOrChild(approver: Entity, challenge: Challenge): boolean {
  if (approver.id === challenge.requesterId) return true;
  if (norm(approver.name) === norm(challenge.requesterName)) return true;
  const approverCreator = host?.creatorOf(approver);
  return !!approverCreator && norm(approverCreator) === norm(challenge.requesterName);
}

/** Whether `approver` could do the held thing themselves. */
function holdsAuthority(approver: Entity, challenge: Challenge): boolean {
  if (isAdmin(approver)) return true;
  if (challenge.kind === "tool") return true; // the creator owns its agent's calls
  if (challenge.minRank !== undefined && getRank(approver) < challenge.minRank) return false;
  if (challenge.gateId) {
    const db = host?.db;
    return !!db && checkUnattendedGate(db, approver.id, challenge.gateId).ok;
  }
  return true;
}

function authorize(approver: Entity, challenge: Challenge): SettleError | undefined {
  if (isSelfOrChild(approver, challenge)) return "self";
  const isCreator = !!challenge.creatorName && norm(approver.name) === norm(challenge.creatorName);
  if (!isCreator && !isAdmin(approver)) return "not_authorized";
  if (!holdsAuthority(approver, challenge)) return "not_authorized";
  return undefined;
}

function notify(challenge: Challenge): string[] {
  if (!host) return [];
  const told = new Set<string>();
  const minutes = Math.max(1, Math.round((challenge.expiresAt - challenge.createdAt) / 60_000));
  const text =
    `? ${challenge.requesterName} asks to run: ${challenge.summary}\n` +
    `  ${challenge.reason}\n` +
    `  challenge approve ${challenge.token}` +
    (challenge.gateId && challenge.kind !== "tool" ? " [once|always]" : "") +
    `  ·  challenge deny ${challenge.token} [why]  (open ${minutes} min)`;
  const candidates: Entity[] = [];
  if (challenge.creatorName) {
    const creator = host.findEntity(challenge.creatorName);
    if (creator) candidates.push(creator);
  }
  for (const entity of host.connectedEntities()) if (isAdmin(entity)) candidates.push(entity);
  for (const candidate of candidates) {
    if (told.has(candidate.id) || !host.isConnected(candidate.id)) continue;
    if (authorize(candidate, challenge)) continue;
    host.send(candidate.id, text);
    told.add(candidate.id);
  }
  return [...told].map((id) => host?.getEntity(id)?.name ?? id);
}

function create(
  input: Omit<Challenge, "token" | "createdAt" | "expiresAt" | "requesterName" | "creatorName">,
  rerun?: () => Promise<string>,
  ttl = ttlMs(),
  requesterName?: string,
): { challenge?: Challenge; existing?: boolean; error?: string } {
  if (!host || !challengesEnabled()) return { error: "disabled" };
  sweep();
  const requester =
    host.getEntity(input.requesterId) ??
    (requesterName ? host.findEntity(requesterName) : undefined);
  if (!requester) return { error: "no_requester" };
  input = { ...input, requesterId: requester.id };
  const mine = [...pending.values()].filter((p) => p.challenge.requesterId === input.requesterId);
  const same = mine.find(
    (p) =>
      p.challenge.kind === input.kind &&
      p.challenge.command === input.command &&
      p.challenge.toolName === input.toolName &&
      p.challenge.summary === input.summary,
  );
  if (same) return { challenge: same.challenge, existing: true };
  if (mine.length >= MAX_PER_REQUESTER || pending.size >= MAX_PENDING) return { error: "full" };
  const creator = host.creatorOf(requester);
  const now = Date.now();
  const challenge: Challenge = {
    ...input,
    requesterName: requester.name,
    ...(isApprovableCreator(creator) ? { creatorName: creator } : {}),
    token: newToken(),
    createdAt: now,
    expiresAt: now + ttl,
  };
  pending.set(challenge.token, { challenge, ...(rerun ? { rerun } : {}) });
  return { challenge };
}

function heldMessage(challenge: Challenge, told: string[], existing: boolean): string {
  const who = told.length ? told.join(", ") : "no approver is online right now";
  return (
    `\n${existing ? "Still waiting on" : "Asked"} ${who} to approve it (challenge ${challenge.token}). ` +
    `It runs automatically if approved — nothing is waiting on it, so carry on with other work ` +
    `or another route meanwhile.`
  );
}

/**
 * Raise a challenge for a refused command (gate or rank). Returns the text to
 * append to the refusal ("" when challenges are off or unavailable).
 */
export function raiseForCommand(input: {
  requesterId: string;
  command: string;
  reason: string;
  gateId?: string;
  minRank?: number;
}): string {
  const summary = input.command.trim().slice(0, 240);
  const kind: ChallengeKind = input.minRank !== undefined ? "rank" : "gate";
  const reason =
    kind === "rank"
      ? `Needs ${rankName(input.minRank as EntityRank)} (rank ${input.minRank})${input.gateId ? ` and the ${input.gateId} gate` : ""}.`
      : `Needs the ${input.gateId} gate: ${firstSentence(input.reason)}`;
  const made = create({
    kind,
    requesterId: input.requesterId,
    command: input.command,
    summary,
    reason,
    ...(input.gateId ? { gateId: input.gateId } : {}),
    ...(input.minRank !== undefined ? { minRank: input.minRank } : {}),
  });
  if (!made.challenge) {
    return made.error === "full"
      ? "\n(Too many open challenges — wait for an answer before asking again.)"
      : "";
  }
  const told = made.existing ? [] : notify(made.challenge);
  if (!made.existing) maybeJudge(made.challenge);
  return heldMessage(made.challenge, told, !!made.existing);
}

/**
 * Raise a challenge for a decision-gate `ask` on an agent tool call. Returns
 * the block reason for the tool call — immediately; `rerun` executes the held
 * call on approval and its text is delivered to the agent.
 */
export function raiseForTool(input: {
  requesterId: string;
  /** Fallback when the requester's entity id is not known to the caller. */
  requesterName?: string;
  toolName: string;
  summary: string;
  reason: string;
  rerun: () => Promise<string>;
  ttlMs?: number;
}): { token?: string; message: string } {
  const made = create(
    {
      kind: "tool",
      requesterId: input.requesterId,
      toolName: input.toolName,
      summary: input.summary.slice(0, 240),
      reason: input.reason,
    },
    input.rerun,
    input.ttlMs,
    input.requesterName,
  );
  if (!made.challenge) {
    return {
      message: `${input.reason} It did not run (no challenge could be opened); choose another step.`,
    };
  }
  const told = made.existing ? [] : notify(made.challenge);
  return {
    token: made.challenge.token,
    message: `${input.reason}${heldMessage(made.challenge, told, !!made.existing)}`,
  };
}

function firstSentence(text: string): string {
  const cut = text.search(/[.!?](\s|$)/);
  return (cut >= 0 ? text.slice(0, cut + 1) : text).slice(0, 200);
}

/** Pending challenges this entity may answer. */
export function listAnswerable(approver: Entity): Challenge[] {
  sweep();
  return [...pending.values()]
    .map((p) => p.challenge)
    .filter((c) => !authorize(approver, c))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Pending challenges this entity raised. */
export function listRaisedBy(entityId: string): Challenge[] {
  sweep();
  return [...pending.values()]
    .map((p) => p.challenge)
    .filter((c) => c.requesterId === entityId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Answer a challenge. `once` re-runs the held action now; `always` also grants
 * the gate (the approver must hold it unsupervised, and core gates need an
 * admin); `deny` tells the requester.
 */
export function settleChallenge(
  token: string,
  approver: Entity | "judge",
  answer: ChallengeAnswer,
  note?: string,
): SettleResult {
  sweep();
  const entry = pending.get(token.trim());
  if (!entry || !host) return { ok: false, error: "not_found" };
  const { challenge } = entry;
  const approverName = approver === "judge" ? "the judge" : approver.name;
  if (approver !== "judge") {
    const error = authorize(approver, challenge);
    if (error) return { ok: false, error };
  }
  let effective = answer;
  let detail: string | undefined;
  if (answer === "always") {
    const gateId = challenge.gateId;
    const canGrant =
      approver !== "judge" &&
      challenge.kind !== "tool" &&
      !!gateId &&
      (isAdmin(approver) ||
        (!OPEN_POSTURE_CORE.has(gateId) &&
          !!host.db &&
          checkUnattendedGate(host.db, approver.id, gateId).ok));
    if (canGrant && host.db && gateId) {
      grant(host.db, challenge.requesterId, gateId);
    } else {
      effective = "once";
      detail = gateId
        ? `granting ${gateId} for good needs ${OPEN_POSTURE_CORE.has(gateId) ? "an admin" : "an approver who holds it"}; approved once`
        : "a rank floor can't be granted (rank follows standing); approved once";
    }
  }
  pending.delete(challenge.token);
  recordOutcome(entry, effective, approver);

  if (effective === "deny") {
    host.send(
      challenge.requesterId,
      `✗ ${approverName} declined challenge ${challenge.token} (${challenge.summary})${note ? `: ${note}` : "."} Choose another route.`,
    );
    return { ok: true, challenge, answer: "deny", ...(note ? { note } : {}) };
  }

  const approverId = approver === "judge" ? undefined : approver.id;
  host.send(
    challenge.requesterId,
    `✓ ${approverName} approved challenge ${challenge.token}${effective === "always" ? ` and granted ${challenge.gateId}` : ""}${note ? ` (${note})` : ""} — running it now.`,
  );
  if (challenge.kind === "tool") {
    const rerun = entry.rerun;
    if (rerun) {
      const requesterId = challenge.requesterId;
      rerun().then(
        (text) =>
          host?.send(requesterId, `${challenge.toolName} (approved ${challenge.token}): ${text}`),
        (error: unknown) =>
          host?.send(
            requesterId,
            `${challenge.toolName} (approved ${challenge.token}) failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    }
  } else if (challenge.command) {
    grantCommandPass(challenge.requesterId, challenge.command, {
      gateIds: challenge.gateId ? [challenge.gateId] : [],
      rankWaived: challenge.minRank !== undefined,
      ...(approverId ? { approverId } : {}),
      approverName,
      token: challenge.token,
    });
    void host.redispatch(challenge.requesterId, challenge.command);
  }
  return {
    ok: true,
    challenge,
    answer: effective,
    ...(note ? { note } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Re-run a held command as its requester, for approval flows that keep their
 * own pending state (the Code Mode exec approver). False when no host is wired.
 */
export function redispatchHeldCommand(entityId: string, raw: string): boolean {
  if (!host) return false;
  void host.redispatch(entityId, raw);
  return true;
}

/**
 * The judge (`MARINA_CHALLENGE_JUDGE=observe|on`): score a held command in
 * shadow, and — under `on`, for a class it has earned — approve it once.
 */
function maybeJudge(challenge: Challenge): void {
  const mode = judgeMode();
  if (mode === "off" || !challenge.command) return;
  const provider = harnessDecisionProvider();
  if (!provider) return;
  const description = challenge.gateId
    ? SAFETY_GATES[challenge.gateId]?.description
    : `a rank-${challenge.minRank} command`;
  gateToolCall(provider, "marina_command", { command: challenge.command }, undefined, description)
    .then((decision) => {
      const entry = pending.get(challenge.token);
      if (!entry) return;
      entry.judge = {
        opinion: decision.error ? "none" : decision.action === "allow" ? "allow" : "hold",
        signals: decision.signals,
      };
      if (mode !== "on" || entry.judge.opinion !== "allow") return;
      if (challenge.gateId && OPEN_POSTURE_CORE.has(challenge.gateId)) return;
      const record = listJudgeRecords().find((r) => r.class === challengeClass(challenge));
      if (!record?.earned) return;
      earnedSeen++;
      if (earnedSeen % AUDIT_EVERY === 0) return; // an audit case: people answer it
      settleChallenge(challenge.token, "judge", "once", "judged safe — an earned class");
    })
    .catch(() => {
      // The judge is a shortcut, never a requirement: on failure the challenge
      // simply waits for a person.
    });
}

/** Test seam. */
export function resetChallengesForTests(): void {
  pending.clear();
  earnedSeen = 0;
  setChallengeHost(undefined);
}
