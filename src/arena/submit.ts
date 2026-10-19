// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast → validated body → signed request → ledger row → POST. Every step a
 * round can fail at is a refusal with a reason, never a silent default: the
 * arena scores a missing forecast as missing, and a malformed one would be
 * refused anyway.
 */

import { createHash, randomUUID } from "node:crypto";
import { maskSensitiveText } from "../decisions/gate";
import { getErrorMessage, tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import { dailySpend } from "../engine/spend-ledger";
import { guardedFetch } from "../net/url-guard";
import type { ArenaSubmissionRow } from "../persistence/db-arena";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import {
  type AnchorCheck,
  type AnchorGuardMode,
  type AnchorGuardTrace,
  type AnchorReference,
  anchorGuardModeFromEnv,
  anchorIds,
  checkAnchor,
  describeStale,
  filedAnchorCheck,
  forecastAnchors,
  reanchorForecast,
} from "./anchor";
import {
  arenaCalibrationHistory,
  type CalibrationMode,
  calibrateFiledForecast,
  calibrationModeFromEnv,
} from "./calibration";
import type { ArenaConfig } from "./config";
import type { ArenaData } from "./data";
import type { Forecaster } from "./evaluate";
import { forecastRound, type RoundForecast } from "./forecast";
import { requireFreshForecast } from "./freshness";
import {
  applyMoveWeight,
  type MoveWeightMode,
  moveWeightHistory,
  moveWeightModeFromEnv,
} from "./move-weight";
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
  /** What produces the answer; the calibrated baseline when omitted. */
  forecaster?: Forecaster;
  /** Only nonsecret, explicitly selected strategy settings. */
  forecasterConfig?: Record<string, unknown>;
  /** Required by official operator routes, including the final signing check. */
  strictFreshness?: boolean;
  /** The anchor guard (`anchor.ts`); `MARINA_ARENA_ANCHOR_GUARD` when omitted. */
  anchorGuard?: AnchorGuardMode;
}

export const baselineForecaster: Forecaster = async (round, lock) => forecastRound(round, lock);

/** Set when the forecast's anchor was older than the arena's latest value (`anchor.ts`). */
type AnchorFlag = { anchor?: AnchorGuardTrace };

export type SubmitOutcome = (
  | { kind: "accepted"; roundId: string; row: ArenaSubmissionRow; already?: boolean }
  | { kind: "rejected" | "error"; roundId: string; reason: string; row?: ArenaSubmissionRow }
  | { kind: "skipped"; roundId: string; reason: string }
  | { kind: "dry-run"; roundId: string; body: ArenaForecastBody }
) &
  AnchorFlag;

/** Build the body Marina would file for a round right now (no signing, no I/O beyond reads). */
export async function buildForecastBody(
  data: ArenaData,
  entrant: string,
  round: ArenaRound,
  forecaster: Forecaster = baselineForecaster,
): Promise<ArenaForecastBody> {
  return (await prepareForecast(data, entrant, round, forecaster)).body;
}

/**
 * Whatever produced the forecast (nowcast, formation, crew, research, routed),
 * no filed sd is narrower than the series' measured nowcast error
 * (`ForecastOrigin.errorFloor`). Only ever widens; the mean is untouched.
 */
export function applyErrorFloor(round: ArenaRound, f: RoundForecast): RoundForecast {
  const floorOf = (id: string | undefined) => (id ? f.origins?.[id]?.errorFloor : undefined);
  const raised: string[] = [];
  let topline = f.topline;
  const top = floorOf(round.series);
  if (topline && top && topline.sd < top.sd) {
    raised.push(`sd floored to measured nowcast error ${top.sd} (n=${top.n})`);
    topline = { ...topline, sd: top.sd };
  }
  let profile = f.profile;
  if (profile) {
    const cells: string[] = [];
    for (const [cell, d] of Object.entries(profile)) {
      const floor = floorOf(cell);
      if (!floor || d.sd >= floor.sd) continue;
      profile = { ...profile, [cell]: { ...d, sd: floor.sd } };
      cells.push(cell);
    }
    if (cells.length) raised.push(`${cells.length} cell sd(s) floored to measured nowcast error`);
  }
  if (!raised.length) return f;
  return {
    ...f,
    ...(topline ? { topline } : {}),
    ...(profile ? { profile } : {}),
    note: `${f.note}; ${raised.join("; ")}`,
    errorFloorApplied: { ...(f.topline ? { fromSd: f.topline.sd } : {}), notes: raised },
  };
}

