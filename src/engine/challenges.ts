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
 *   1. The people who may answer — the requester's owner (the PERSON at the
 *      root of its spawn chain) and the operators — are notified at once with
 *      a token, and the hold lands in the durable `ops inbox`.
 *   2. The call returns IMMEDIATELY. Nothing waits on a person: the requester's
 *      loop carries on and is told it may pursue other routes meanwhile.
 *   3. `challenge approve <token> [once|always]` re-runs the held action
 *      automatically in the requester's own slot; its output reaches the
 *      requester like any other output. `always` also grants the gate.
 *      `challenge deny <token> [why]` tells the requester. Unanswered
 *      challenges expire on a timer, and the requester is told.
 *
 * PEOPLE APPROVE (2026-10-14). Who may answer is decided by principal KIND,
 * not rank: an agent never answers another participant's hold — not even a
 * resident whose stored rank is 9. A participant is an agent when its
 * connection is internal (room/crew/runtime agents), arrives over MCP, or
 * declared itself one (SDK `principal: "agent"`, the default for
 * `MarinaClient`), or when its account has an agent config or an agent
 * principal. Everyone else is a person — an external client using a person's
 * own credentials acts as that person (the same rule as decision settings).
 * An operator is a person at sovereign rank (granted only by operator
 * configuration: `MARINA_ADMINS` on loopback, `MARINA_AUTH_ADMIN_EMAILS`, the
 * local profile's loopback operator, or an operator's `rank set`).
 *
 * Authority never escalates: an approver must be able to do the thing
 * themselves — an operator, or the owner holding the gate unsupervised (and
 * the rank floor). The requester, and any agent the requester spawned, can
 * never approve (self-attestation is always refused).
 *
 * APPROVALS ARE THE PROOF (2026-10-14): a person's `once` approval of an
 * earnable gate's held run is one demonstration toward that gate
 * (`approvalDemonstrates`), unless the approver is inside the requester's own
 * lineage — an owner's approval runs its agent's action but never builds the
 * agent's gate. Operator-grant gates (the open-posture core) are never built
 * by approvals, and the judge's approvals never count. `always` is a grant and
 * takes an operator; anyone else's `always` is an approval of this one run.
 *
 * Every answer is a LABEL: a person's verdict on a real held action, recorded
 * append-only in `challenge_outcomes` (migration 139) with the judge's shadow
 * opinion — held commands AND decision-gate tool holds are scored.
 * `MARINA_CHALLENGE_JUDGE`:
 *   - `observe` (default) — the decision backend scores each hold; never acts.
 *   - `on`      — observe, and auto-approve `once` for a CLASS (gate id,
 *                 `rank:<n>` or `tool:<name>`) only after the judge has EARNED
 *                 it: across ≥ EARNED_MIN_N answered cases where it said
 *                 allow, people approved with a Wilson lower bound ≥
 *                 EARNED_MIN_PRECISION. Every AUDIT_EVERY-th earned case still
 *                 goes to people so the measurement never stops. Never the
 *                 OPEN_POSTURE_CORE gates, never `always`, never a deny — the
 *                 judge only shortens the path, it never closes one.
 * These labels are not blind (approvers see context; only held actions reach
 * them), so they are their own family, never mixed into the independent case
 * sets that prove calibration.
 *
 * A requester has at most MAX_PER_CLASS open challenges of one class and
 * MAX_PER_REQUESTER in all, so a newcomer probing different commands is never
 * walled off by its first few holds. The same held input coalesces onto its
 * open challenge; past the class cap the newest hold replaces the requester's
 * oldest one of the same class (closed as expired, the requester and
 * approvers told); only past the overall cap is nothing opened — with the
 * open tokens named. A hold never turns into a silent refusal.
 *
 * Durable (migration 166, `challenge_holds`): every hold is persisted, so it
 * survives a restart and still runs on approval. The held input is the
 * requester's own command text, kept only when it carries nothing
 * secret-shaped (`maskSensitiveText` leaves it unchanged); otherwise the hold
 * is closed at restore and the requester asked to issue it again. A tool hold
 * survives when its call is a world command (`typedToolCommand`). Notices the
 * requester could not receive (restore, expiry, deny) wait in the row and are
 * delivered when it is next connected. `MARINA_CHALLENGES=off` restores plain
 * refusals.
 */

import { independentParties } from "../agent/standing";
import { EARNED_JUDGE_MIN_LOWER, EARNED_JUDGE_MIN_N, earnedJudge } from "../decisions/earned-judge";
import { harnessDecisionProvider } from "../decisions/engines";
import { gateToolCall, maskSecretShapes, maskSensitiveText } from "../decisions/gate";
import { noteWorkFor } from "../learning/work";
import type { MarinaDB } from "../persistence/database";
import type { ChallengeHoldRow } from "../persistence/db-decisions";
import type { CodingCommandTarget } from "../sdk/command-target";
import type { Connection, Entity, EntityRank } from "../types";
import { OPEN_POSTURE_CORE } from "./autonomy";
import { withoutCommandResponse } from "./command-response";
import { positiveNumberFromEnv } from "./constants";
import { sanitizeEntityName } from "./entity-name";
import { getErrorMessage, tryLog } from "./errors";
import {
  getCurrentCodingTarget,
  getCurrentCommand,
  grantCommandPass,
  setGateRefusalHook,
} from "./gate-context";
import { Logger } from "./logger";
import { notifyOperator } from "./ops-notify";
import { getRank, rankName } from "./permissions";
import { checkUnattendedGate, grant, isOperatorGrantGate, SAFETY_GATES } from "./safety-gates";

export type ChallengeKind = "gate" | "rank" | "tool";
export type ChallengeAnswer = "once" | "always" | "deny";
/** Who a participant is, for answering holds: people answer, agents never do. */
export type PrincipalKind = "person" | "agent";

