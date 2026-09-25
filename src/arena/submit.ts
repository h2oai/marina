// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast → validated body → signed request → ledger row → POST. Every step a
 * round can fail at is a refusal with a reason, never a silent default: the
 * arena scores a missing forecast as missing, and a malformed one would be
 * refused anyway.
 */

import { randomUUID } from "node:crypto";
import { guardedFetch } from "../net/url-guard";
import type { ArenaSubmissionRow } from "../persistence/db-arena";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { ArenaConfig } from "./config";
import type { ArenaData } from "./data";
import { forecastRound } from "./forecast";
import {
  arenaTimestamp,
  FORECAST_PATH,
  type loadPrivateKey,
  MAX_BODY_BYTES,
  type SignedMeta,
  signRequest,
} from "./protocol";
import type { ArenaForecastBody, ArenaRound } from "./types";

/** A signed request older than this is refused as a fresh write; re-sign instead. */
const RESEND_WITHIN_MS = 240_000;
/** Don't start a submission this close to the lock. */
export const LOCK_MARGIN_MS = 5 * 60_000;

/** The arena's answer contract for this round (mirrors `validate_answer_contract`). */
export function validateForecastBody(
  round: ArenaRound,
  body: ArenaForecastBody,
): string | undefined {
  if (body.round_id !== round.round_id) return "round_id does not match the round";
  const dist = (label: string, d: { mean: number; sd: number } | undefined) =>
    !d || !Number.isFinite(d.mean) || !Number.isFinite(d.sd) || d.sd <= 0 || d.sd > 1e6
      ? `${label} needs a finite mean and 0 < sd ≤ 1e6`
      : undefined;
  const answers = ["topline", "profile", "ranking"].filter((k) => k in body);
  if (answers.length !== 1) return "exactly one of topline, profile or ranking";
  if (round.target_type === "continuous_normal") return dist("topline", body.topline);
  if (round.target_type === "profile_energy") {
    const cells = round.cells ?? [];
    const keys = Object.keys(body.profile ?? {});
    if (keys.length !== cells.length || cells.some((c) => !keys.includes(c))) {
      return "profile must carry exactly the round's cells";
    }
    for (const c of cells) {
      const bad = dist(`profile.${c}`, body.profile?.[c]);
      if (bad) return bad;
    }
    return undefined;
  }
  const ranking = body.ranking ?? [];
  const length = round.ranking?.length ?? 10;
  if (ranking.length !== length) return `ranking must list exactly ${length} items`;
  if (new Set(ranking).size !== ranking.length) return "ranking items must be unique";
  const allowed = round.ranking?.items;
  if (allowed && ranking.some((r) => !allowed.includes(r)))
    return "ranking item outside the basket";
  return undefined;
}