type Calibrate = (round: ArenaRound, f: RoundForecast) => RoundForecast;

/**
 * The (family, method) post-processing of a filing, from our own resolved
 * filings (and, for the move weight, arena shadows) and the arena's published
 * values: the learned move weight (`move-weight.ts`) on the mean, then the
 * spread calibration (`calibration.ts`). A read failure leaves the forecast
 * as its forecaster made it, never unfiled.
 */
async function calibrationFor(
  deps: Pick<SubmitDeps, "config" | "data" | "store" | "now">,
  mode: CalibrationMode = calibrationModeFromEnv(),
  moveMode: MoveWeightMode = moveWeightModeFromEnv(),
): Promise<Calibrate | undefined> {
  if (mode === "off" && moveMode === "off") return undefined;
  try {
    const [resolutions, rounds] = await Promise.all([deps.data.resolutions(), deps.data.rounds()]);
    const rows = deps.store.listArenaSubmissions({ entrant: deps.config.entrant, limit: 500 });
    const history = arenaCalibrationHistory(
      rows,
      resolutions,
      Object.fromEntries(rounds.map((r) => [r.round_id, r.tracker])),
    );
    const moves =
      moveMode === "off"
        ? []
        : moveWeightHistory(
            rows,
            resolutions,
            Object.fromEntries(
              rounds.map((r) => [
                r.round_id,
                {
                  tracker: r.tracker,
                  lock_at: r.lock_at,
                  ...(r.series ? { series: r.series } : {}),
                },
              ]),
            ),
            deps.store.listArenaShadow({ limit: 2_000 }),
          );
    const now = deps.now?.() ?? Date.now();
    return (round, f) => {
      const moved =
        moveMode === "off" ? f : applyMoveWeight(round, f, moves, { now, mode: moveMode });
      return mode === "off" ? moved : calibrateFiledForecast(round, moved, history, { now, mode });
    };
  } catch (err) {
    new Logger().warn("arena", "calibration history unavailable", {
      error: getErrorMessage(err),
    });
    return undefined;
  }
}

async function prepareForecast(
  data: ArenaData,
  entrant: string,
  round: ArenaRound,
  forecaster: Forecaster,
  calibrate?: Calibrate,
) {
  const lock = await data.lock(round.round_id);
  const raw = await forecaster(round, lock);
  // The forecaster, then the (family, method) move weight and spread
  // calibration, then the measured-error floor: the floor has the last word on
  // how narrow it may be.
  const f = applyErrorFloor(round, calibrate ? calibrate(round, raw) : raw);
  return {
    body: bodyFor(round, entrant, f),
    detail: {
      schema: "marina.arena.forecast.v1",
      round,
      lock,
      lockHash: createHash("sha256").update(JSON.stringify(lock)).digest("hex"),
      forecast: f,
    } as {
      schema: string;
      round: ArenaRound;
      lock: typeof lock;
      lockHash: string;
      forecast: RoundForecast;
      anchorGuard?: AnchorGuardTrace;
    },
  };
}

type Prepared = Awaited<ReturnType<typeof prepareForecast>>;