export interface Challenge {
  codingTarget?: CodingCommandTarget;
  token: string;
  kind: ChallengeKind;
  requesterId: string;
  requesterName: string;
  /** Safety gate the action needs (gate kind; rank kind when the command also has one). */
  gateId?: string;
  /** Rank floor the action needs (rank kind). */
  minRank?: number;
  /**
   * Held command input, re-dispatched on approval (gate / rank kinds; a tool
   * hold whose call is a world command carries it so it survives a restart).
   */
  command?: string;
  /** Held tool (tool kind). */
  toolName?: string;
  /** Masked, truncated rendering for approvers. */
  summary: string;
  /** Why it was held. */
  reason: string;
  /** The requester's owner — the person at the root of its spawn chain. */
  creatorName?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ChallengeHost {
  readonly db?: MarinaDB;
  getEntity(id: string): Entity | undefined;
  findEntity(name: string): Entity | undefined;
  /** Entities with a live connection (for operator notification). */
  connectedEntities(): Entity[];
  isConnected(id: string): boolean;
  send(id: string, text: string): void;
  /** Re-run a held command as the requester. */
  redispatch(
    entityId: string,
    raw: string,
    options?: { codingTarget?: CodingCommandTarget },
  ): Promise<void>;
  /** The principal that spawned this account, when it is an agent. */
  creatorOf(entity: { name: string }): string | undefined;
  /** The entity's live connection, for its principal signals. */
  connectionOf(entityId: string): Pick<Connection, "internal" | "protocol" | "agent"> | undefined;
  /** An agent account: it has an agent config or an agent principal. */
  isAgentAccount(name: string): boolean;
  /**
   * The held input as approvers may see it: a declared credential form
   * (`CommandDef.sensitiveSubcommands`) becomes `<verb> <sub> [redacted]`,
   * key-shaped strings are masked (`redactCommandText`).
   */
  redactCommand?(raw: string): string;
}

export type SettleError = "not_found" | "self" | "agent" | "not_authorized" | "absent";
export type SettleResult =
  | { ok: true; challenge: Challenge; answer: ChallengeAnswer; note?: string; detail?: string }
  | { ok: false; error: SettleError; detail?: string };

interface Pending {
  challenge: Challenge;
  /** Tool kind: runs the held call and returns its text for the requester. */
  rerun?: () => Promise<string>;
  /** Tool kind: the redacted call the judge scores. */
  judgeInput?: { args: Record<string, unknown>; description?: string };
  /** The judge's shadow opinion, once scored. */
  judge?: { opinion: "allow" | "hold" | "none"; signals: Record<string, number> };
  /** Approvers already told about this hold (in this process). */
  told: Set<string>;
}

const logger = new Logger();
const ADMIN_RANK = 9;
const MAX_PENDING = 1_000;
/** Open holds per requester of one class (gate id, `rank:<n>`, `tool:<name>`). */
export const MAX_PER_CLASS = 5;
/** Open holds per requester in all. */
export const MAX_PER_REQUESTER = 20;
/** How far up a spawn chain the owner is looked for. */
const MAX_OWNER_HOPS = 8;
export const DEFAULT_CHALLENGE_TTL_MS = 60 * 60_000;
/** The expiry/notice sweep runs on this timer — expiry is never lazy. */
export const CHALLENGE_SWEEP_INTERVAL_MS = 15_000;

const pending = new Map<string, Pending>();
let host: ChallengeHost | undefined;
let hostOwner: object | undefined;
let earnedSeen = 0;
let restoredFrom: MarinaDB | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

export function challengesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_CHALLENGES?.trim().toLowerCase() !== "off";
}

export type JudgeMode = "off" | "observe" | "on";

/**
 * `MARINA_CHALLENGE_JUDGE`: `observe` (default — score holds in shadow so the
 * judge's agreement with people can be measured; nothing is scored without a
 * decision provider), `on` (may approve earned classes), `off`.
 */
export function judgeMode(env: NodeJS.ProcessEnv = process.env): JudgeMode {
  const v = env.MARINA_CHALLENGE_JUDGE?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : "observe";
}

/** The judge earns a class after this many people-answered cases it called allow… (`earnedJudge`) */
export const EARNED_MIN_N = EARNED_JUDGE_MIN_N;
/** …with people approving at least this often (Wilson 95 % lower bound; `earnedJudge`). */
export const EARNED_MIN_PRECISION = EARNED_JUDGE_MIN_LOWER;
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

/** Engine side: wire the service, the gate-refusal hook and the expiry timer. */
export function setChallengeHost(next: ChallengeHost | undefined, owner?: object): void {
  host = next;
  hostOwner = next ? owner : undefined;
  restoredFrom = undefined;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  if (next) {
    sweepTimer = setInterval(() => {
      try {
        sweepChallenges();
      } catch (error) {
        logger.warn("challenges", "challenge sweep failed", { error: getErrorMessage(error) });
      }
    }, CHALLENGE_SWEEP_INTERVAL_MS);
    (sweepTimer as { unref?: () => void }).unref?.();
  }
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

// ─── Principal kind ──────────────────────────────────────────────────────────

/**
 * Person or agent, from signals the participant cannot talk its way out of
 * in the agent direction: an internal or MCP connection, a declared agent
 * client, or an account with an agent config / agent principal is an agent.
 */
export function principalKind(entity: Entity): PrincipalKind {
  if (!host) return "agent";
  const conn = host.connectionOf(entity.id);
  if (conn?.internal || conn?.protocol === "mcp" || conn?.agent) return "agent";
  return host.isAgentAccount(entity.name) ? "agent" : "person";
}

/** An operator: a person at sovereign rank. A rank-9 agent is not one. */
function isOperator(entity: Entity | undefined): boolean {
  return !!entity && getRank(entity) >= ADMIN_RANK && principalKind(entity) === "person";
}

/**
 * The requester's owner: the first PERSON up its spawn chain (an agent
 * spawned by an agent is answered for by the person who started the chain).
 * Undefined when the chain ends in `system`, nobody, or a loop.
 */
export function personOwner(requester: { name: string }): string | undefined {
  if (!host) return undefined;
  const seen = new Set<string>([norm(requester.name)]);
  let name = host.creatorOf(requester);
  for (let hop = 0; hop < MAX_OWNER_HOPS && isApprovableCreator(name); hop++) {
    if (seen.has(norm(name))) return undefined;
    seen.add(norm(name));
    if (!host.isAgentAccount(name)) return name;
    name = host.creatorOf({ name });
  }
  return undefined;
}

// ─── Durable state (migration 166) ───────────────────────────────────────────

/** The held input as approvers see it (summaries, notices, inbox items). */
function shownCommand(command: string): string {
  return host?.redactCommand ? host.redactCommand(command) : maskSecretShapes(command);
}

/**
 * The held input as stored: only when neither masking nor the credential-form
 * redaction would change it. A held `key add` therefore never reaches the
 * database; it still re-runs on approval in this process, and after a restart
 * the requester is asked to issue it again.
 */
function storableCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  if (maskSensitiveText(command, Number.MAX_SAFE_INTEGER) !== command) return undefined;
  return shownCommand(command) === command ? command : undefined;
}