export interface SubmitDeps {
  config: ArenaConfig;
  data: ArenaData;
  store: ArenaStore;
  key: ReturnType<typeof loadPrivateKey>;
  post?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export type SubmitOutcome =
  | { kind: "accepted"; roundId: string; row: ArenaSubmissionRow; already?: boolean }
  | { kind: "rejected" | "error"; roundId: string; reason: string; row?: ArenaSubmissionRow }
  | { kind: "skipped"; roundId: string; reason: string }
  | { kind: "dry-run"; roundId: string; body: ArenaForecastBody };

/** Build the body Marina would file for a round right now (no signing, no I/O beyond reads). */
export async function buildForecastBody(
  data: ArenaData,
  entrant: string,
  round: ArenaRound,
): Promise<ArenaForecastBody> {
  const lock = await data.lock(round.round_id);
  const f = forecastRound(round, lock);
  const body: ArenaForecastBody = {
    round_id: round.round_id,
    entrant,
    ...(f.topline ? { topline: f.topline } : {}),
    ...(f.profile ? { profile: f.profile } : {}),
    ...(f.ranking ? { ranking: f.ranking } : {}),
    notes: f.note.slice(0, 500),
  };
  const invalid = validateForecastBody(round, body);
  if (invalid) throw new Error(`${round.round_id}: ${invalid}`);
  return body;
}

export async function submitRound(
  deps: SubmitDeps,
  roundId: string,
  opts: { dryRun?: boolean } = {},
): Promise<SubmitOutcome> {
  const now = deps.now?.() ?? Date.now();
  const { config, store } = deps;
  const round = await deps.data.round(roundId);
  if (!round) return { kind: "skipped", roundId, reason: "no such round" };
  if (Date.parse(round.lock_at) - now < LOCK_MARGIN_MS) {
    return { kind: "skipped", roundId, reason: `locked (or locking) at ${round.lock_at}` };
  }
  const latest = store.latestArenaSubmission(config.entrant, roundId);
  if (latest?.status === "accepted" && !opts.dryRun) {
    return { kind: "accepted", roundId, row: latest, already: true };
  }

  let row: ArenaSubmissionRow;
  if (
    latest &&
    !opts.dryRun &&
    latest.status !== "rejected" &&
    Date.now() - latest.created_at < RESEND_WITHIN_MS // the ledger's own clock
  ) {
    row = latest; // an unconfirmed send: re-send the SAME signed request
  } else {
    let body: ArenaForecastBody;
    try {
      body = await buildForecastBody(deps.data, config.entrant, round);
    } catch (err) {
      return { kind: "skipped", roundId, reason: err instanceof Error ? err.message : String(err) };
    }
    if (opts.dryRun) return { kind: "dry-run", roundId, body };
    const raw = Buffer.from(JSON.stringify(body));
    if (raw.length > MAX_BODY_BYTES) return { kind: "skipped", roundId, reason: "body too large" };
    const meta: SignedMeta = {
      entrant: config.entrant,
      "key-id": config.keyId,
      "request-id": randomUUID(),
      timestamp: arenaTimestamp(new Date(now)),
    };
    const signature = signRequest(meta, raw, config.audience, deps.key);
    const id = store.insertArenaSubmission({
      entrant: config.entrant,
      roundId,
      requestId: meta["request-id"],
      url: config.origin,
      meta: JSON.stringify({ ...meta, signature }),
      body: raw.toString("utf8"),
    });
    row = store.latestArenaSubmission(config.entrant, roundId)!;
    if (row.id !== id) throw new Error("arena ledger write was not read back");
  }
  return send(deps, row);
}

async function send(deps: SubmitDeps, row: ArenaSubmissionRow): Promise<SubmitOutcome> {
  const meta = JSON.parse(row.meta) as Record<string, string>;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(meta)) headers[`X-SSA-${k}`] = v;
  const post =
    deps.post ??
    ((url: string, init: RequestInit) =>
      // Redirects are refused: a signed request must reach the registered origin only.
      guardedFetch(url, { ...init, signal: AbortSignal.timeout(60_000) }, { maxHops: 0 }));
  try {
    const res = await post(`${row.url}${FORECAST_PATH}`, {
      method: "POST",
      headers,
      body: row.body,
    });
    const text = await res.text();
    if (res.ok) {
      deps.store.updateArenaSubmission(row.id, {
        status: "accepted",
        httpStatus: res.status,
        response: text,
      });
      return { kind: "accepted", roundId: row.round_id, row: { ...row, status: "accepted" } };
    }
    // 4xx is an answer (bad signature, closed round, invalid forecast): never retried as-is.
    const status = res.status < 500 ? "rejected" : "error";
    deps.store.updateArenaSubmission(row.id, { status, httpStatus: res.status, response: text });
    return {
      kind: status,
      roundId: row.round_id,
      reason: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      row,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.store.updateArenaSubmission(row.id, { status: "error", response: reason });
    return { kind: "error", roundId: row.round_id, reason, row };
  }
}

/** Rounds whose lock falls inside the filing window and that have no accepted submission. */
export async function dueRounds(
  deps: Pick<SubmitDeps, "config" | "data" | "store" | "now">,
): Promise<ArenaRound[]> {
  const now = deps.now?.() ?? Date.now();
  const horizon = now + deps.config.windowHours * 3_600_000;
  return (await deps.data.openRounds(now)).filter((r) => {
    const lock = Date.parse(r.lock_at);
    return (
      lock <= horizon &&
      lock - now >= LOCK_MARGIN_MS &&
      deps.store.latestArenaSubmission(deps.config.entrant, r.round_id)?.status !== "accepted"
    );
  });
}