function bodyFor(round: ArenaRound, entrant: string, f: RoundForecast): ArenaForecastBody {
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

/** The arena's latest values for a round, or why they could not be read. */
async function referenceFor(
  data: ArenaData,
  round: ArenaRound,
): Promise<{ reference?: AnchorReference; error?: string }> {
  try {
    return { reference: await data.anchorReference(round) };
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
}

/**
 * The anchor guard, before signing: compare the forecast's anchor with the
 * newest value the arena treats as published for the round. Stale → re-read
 * the inputs once (arena data cache dropped, forecaster run again); still
 * stale → shift the stale means onto the arena's value (`reanchorForecast`).
 * `observe` records the verdict and files what was forecast. An unreadable
 * reference never blocks a filing; it is recorded as `unchecked`.
 */
async function guardAnchor(
  deps: SubmitDeps,
  round: ArenaRound,
  prepared: Prepared,
  again: () => Promise<Prepared>,
): Promise<Prepared> {
  const mode = deps.anchorGuard ?? anchorGuardModeFromEnv();
  if (mode === "off" || !anchorIds(round).length) return prepared;
  const trace = (p: Prepared, t: Omit<AnchorGuardTrace, "mode">): Prepared => {
    p.detail.anchorGuard = { mode, ...t };
    return p;
  };
  const checkOf = (p: Prepared, reference: AnchorReference) =>
    checkAnchor(round, forecastAnchors(round, p.detail.lock, p.detail.forecast), reference);
  const first = await referenceFor(deps.data, round);
  if (!first.reference) {
    return trace(prepared, {
      status: "unchecked",
      reason: first.error ?? "the arena publishes no comparable value for this round",
    });
  }
  const check = checkOf(prepared, first.reference);
  if (!check.stale) return trace(prepared, { status: "fresh", check });
  if (mode === "observe")
    return trace(prepared, { status: "stale", check, reason: describeStale(check) });

  deps.data.refresh();
  let fresh: Prepared;
  try {
    fresh = await again();
  } catch (err) {
    return trace(prepared, {
      status: "stale",
      check,
      reason: `${describeStale(check)}; re-reading the inputs failed: ${getErrorMessage(err)}`,
    });
  }
  const second = await referenceFor(deps.data, round);
  const recheck: AnchorCheck = second.reference ? checkOf(fresh, second.reference) : check;
  if (!recheck.stale) return trace(fresh, { status: "refetched", check: recheck });
  const shifted = reanchorForecast(fresh.detail.forecast, round, recheck);
  if (!Object.keys(shifted.reanchored).length) {
    return trace(fresh, { status: "stale", check: recheck, reason: describeStale(recheck) });
  }
  fresh.detail.forecast = shifted.forecast;
  fresh.body = bodyFor(round, deps.config.entrant, shifted.forecast);
  return trace(fresh, {
    status: "reanchored",
    check: recheck,
    reason: `inputs still stale after a re-read; re-anchored on the arena's latest value — ${describeStale(recheck)}`,
    reanchored: shifted.reanchored,
  });
}

/** True when the guard found a stale anchor (whatever it then did about it). */
function staleAnchor(trace: AnchorGuardTrace | undefined): boolean {
  return trace?.status === "stale" || trace?.status === "reanchored";
}

export async function submitRound(
  deps: SubmitDeps,
  roundId: string,
  opts: {
    dryRun?: boolean;
    /**
     * File a NEW version even though one was accepted. The arena scores the
     * newest version accepted before the lock (signed intake, "reveal": up to
     * 120 writes per round), so filing early as insurance and replacing it
     * with a fresher forecast near the lock is intended. An unchanged forecast
     * is not re-sent. Operator-only: the autopilot files once.
     */
    replace?: boolean;
    /**
     * File a FIRST version outside the filing window (`MARINA_ARENA_WINDOW_HOURS`).
     * Refused by default: an unanswered round scores nothing, while a filing that
     * misses its refresh is scored against a persistence baseline frozen on fresher
     * data. Replacing an accepted filing is always allowed (it only gets fresher).
     */
    early?: boolean;
  } = {},
): Promise<SubmitOutcome> {
  if (opts.dryRun) return submitRoundInner(deps, roundId, opts);
  const attempt = randomUUID();
  const now = () => deps.now?.() ?? Date.now();
  const record = (phase: "started" | "finished", status: string, detail: Record<string, unknown>) =>
    tryLog(new Logger(), "forecast", "Could not record arena attempt", () =>
      deps.store.recordArenaAttempt({
        attempt_id: attempt,
        entrant: deps.config.entrant,
        round_id: roundId,
        phase,
        status,
        detail: JSON.stringify(detail),
        created_at: now(),
      }),
    );
  record("started", "running", {
    config: deps.forecasterConfig ?? { spec: deps.config.forecaster },
    budget: dailySpend(),
  });
  try {
    const result = await submitRoundInner(deps, roundId, opts);
    // A stale anchor is its own status (the filing watch alerts on it), unless the send failed.
    const stale =
      staleAnchor(result.anchor) && result.kind !== "error" && result.kind !== "rejected";
    record(
      "finished",
      stale
        ? "stale_anchor"
        : result.kind === "accepted" && result.already
          ? "unchanged"
          : result.kind,
      {
        ...(stale
          ? { reason: maskSensitiveText(result.anchor?.reason ?? "stale anchor", 1000) }
          : "reason" in result
            ? { reason: maskSensitiveText(result.reason, 1000) }
            : {}),
        ...(result.anchor ? { anchor: result.anchor.status } : {}),
        ...("row" in result && result.row ? { submissionId: result.row.id } : {}),
        budget: dailySpend(),
      },
    );
    return result;
  } catch (error) {
    record("finished", "error", {
      reason: maskSensitiveText(getErrorMessage(error), 1000),
      budget: dailySpend(),
    });
    throw error;
  }
}

async function submitRoundInner(
  deps: SubmitDeps,
  roundId: string,
  opts: { dryRun?: boolean; replace?: boolean; early?: boolean },
): Promise<SubmitOutcome> {
  const now = deps.now?.() ?? Date.now();
  const { config, store } = deps;
  const round = await deps.data.round(roundId);
  if (!round) return { kind: "skipped", roundId, reason: "no such round" };
  if (Date.parse(round.lock_at) - now < LOCK_MARGIN_MS) {
    return { kind: "skipped", roundId, reason: `locked (or locking) at ${round.lock_at}` };
  }
  const latest = store.latestArenaSubmission(config.entrant, roundId);
  const accepted = store.acceptedArenaSubmission(config.entrant, roundId);
  if (accepted && !opts.dryRun && !opts.replace) {
    return { kind: "accepted", roundId, row: accepted, already: true };
  }
  const lockInHours = (Date.parse(round.lock_at) - now) / 3_600_000;
  if (!accepted && !opts.dryRun && !opts.early && lockInHours > config.windowHours) {
    return {
      kind: "skipped",
      roundId,
      reason: `locks in ${lockInHours.toFixed(0)} h, outside the ${config.windowHours} h filing window; an unanswered round scores nothing, a filing that misses its refresh scores below persistence (--early files anyway)`,
    };
  }

  let row: ArenaSubmissionRow;
  if (
    latest &&
    !opts.dryRun &&
    latest.status !== "rejected" &&
    latest.status !== "accepted" &&
    Date.now() - latest.created_at < RESEND_WITHIN_MS // the ledger's own clock
  ) {
    row = latest; // an unconfirmed send: re-send the SAME signed request
  } else {
    let body: ArenaForecastBody;
    let detail: Prepared["detail"];
    const calibrate = await calibrationFor(deps);
    const prepare = () =>
      prepareForecast(
        deps.data,
        config.entrant,
        round,
        deps.forecaster ?? baselineForecaster,
        calibrate,
      );
    try {
      ({ body, detail } = await guardAnchor(deps, round, await prepare(), prepare));
    } catch (err) {
      return { kind: "skipped", roundId, reason: err instanceof Error ? err.message : String(err) };
    }
    const flagged = <T extends SubmitOutcome>(out: T): T =>
      detail.anchorGuard ? { ...out, anchor: detail.anchorGuard } : out;
    if (opts.dryRun) {
      if (deps.strictFreshness) {
        try {
          requireFreshForecast(round, detail.lock, detail.forecast, new Date(now).toISOString());
        } catch (err) {
          return flagged({ kind: "skipped", roundId, reason: getErrorMessage(err) });
        }
      }
      return flagged({ kind: "dry-run", roundId, body });
    }
    // Model/retrieval work may take minutes. Admission time is not signing time.
    const signingTime = deps.now?.() ?? Date.now();
    if (Date.parse(round.lock_at) - signingTime < LOCK_MARGIN_MS) {
      return flagged({
        kind: "skipped",
        roundId,
        reason: `forecast finished too close to lock at ${round.lock_at}`,
      });
    }
    if (deps.strictFreshness) {
      try {
        detail.forecast = requireFreshForecast(
          round,
          detail.lock,
          detail.forecast,
          new Date(signingTime).toISOString(),
        );
      } catch (err) {
        return flagged({ kind: "skipped", roundId, reason: getErrorMessage(err) });
      }
    }
    const raw = Buffer.from(JSON.stringify(body));
    if (opts.replace && accepted && accepted.body === raw.toString("utf8")) {
      return flagged({ kind: "accepted", roundId, row: accepted, already: true });
    }
    if (raw.length > MAX_BODY_BYTES)
      return flagged({ kind: "skipped", roundId, reason: "body too large" });
    const meta: SignedMeta = {
      entrant: config.entrant,
      "key-id": config.keyId,
      "request-id": randomUUID(),
      timestamp: arenaTimestamp(new Date(signingTime)),
    };
    const signature = signRequest(meta, raw, config.audience, deps.key);
    const id = store.insertArenaSubmission({
      entrant: config.entrant,
      roundId,
      requestId: meta["request-id"],
      url: config.origin,
      meta: JSON.stringify({ ...meta, signature }),
      body: raw.toString("utf8"),
      detail: JSON.stringify({
        ...detail,
        startedAt: new Date(now).toISOString(),
        completedAt: new Date(signingTime).toISOString(),
        config: deps.forecasterConfig ?? { spec: config.forecaster },
      }),
    });
    row = store.latestArenaSubmission(config.entrant, roundId)!;
    if (row.id !== id) throw new Error("arena ledger write was not read back");
    return flagged(await send(deps, row));
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

/**
 * Rounds whose lock falls inside the filing window and (unless `includeAccepted`)
 * have no accepted submission. With `includeAccepted` (`submit due --replace`)
 * it also returns every OTHER open round whose accepted filing is anchored on
 * an older release than the arena's latest (`staleFilings`), whatever its lock:
 * a refresh only near the lock is one missed run away from a stale anchor.
 */
export async function dueRounds(
  deps: Pick<SubmitDeps, "config" | "data" | "store" | "now" | "anchorGuard">,
  opts: { includeAccepted?: boolean } = {},
): Promise<ArenaRound[]> {
  const now = deps.now?.() ?? Date.now();
  const horizon = now + deps.config.windowHours * 3_600_000;
  const open = (await deps.data.openRounds(now)).filter(
    (r) => Date.parse(r.lock_at) - now >= LOCK_MARGIN_MS,
  );
  const inWindow = open.filter(
    (r) =>
      Date.parse(r.lock_at) <= horizon &&
      (opts.includeAccepted ||
        !deps.store.acceptedArenaSubmission(deps.config.entrant, r.round_id)),
  );
  if (!opts.includeAccepted) return inWindow;
  const due = new Set(inWindow.map((r) => r.round_id));
  const stale = new Set(
    (
      await staleFilings(
        deps,
        open.filter((r) => !due.has(r.round_id)),
      )
    ).map((s) => s.round.round_id),
  );
  return open.filter((r) => due.has(r.round_id) || stale.has(r.round_id));
}

/**
 * Open rounds whose ACCEPTED filing is anchored on an older release than the
 * arena's latest value (`filedAnchorCheck`). Reads only; an unreadable
 * reference leaves the round out (the near-lock refresh still covers it).
 */
export async function staleFilings(
  deps: Pick<SubmitDeps, "config" | "data" | "store" | "anchorGuard">,
  rounds: readonly ArenaRound[],
): Promise<Array<{ round: ArenaRound; check: AnchorCheck }>> {
  if ((deps.anchorGuard ?? anchorGuardModeFromEnv()) === "off") return [];
  const out: Array<{ round: ArenaRound; check: AnchorCheck }> = [];
  for (const round of rounds) {
    if (!anchorIds(round).length) continue;
    const accepted = deps.store.acceptedArenaSubmission(deps.config.entrant, round.round_id);
    if (!accepted) continue;
    const { reference } = await referenceFor(deps.data, round);
    const check = filedAnchorCheck(round, accepted, reference);
    if (check?.stale) out.push({ round, check });
  }
  return out;
}