function persistHold(challenge: Challenge): void {
  const db = host?.db;
  if (!db) return;
  const command = storableCommand(challenge.command);
  tryLog(logger, "challenges", "challenge hold not persisted", () =>
    db.saveChallengeHold({
      token: challenge.token,
      kind: challenge.kind,
      requesterId: challenge.requesterId,
      requesterName: challenge.requesterName,
      ...(challenge.creatorName ? { creatorName: challenge.creatorName } : {}),
      ...(challenge.gateId ? { gateId: challenge.gateId } : {}),
      ...(challenge.minRank !== undefined ? { minRank: challenge.minRank } : {}),
      ...(command ? { command } : {}),
      ...(challenge.toolName ? { toolName: challenge.toolName } : {}),
      ...(challenge.codingTarget ? { codingTarget: JSON.stringify(challenge.codingTarget) } : {}),
      summary: challenge.summary,
      reason: challenge.reason,
      createdAt: challenge.createdAt,
      expiresAt: challenge.expiresAt,
    }),
  );
  openInboxItem(challenge);
  void notifyOperator({
    event: "challenge.opened",
    title: `Marina: ${challenge.requesterName} is waiting on a person (${challengeClass(challenge)})`,
    detail: `${challenge.reason} · answer within ${minutesLeft(challenge)} min`,
    action: `challenge approve ${challenge.token}`,
    token: challenge.token,
    class: challengeClass(challenge),
    deadlineAt: challenge.expiresAt,
  });
}

/** The live entity id of the requester (ids are transient; names are not). */
function liveRequesterId(challenge: Challenge): string | undefined {
  if (!host) return undefined;
  const byId = host.getEntity(challenge.requesterId);
  if (byId && norm(byId.name) === norm(challenge.requesterName)) return byId.id;
  return host.findEntity(challenge.requesterName)?.id;
}

/** Tell the requester now when connected; false when it must wait for them. */
function tellRequester(challenge: Challenge, text: string): boolean {
  const id = liveRequesterId(challenge);
  if (!id || !host?.isConnected(id)) return false;
  host.send(id, text);
  return true;
}

/** Close a hold durably; a notice the requester could not get now waits in its row. */
function closeHold(
  challenge: Challenge,
  status: "once" | "always" | "deny" | "expired",
  notice?: string,
): void {
  const owed = notice && !tellRequester(challenge, notice) ? notice : undefined;
  const db = host?.db;
  if (db) {
    tryLog(logger, "challenges", "challenge hold not settled", () =>
      db.updateChallengeHold(challenge.token, {
        status,
        ...(owed ? { requesterNotice: owed } : {}),
      }),
    );
  }
  resolveInboxItem(challenge.token);
}

const inboxKey = (token: string) => `challenge:${token}`;

/**
 * The durable inbox for approvers who are offline: one `ops inbox` item per
 * hold (content-free — the class and reason, never the held input), resolved
 * when the hold is answered or expires.
 */
function openInboxItem(challenge: Challenge): void {
  const db = host?.db;
  if (!db) return;
  tryLog(logger, "challenges", "challenge inbox item not opened", () => {
    db.upsertOperationalAlert({
      key: inboxKey(challenge.token),
      severity: "info",
      category: "challenge",
      kind: "approval",
      title: `${challenge.requesterName} is waiting on a person's answer (${challengeClass(challenge)})`,
      detail: `${challenge.reason} · token ${challenge.token}`,
      remedy:
        `challenge (see it) · challenge approve ${challenge.token} · challenge deny ${challenge.token} [why]` +
        ` — answered by ${challenge.creatorName ? `${challenge.creatorName} or ` : ""}an operator`,
      sourceEntity: challenge.requesterName,
      ...(challenge.creatorName ? { assignedTo: challenge.creatorName } : {}),
      actionLabel: "Answer",
      actionRef: `challenge approve ${challenge.token}`,
      deadlineAt: challenge.expiresAt,
      metadata: { token: challenge.token, class: challengeClass(challenge) },
    });
  });
}

function resolveInboxItem(token: string): void {
  const db = host?.db;
  if (!db) return;
  tryLog(logger, "challenges", "challenge inbox item not resolved", () => {
    const key = inboxKey(token);
    for (const status of ["open", "acknowledged"] as const)
      for (const alert of db.listOperationalAlerts(status, 1_000))
        if (alert.alert_key === key) db.setOperationalAlertStatus(alert.id, "resolved");
  });
}

function minutesLeft(challenge: Challenge, now = Date.now()): number {
  return Math.max(1, Math.round((challenge.expiresAt - now) / 60_000));
}

function parseTarget(raw: string | null): CodingCommandTarget | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { sessionId?: unknown; runId?: unknown };
    if (typeof value.sessionId !== "string") return undefined;
    return {
      sessionId: value.sessionId,
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    };
  } catch {
    return undefined;
  }
}

function fromRow(row: ChallengeHoldRow): Challenge {
  const codingTarget = parseTarget(row.coding_target);
  return {
    token: row.token,
    kind: row.kind,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    ...(row.creator_name ? { creatorName: row.creator_name } : {}),
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    ...(row.min_rank !== null ? { minRank: row.min_rank } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(codingTarget ? { codingTarget } : {}),
    summary: row.summary,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Reload the pending holds a previous process left (once per database). A
 * hold whose input could not be kept (secret-shaped, or a tool call that is
 * not a world command) is closed and its requester asked to issue it again;
 * every other one stays pending and its requester is told it survived.
 */
function ensureRestored(): void {
  const db = host?.db;
  if (!db || restoredFrom === db) return;
  restoredFrom = db;
  let rows: ChallengeHoldRow[];
  try {
    rows = db.listChallengeHolds({ pending: true });
  } catch (error) {
    logger.warn("challenges", "pending challenges not restored", {
      error: getErrorMessage(error),
    });
    return;
  }
  let restored = 0;
  for (const row of rows) {
    if (pending.has(row.token)) continue;
    const challenge = fromRow(row);
    if (!challenge.command) {
      closeHold(
        challenge,
        "expired",
        `Challenge ${challenge.token} did not survive a restart (${challenge.kind === "tool" ? "the held call can only be replayed by the process that made it" : "its input carried a credential or secret-shaped value, which is never stored"}) — ${challenge.summary} did not run. Issue it again if it is still needed.`,
      );
      continue;
    }
    pending.set(challenge.token, { challenge, told: new Set() });
    restored++;
    const notice =
      `Challenge ${challenge.token} survived a restart and is still pending ` +
      `(${minutesLeft(challenge)} min left): ${challenge.summary}. It runs automatically if approved; continue other work.`;
    if (!tellRequester(challenge, notice)) {
      tryLog(logger, "challenges", "restore notice not stored", () =>
        db.updateChallengeHold(challenge.token, { requesterNotice: notice }),
      );
    }
  }
  if (restored) logger.info("challenges", "pending challenges restored", { restored });
}

/** Expire due holds (and restore, once). Runs on the timer and before every read. */
function expireDue(now = Date.now()): void {
  if (!host) return;
  ensureRestored();
  let expired = 0;
  for (const [token, entry] of pending) {
    if (entry.challenge.expiresAt > now) continue;
    pending.delete(token);
    recordOutcome(entry, "expired");
    closeHold(
      entry.challenge,
      "expired",
      `Challenge ${token} expired unanswered — ${entry.challenge.summary} did not run.`,
    );
    expired++;
  }
  if (expired > 0) noteUnanswered(now);
}

// ─── Unanswered-hold summary (2026-10-20) ────────────────────────────────────

/** The window `challenge summary` and the unanswered digest look back over. */
export const CHALLENGE_SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The one rolling ops-inbox item for holds that expired with nobody answering. */
export const UNANSWERED_DIGEST_KEY = "challenge:unanswered";

export interface ChallengeSummary {
  windowMs: number;
  total: number;
  open: number;
  approved: number;
  denied: number;
  /** Expired with nobody answering (includes holds superseded at the class cap). */
  unanswered: number;
  /** Per class (gate id, `rank:<n>`, `tool:<name>`), most unanswered first. */
  byClass: { class: string; total: number; unanswered: number }[];
  /** Per requester, most unanswered first. */
  byRequester: { name: string; total: number; unanswered: number }[];
  /** Holds with no owner: only an operator can ever answer them. */
  operatorOnly: number;
}

function rowClass(row: ChallengeHoldRow): string {
  return challengeClass({
    kind: row.kind,
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    ...(row.min_rank !== null ? { minRank: row.min_rank } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
  });
}

/** Pure: what happened to the holds opened inside the window. Content-free. */
export function summarizeChallengeHolds(
  rows: readonly ChallengeHoldRow[],
  now = Date.now(),
  windowMs = CHALLENGE_SUMMARY_WINDOW_MS,
): ChallengeSummary {
  const recent = rows.filter((r) => r.created_at >= now - windowMs);
  const tally = (key: (r: ChallengeHoldRow) => string) => {
    const map = new Map<string, { total: number; unanswered: number }>();
    for (const r of recent) {
      const k = key(r);
      const cur = map.get(k) ?? { total: 0, unanswered: 0 };
      cur.total++;
      if (r.status === "expired") cur.unanswered++;
      map.set(k, cur);
    }
    return [...map.entries()].sort(
      (a, b) => b[1].unanswered - a[1].unanswered || b[1].total - a[1].total,
    );
  };
  return {
    windowMs,
    total: recent.length,
    open: recent.filter((r) => r.status === "pending").length,
    approved: recent.filter((r) => r.status === "once" || r.status === "always").length,
    denied: recent.filter((r) => r.status === "deny").length,
    unanswered: recent.filter((r) => r.status === "expired").length,
    byClass: tally(rowClass).map(([k, v]) => ({ class: k, ...v })),
    byRequester: tally((r) => r.requester_name).map(([k, v]) => ({ name: k, ...v })),
    operatorOnly: recent.filter((r) => !r.creator_name).length,
  };
}

/** The live world's summary, or undefined without a database. */
export function challengeSummary(
  now = Date.now(),
  windowMs = CHALLENGE_SUMMARY_WINDOW_MS,
): ChallengeSummary | undefined {
  const db = host?.db;
  if (!db) return undefined;
  try {
    return summarizeChallengeHolds(db.listChallengeHolds({ limit: 10_000 }), now, windowMs);
  } catch {
    return undefined; // allow-empty-catch: a closed or unmigrated database has no summary
  }
}

/**
 * Holds just expired with nobody answering: keep ONE rolling ops-inbox item
 * (`challenge:unanswered`, warning) that stays open until an operator
 * resolves it — the per-hold items close on expiry, so without it nothing
 * visible remained — and push a notice through MARINA_OPS_NOTIFY.
 */
function noteUnanswered(now: number): void {
  const db = host?.db;
  const summary = challengeSummary(now);
  if (!db || !summary || summary.unanswered === 0) return;
  const days = Math.round(summary.windowMs / 86_400_000);
  const classes = summary.byClass
    .filter((c) => c.unanswered > 0)
    .slice(0, 5)
    .map((c) => `${c.class} ${c.unanswered}`)
    .join(", ");
  const title = `${summary.unanswered} of ${summary.total} held action(s) expired unanswered (${days} d)`;
  const detail =
    `${classes}${summary.operatorOnly ? ` · ${summary.operatorOnly} had no owner (operator-only)` : ""}` +
    ` · approved ${summary.approved}, denied ${summary.denied}, open ${summary.open}`;
  tryLog(logger, "challenges", "unanswered-hold digest not updated", () =>
    db.upsertOperationalAlert({
      key: UNANSWERED_DIGEST_KEY,
      severity: "warning",
      category: "challenge-digest",
      kind: "approval",
      title,
      detail,
      remedy:
        "challenge summary · answer new holds with challenge approve|deny <token> · " +
        "set MARINA_OPS_NOTIFY to be told the moment one opens · ops resolve <id> clears this",
      metadata: { unanswered: summary.unanswered, total: summary.total },
    }),
  );
  void notifyOperator({ event: "challenge.unanswered", title: `Marina: ${title}`, detail });
}

/** Deliver notices owed to requesters who are connected now. */
function deliverNotices(): void {
  const db = host?.db;
  if (!db) return;
  let rows: ChallengeHoldRow[];
  try {
    rows = db.listChallengeHolds({ withNotice: true, limit: 500 });
  } catch {
    return; // allow-empty-catch: a closed or unmigrated database owes nothing yet
  }
  for (const row of rows) {
    if (!row.requester_notice) continue;
    if (tellRequester(fromRow(row), row.requester_notice)) {
      tryLog(logger, "challenges", "challenge notice not cleared", () =>
        db.updateChallengeHold(row.token, { requesterNotice: null }),
      );
    }
  }
}

/** Tell approvers who connected since a hold was raised (or restored) about it. */
function tellLateApprovers(): void {
  for (const entry of pending.values()) notify(entry);
}

/**
 * The full sweep, on a timer (CHALLENGE_SWEEP_INTERVAL_MS): expire due holds,
 * deliver owed notices, and tell newly connected approvers. Exported for tests.
 */
export function sweepChallenges(now = Date.now()): void {
  if (!host) return;
  expireDue(now);
  deliverNotices();
  tellLateApprovers();
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
    // allow-empty-catch: the ledger is measurement, never a reason for an answer to fail.
  }
  // Lessons from work (MARINA_LESSONS_FROM_WORK): the answer's class and kind
  // only; the summary is writer context, never stored.
  noteWorkFor(db, c.requesterName, {
    source: "challenge",
    tool: challengeClass(c),
    errorClass: answer,
    succeeded: answer === "once" || answer === "always",
    at: Date.now(),
    ref: `challenge:${c.token}`,
    privateText: `${maskSensitiveText(c.summary, 240)}\n${c.reason}`,
  });
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
    // Precision of allow: people approved what the judge said to allow.
    const { lower, earned } = earnedJudge(rec.allowApproved, rec.allowSaid);
    rec.precisionLower = lower;
    rec.earned = !OPEN_POSTURE_CORE.has(rec.class) && earned;
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

/** True when `name` is anywhere up `requester`'s spawn chain. */
function inLineage(requester: { name: string }, name: string): boolean {
  if (!host) return false;
  const seen = new Set<string>([norm(requester.name)]);
  let hop = host.creatorOf(requester);
  for (let i = 0; i < MAX_OWNER_HOPS && isApprovableCreator(hop); i++) {
    if (norm(hop) === norm(name)) return true;
    if (seen.has(norm(hop))) return false;
    seen.add(norm(hop));
    hop = host.creatorOf({ name: hop });
  }
  return false;
}

/**
 * APPROVALS ARE THE PROOF: whether a person's approval of `requester`'s held
 * run of `gateId` counts as a demonstration toward that gate. It counts when
 * the gate is earnable (operator-grant gates are never built by approvals) and
 * the approver is a person outside the requester's own lineage. The owner of
 * an agent — whoever is up its spawn chain — may approve the run (it runs),
 * but that approval never builds the agent's gate: for gates a person and the
 * agents it spawned are one party, the same rule `gate grant` applies.
 */
export function approvalDemonstrates(
  approver: Entity,
  requester: { name: string },
  gateId: string | undefined,
): boolean {
  if (!gateId || !SAFETY_GATES[gateId] || isOperatorGrantGate(gateId)) return false;
  if (principalKind(approver) !== "person") return false;
  if (norm(approver.name) === norm(requester.name)) return false;
  // The gate's one-party rule (agent configs, then agent principals' owners);
  // the live spawn chain when no store is wired. Standing is looser since
  // 2026-10-20 (each account its own party, `standingVerifierRefusal`); gates
  // deliberately are not: a person's own agents may raise each other's
  // standing to a gate's floor, but only an approval from outside the lineage
  // makes the gate solo.
  const db = host?.db;
  if (db && typeof db.spawnLineage === "function") {
    return independentParties(db, approver.name, requester.name);
  }
  return !inLineage(requester, approver.name);
}

/** An operator: exported for the compatibility `witness attest` path. */
export function isOperatorPrincipal(entity: Entity | undefined): boolean {
  return isOperator(entity);
}

/** Whether `approver` could do the held thing themselves. */
function holdsAuthority(approver: Entity, challenge: Challenge): boolean {
  if (isOperator(approver)) return true;
  if (challenge.kind === "tool") return true; // the owner answers for its agent's calls
  if (challenge.minRank !== undefined && getRank(approver) < challenge.minRank) return false;
  if (challenge.gateId) {
    const db = host?.db;
    return !!db && checkUnattendedGate(db, approver.id, challenge.gateId).ok;
  }
  return true;
}

function authorize(approver: Entity, challenge: Challenge): SettleError | undefined {
  if (isSelfOrChild(approver, challenge)) return "self";
  if (principalKind(approver) !== "person") return "agent";
  const isOwner = !!challenge.creatorName && norm(approver.name) === norm(challenge.creatorName);
  if (!isOwner && !isOperator(approver)) return "not_authorized";
  if (!holdsAuthority(approver, challenge)) return "not_authorized";
  return undefined;
}

/** Connected people who may be asked: the owner and the operators. */
function candidatesFor(challenge: Challenge): Entity[] {
  if (!host) return [];
  const candidates: Entity[] = [];
  if (challenge.creatorName) {
    const owner = host.findEntity(challenge.creatorName);
    if (owner) candidates.push(owner);
  }
  for (const entity of host.connectedEntities()) {
    if (getRank(entity) >= ADMIN_RANK) candidates.push(entity);
  }
  return candidates.filter((c) => host?.isConnected(c.id) && !authorize(c, challenge));
}

/** Ask every eligible connected approver not yet told; returns everyone told so far. */
function notify(entry: Pending): string[] {
  if (!host) return [];
  const { challenge } = entry;
  const text =
    `? ${challenge.requesterName} asks to run: ${challenge.summary}\n` +
    `  ${challenge.reason}\n` +
    `  challenge approve ${challenge.token}` +
    (challenge.gateId && challenge.kind !== "tool" ? " [once|always]" : "") +
    `  ·  challenge deny ${challenge.token} [why]  (open ${minutesLeft(challenge)} min)`;
  for (const candidate of candidatesFor(challenge)) {
    if (entry.told.has(candidate.id)) continue;
    host.send(candidate.id, text);
    entry.told.add(candidate.id);
  }
  return [...entry.told].map((id) => host?.getEntity(id)?.name ?? id);
}

interface Created {
  entry?: Pending;
  existing?: boolean;
  /** The requester's oldest same-class challenge this one replaced (at the class cap). */
  superseded?: Challenge;
  /** `requester_full`: the requester's open challenges. */
  open?: Challenge[];
  error?: "disabled" | "no_requester" | "full" | "requester_full";
}

/**
 * Open (or coalesce onto) a challenge. At the per-class cap the newest hold
 * REPLACES the requester's oldest open challenge of the same class — the
 * replaced one is closed as expired and the requester is told it did not run —
 * so a stream of holds never silently turns into a wall; only at the overall
 * per-requester cap is nothing opened (`requester_full`, with the open ones
 * named).
 */
function create(
  input: Omit<Challenge, "token" | "createdAt" | "expiresAt" | "requesterName" | "creatorName">,
  extra: { rerun?: () => Promise<string>; judgeInput?: Pending["judgeInput"] } = {},
  ttl = ttlMs(),
  requesterName?: string,
): Created {
  if (!host || !challengesEnabled()) return { error: "disabled" };
  expireDue();
  const requester =
    host.getEntity(input.requesterId) ??
    (requesterName ? host.findEntity(requesterName) : undefined);
  if (!requester) return { error: "no_requester" };
  input = { ...input, requesterId: requester.id };
  const mine = [...pending.values()].filter(
    (p) =>
      p.challenge.requesterId === requester.id ||
      norm(p.challenge.requesterName) === norm(requester.name),
  );
  const same = mine.find(
    (p) =>
      p.challenge.kind === input.kind &&
      p.challenge.command === input.command &&
      p.challenge.codingTarget?.sessionId === input.codingTarget?.sessionId &&
      p.challenge.codingTarget?.runId === input.codingTarget?.runId &&
      p.challenge.toolName === input.toolName &&
      p.challenge.summary === maskSensitiveText(input.summary, 240),
  );
  if (same) {
    // A restored hold regains the live process's replay closure.
    if (extra.rerun && !same.rerun) same.rerun = extra.rerun;
    return { entry: same, existing: true };
  }
  let superseded: Challenge | undefined;
  const cls = challengeClass(input);
  const sameClass = mine
    .filter((p) => challengeClass(p.challenge) === cls)
    .sort((a, b) => a.challenge.createdAt - b.challenge.createdAt);
  if (sameClass.length >= MAX_PER_CLASS) {
    const oldest = sameClass[0] as Pending;
    pending.delete(oldest.challenge.token);
    recordOutcome(oldest, "expired");
    closeHold(oldest.challenge, "expired");
    superseded = oldest.challenge;
  } else if (mine.length >= MAX_PER_REQUESTER) {
    return {
      error: "requester_full",
      open: mine.map((p) => p.challenge).sort((a, b) => a.createdAt - b.createdAt),
    };
  } else if (pending.size >= MAX_PENDING) {
    return { error: "full" };
  }
  const creator = personOwner(requester);
  const now = Date.now();
  const challenge: Challenge = {
    ...input,
    summary: maskSensitiveText(input.summary, 240),
    requesterName: requester.name,
    ...(creator ? { creatorName: creator } : {}),
    token: newToken(),
    createdAt: now,
    expiresAt: now + ttl,
  };
  const entry: Pending = {
    challenge,
    told: new Set(),
    ...(extra.rerun ? { rerun: extra.rerun } : {}),
    ...(extra.judgeInput ? { judgeInput: extra.judgeInput } : {}),
  };
  pending.set(challenge.token, entry);
  persistHold(challenge);
  return { entry, ...(superseded ? { superseded } : {}) };
}

/** Who answers this hold, in words (people only). */
function approverWords(challenge: Challenge): string {
  if (!challenge.creatorName) return "an admin (a person)";
  return challenge.kind === "tool"
    ? `${challenge.creatorName} or an admin`
    : `an admin, or ${challenge.creatorName} if they hold the authority`;
}

/**
 * What the requester is told when a call is held: always who can answer, how
 * long it stays open, and that nothing waits on it — including when no
 * approver is connected, so the loop never mistakes a hold for progress.
 */
function heldMessage(
  challenge: Challenge,
  told: string[],
  existing: boolean,
  superseded?: Challenge,
): string {
  const token = challenge.token;
  const minutes = minutesLeft(challenge);
  const replaced = superseded
    ? ` Replaced your oldest held call of this kind (challenge ${superseded.token}: ${superseded.summary.slice(0, 80)}); it did not run.`
    : "";
  if (existing) {
    return `\nheld: challenge ${token} still pending (${minutes} min left); runs automatically if approved. Continue other work.`;
  }
  if (told.length) {
    return (
      `\nheld: challenge ${token}; asked ${told.join(", ")}; runs automatically if approved, ` +
      `nothing waits on it. Continue other work.${replaced}`
    );
  }
  return (
    `\nheld: challenge ${token}; approver: ${approverWords(challenge)}, none connected (it waits in their inbox); ` +
    `open ${minutes} min, runs automatically if approved, else expires without running. Continue other work; ` +
    `if this step is essential, take another route.${replaced}`
  );
}

/** The refusal when nothing could be opened: explicit, naming what is open. */
function notOpenedMessage(made: Created): string {
  if (made.error === "requester_full" && made.open?.length) {
    const shown = made.open.slice(0, 5);
    const open = shown.map((c) => `${c.token} (${c.summary.slice(0, 60)})`).join(", ");
    const more =
      made.open.length > shown.length ? `, +${made.open.length - shown.length} more` : "";
    return (
      ` Not run: you have ${made.open.length} open challenges (the most at once); none opened (${open}${more}). ` +
      "Take another route, or retry once one is answered or expires (`challenge` lists them)."
    );
  }
  if (made.error === "full") {
    return " Not run: too many open challenges in this world; none opened. Take another route, or retry later.";
  }
  return " Not run (no challenge could be opened); choose another step.";
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
  const codingTarget = getCurrentCodingTarget(input.requesterId);
  const summary =
    shownCommand(input.command.trim()).slice(0, 240) +
    (codingTarget
      ? ` [session ${codingTarget.sessionId}${codingTarget.runId ? `, run ${codingTarget.runId}` : ""}]`
      : "");
  const kind: ChallengeKind = input.minRank !== undefined ? "rank" : "gate";
  const reason =
    kind === "rank"
      ? `Needs ${rankName(input.minRank as EntityRank)} (rank ${input.minRank})${input.gateId ? ` and the ${input.gateId} gate` : ""}.`
      : `Needs the ${input.gateId} gate: ${firstSentence(input.reason)}`;
  const made = create({
    kind,
    requesterId: input.requesterId,
    command: input.command,
    ...(codingTarget ? { codingTarget: { ...codingTarget } } : {}),
    summary,
    reason,
    ...(input.gateId ? { gateId: input.gateId } : {}),
    ...(input.minRank !== undefined ? { minRank: input.minRank } : {}),
  });
  if (!made.entry) {
    return made.error === "full" || made.error === "requester_full"
      ? `\n${notOpenedMessage(made).trim()}`
      : "";
  }
  const { challenge } = made.entry;
  if (made.superseded) tellSuperseded(made.superseded, challenge);
  const told = made.existing ? [] : notify(made.entry);
  if (!made.existing) maybeJudge(made.entry);
  return heldMessage(challenge, told, !!made.existing, made.superseded);
}

/**
 * Raise a challenge for a decision-gate `ask` on an agent tool call. Returns
 * the block reason for the tool call — immediately; `rerun` executes the held
 * call on approval and its text is delivered to the agent. `command` (the
 * world command the call sends, when it is one) lets the hold survive a
 * restart; `judge` is the redacted call the challenge judge scores in shadow.
 */
export function raiseForTool(input: {
  requesterId: string;
  /** Fallback when the requester's entity id is not known to the caller. */
  requesterName?: string;
  toolName: string;
  summary: string;
  reason: string;
  rerun: () => Promise<string>;
  command?: string;
  judge?: { args: Record<string, unknown>; description?: string };
  ttlMs?: number;
}): { token?: string; message: string } {
  const made = create(
    {
      kind: "tool",
      requesterId: input.requesterId,
      toolName: input.toolName,
      ...(input.command ? { command: input.command } : {}),
      // A world-command call is shown as that command, redacted like a held
      // command; the caller's summary otherwise.
      summary: (input.command && shownCommand(input.command) !== input.command
        ? `${input.toolName} ${shownCommand(input.command)}`
        : input.summary
      ).slice(0, 240),
      reason: input.reason,
    },
    { rerun: input.rerun, ...(input.judge ? { judgeInput: input.judge } : {}) },
    input.ttlMs,
    input.requesterName,
  );
  if (!made.entry) {
    return { message: `${input.reason}${notOpenedMessage(made)}` };
  }
  const { challenge } = made.entry;
  if (made.superseded) tellSuperseded(made.superseded, challenge);
  const told = made.existing ? [] : notify(made.entry);
  if (!made.existing) maybeJudge(made.entry);
  return {
    token: challenge.token,
    message: `${input.reason}${heldMessage(challenge, told, !!made.existing, made.superseded)}`,
  };
}

/** Tell the connected approvers that a challenge they saw was replaced by a newer one. */
function tellSuperseded(old: Challenge, next: Challenge): void {
  if (!host) return;
  for (const candidate of candidatesFor(old)) {
    host.send(
      candidate.id,
      `Challenge ${old.token} (${old.requesterName}) was replaced by ${next.token}; it did not run.`,
    );
  }
}

function firstSentence(text: string): string {
  const cut = text.search(/[.!?](\s|$)/);
  return (cut >= 0 ? text.slice(0, cut + 1) : text).slice(0, 200);
}

/** Pending challenges this entity may answer (none, for an agent). */
export function listAnswerable(approver: Entity): Challenge[] {
  expireDue();
  return [...pending.values()]
    .map((p) => p.challenge)
    .filter((c) => !authorize(approver, c))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Pending challenges this entity raised. */
export function listRaisedBy(entityId: string): Challenge[] {
  expireDue();
  const name = host?.getEntity(entityId)?.name;
  return [...pending.values()]
    .map((p) => p.challenge)
    .filter((c) => c.requesterId === entityId || (!!name && norm(c.requesterName) === norm(name)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Answer a challenge. `once` re-runs the held action now; `always` also grants
 * the gate (the approver must hold it unsupervised, and core gates need an
 * operator); `deny` tells the requester. Only people answer: an agent —
 * whatever its rank — is refused (`agent`).
 */
export function settleChallenge(
  token: string,
  approver: Entity | "judge",
  answer: ChallengeAnswer,
  note?: string,
): SettleResult {
  expireDue();
  const entry = pending.get(token.trim());
  if (!entry || !host) return { ok: false, error: "not_found" };
  const { challenge } = entry;
  const approverName = approver === "judge" ? "the judge" : approver.name;
  if (approver !== "judge") {
    const error = authorize(approver, challenge);
    if (error) return { ok: false, error };
  }
  // The re-run happens in the requester's own slot; after a restart its
  // entity id may have changed, and an absent requester keeps the hold open.
  const requesterId = liveRequesterId(challenge);
  const replaysCommand = !!challenge.command && !(challenge.kind === "tool" && entry.rerun);
  if (answer !== "deny" && replaysCommand && !requesterId) {
    return {
      ok: false,
      error: "absent",
      detail: `${challenge.requesterName} is not in the world right now; the hold stays open until it expires.`,
    };
  }
  if (requesterId && requesterId !== challenge.requesterId) {
    challenge.requesterId = requesterId;
    const db = host.db;
    if (db) {
      tryLog(logger, "challenges", "challenge requester not re-keyed", () =>
        db.updateChallengeHold(challenge.token, { requesterId }),
      );
    }
  }
  let effective = answer;
  let detail: string | undefined;
  const gateId = challenge.kind === "tool" ? undefined : challenge.gateId;
  if (answer === "always") {
    // A grant comes from an operator, exactly as `gate grant` allows: an
    // owner who is not an operator never grants its own agent a gate (one
    // party), so its `always` is an approval of this one run.
    const canGrant = approver !== "judge" && !!gateId && isOperator(approver);
    if (canGrant && host.db && gateId) {
      grant(host.db, challenge.requesterId, gateId);
    } else {
      effective = "once";
      detail = gateId
        ? `granting ${gateId} for good takes an operator; approved once`
        : "a rank floor can't be granted (rank follows standing); approved once";
    }
  }
  // APPROVALS ARE THE PROOF: an approved run of an earnable gate, by a person
  // outside the requester's lineage, is one demonstration toward it.
  const demonstrates =
    effective === "once" &&
    approver !== "judge" &&
    approvalDemonstrates(approver, { name: challenge.requesterName }, gateId);
  if (effective === "once" && gateId && approver !== "judge" && host.db) {
    const gate = SAFETY_GATES[gateId];
    const note = demonstrates
      ? `counts toward ${gateId}: ${gate?.demoThreshold} approved runs make it solo`
      : isOperatorGrantGate(gateId)
        ? `${gateId} is operator-grant only; this run builds nothing toward it`
        : `runs once; an approval from inside ${challenge.requesterName}'s own lineage does not build ${gateId}`;
    detail = detail ? `${detail}; ${note}` : note;
  }
  pending.delete(challenge.token);
  recordOutcome(entry, effective, approver);

  if (effective === "deny") {
    closeHold(
      challenge,
      "deny",
      `✗ ${approverName} declined challenge ${challenge.token} (${challenge.summary})${note ? `: ${note}` : "."} Choose another route.`,
    );
    return { ok: true, challenge, answer: "deny", ...(note ? { note } : {}) };
  }

  closeHold(challenge, effective);
  const approverId = approver === "judge" ? undefined : approver.id;
  host.send(
    challenge.requesterId,
    `✓ ${approverName} approved challenge ${challenge.token}${effective === "always" ? ` and granted ${challenge.gateId}` : ""}${note ? ` (${note})` : ""} — running it now.` +
      (demonstrates ? ` This approved run counts toward ${gateId}.` : ""),
  );
  if (challenge.kind === "tool" && entry.rerun) {
    const rerun = entry.rerun;
    const requester = challenge.requesterId;
    rerun().then(
      (text) =>
        host?.send(requester, `${challenge.toolName} (approved ${challenge.token}): ${text}`),
      (error: unknown) =>
        host?.send(
          requester,
          `${challenge.toolName} (approved ${challenge.token}) failed: ${getErrorMessage(error)}`,
        ),
    );
  } else if (challenge.kind === "tool" && challenge.command) {
    // A restored tool hold: its call is a world command, re-run in the slot.
    redispatchHeldCommand(challenge.requesterId, challenge.command, challenge.codingTarget);
  } else if (challenge.command) {
    grantCommandPass(challenge.requesterId, challenge.command, {
      codingTarget: challenge.codingTarget,
      gateIds: challenge.gateId ? [challenge.gateId] : [],
      rankWaived: challenge.minRank !== undefined,
      ...(challenge.minRank !== undefined ? { waivedRank: challenge.minRank } : {}),
      ...(approverId ? { approverId } : {}),
      ...(demonstrates ? { demonstrates: true } : {}),
      approverName,
      token: challenge.token,
    });
    redispatchHeldCommand(challenge.requesterId, challenge.command, challenge.codingTarget);
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
export function redispatchHeldCommand(
  entityId: string,
  raw: string,
  codingTarget?: CodingCommandTarget,
): boolean {
  const dispatcher = host;
  if (!dispatcher) return false;
  withoutCommandResponse(() => {
    void dispatcher
      .redispatch(entityId, raw, codingTarget ? { codingTarget } : undefined)
      .catch((error) =>
        dispatcher.send(entityId, `Approved command could not execute: ${getErrorMessage(error)}`),
      );
  });
  return true;
}

/**
 * The judge (`MARINA_CHALLENGE_JUDGE=observe|on`): score a hold in shadow —
 * a held command, or a decision-gate tool hold (its redacted call) — and,
 * under `on`, for a class it has earned, approve it once.
 */
function maybeJudge(entry: Pending): void {
  const mode = judgeMode();
  if (mode === "off") return;
  const { challenge } = entry;
  const call =
    challenge.kind === "tool" && entry.judgeInput
      ? {
          tool: challenge.toolName ?? "unknown",
          args: entry.judgeInput.args,
          description: entry.judgeInput.description,
        }
      : challenge.command
        ? {
            tool: "marina_command",
            args: { command: shownCommand(challenge.command) },
            description:
              challenge.kind === "tool"
                ? undefined
                : challenge.gateId
                  ? SAFETY_GATES[challenge.gateId]?.description
                  : `a rank-${challenge.minRank} command`,
          }
        : undefined;
  if (!call) return;
  const provider = harnessDecisionProvider();
  if (!provider) return;
  gateToolCall(provider, call.tool, call.args, undefined, call.description)
    .then((decision) => {
      const live = pending.get(challenge.token);
      if (!live) return;
      live.judge = {
        opinion: decision.error ? "none" : decision.action === "allow" ? "allow" : "hold",
        signals: decision.signals,
      };
      if (mode !== "on" || live.judge.opinion !== "allow") return;
      if (challenge.gateId && OPEN_POSTURE_CORE.has(challenge.gateId)) return;
      const record = listJudgeRecords().find((r) => r.class === challengeClass(challenge));
      if (!record?.earned) return;
      earnedSeen++;
      if (earnedSeen % AUDIT_EVERY === 0) return; // an audit case: people answer it
      settleChallenge(challenge.token, "judge", "once", "judged safe — an earned class");
    })
    .catch(() => {
      // allow-empty-catch: the judge is a shortcut, never a requirement — on
      // failure the challenge simply waits for a person.
    });
}

/** Engine shutdown: unwire the host only if `owner` is still the one that set it. */
export function releaseChallengeHost(owner: object): void {
  if (host && hostOwner === owner) setChallengeHost(undefined);
}

/** Test seam: forget every in-process hold (a restart, as far as this module knows). */
export function resetChallengesForTests(): void {
  pending.clear();
  earnedSeen = 0;
  setChallengeHost(undefined);
}
