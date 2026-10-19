// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Settling the arena entry on the one outcome path (`src/outcomes/`): every
 * accepted filing the arena has resolved becomes one outcome, whichever way it
 * was filed (the server's autopilot or the operator CLI), so the entry teaches
 * the rest of Marina — lessons, forecast history and per-(family, method)
 * evidence. Idempotent: an answer is filed once and settled once.
 *
 *   number    filed as a `number` forecast answer and resolved through
 *             `resolveFiled` (CRPS) — the same scorer every board uses
 *   profile   one mechanical outcome: the arena's energy score of the filed
 *   ranking   profile / the rank-biased overlap loss of the filed list
 *             (`score-shapes.ts`, the arena's own scorers), with skill against
 *             the arena's recorded persistence loss for the round
 *
 * The scored version is the newest accepted filing — the one the arena
 * scores. Every outcome names the round's family (its tracker) and the method
 * that produced it (the route spec in the filing's notes), so evidence can be
 * read per family and method. `resolvedAt` is when the arena published the
 * resolution (when the truth became public), else now.
 */

import { logRejection } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { ArenaConfig } from "./config";
import type { ArenaData } from "./data";
import type { ArenaRound, Distribution } from "./types";

const logger = new Logger();

type Settler = Pick<
  MarinaDB,
  | "acceptedArenaSubmission"
  | "getForecastAnswerByExternalId"
  | "getOutcomeBySubject"
  | "saveForecastAnswer"
  | "getForecastAnswer"
  | "resolveForecastAnswer"
  | "recordOutcomeRow"
  | "linkDecisionOutcome"
>;

/** The arena's persistence null: last value, sd 1.5 (see `forecast.ts`). */
const PERSISTENCE_SD = 1.5;

export interface ArenaMethod {
  /** The full route spec as filed (`formation:delphi:<models>+research@…`, `nowcast`, …). */
  method: string;
  /** Its kind, the evidence key: `formation:delphi`, `nowcast`, `research`, `baseline`, … */
  methodKind: string;
}

/**
 * The method that produced a filing, from its notes: `route <family> → <spec>; …`
 * (every routed filing), else the forecaster the note names.
 */
export function arenaMethod(notes: string | undefined): ArenaMethod {
  const text = (notes ?? "").trim();
  const routed = /^route\s+\S+\s+→\s+([^;]+)/.exec(text);
  const method = routed
    ? routed[1]!.trim()
    : text.startsWith("marina research agent")
      ? "research"
      : text.startsWith("marina-baseline")
        ? // Before routing, the nowcast named itself in the baseline's note.
          /daily nowcast/.test(text)
          ? "nowcast"
          : "baseline"
        : "unknown";
  const head = method.split("+")[0]!;
  const parts = head.split(":");
  const methodKind =
    (parts[0] === "formation" && parts[1]) ||
    (parts[0] === "research" && parts[1] === "wiki-events")
      ? `${parts[0]}:${parts[1]}`
      : (parts[0] ?? "unknown");
  return { method, methodKind: methodKind || "unknown" };
}

function publishedAt(resolution: { resolved_at?: unknown } | undefined, now: number): number {
  const at =
    typeof resolution?.resolved_at === "string" ? Date.parse(resolution.resolved_at) : Number.NaN;
  return Number.isFinite(at) && at <= now ? at : now;
}

export interface SettleReport {
  /** Outcomes recorded by this pass. */
  settled: number;
  /** Per shape. */
  number: number;
  profile: number;
  ranking: number;
  /** Resolved rounds with an accepted filing that could not be scored (reasons). */
  unscored: Array<{ roundId: string; reason: string }>;
}

type SiteRound = Awaited<ReturnType<ArenaData["siteRounds"]>>[number] & {
  resolution?: { outcome?: unknown; resolved_at?: unknown };
};

/**
 * Settle every resolved round Marina filed. Never throws for one round: a
 * round that cannot be scored is reported in `unscored` and retried next pass.
 */
export async function settleArenaFilings(
  db: Settler,
  deps: { config: Pick<ArenaConfig, "entrant">; data: ArenaData },
  opts: { now?: number; onSettled?: (row: { roundId: string; answerId?: number }) => void } = {},
): Promise<SettleReport> {
  const now = opts.now ?? Date.now();
  const entrant = deps.config.entrant;
  const owner = `marina:arena/${entrant}`;
  const report: SettleReport = { settled: 0, number: 0, profile: 0, ranking: 0, unscored: [] };
  const [resolved, rounds] = await Promise.all([deps.data.resolutions(), deps.data.rounds()]);
  const byId = new Map(rounds.map((r) => [r.round_id, r]));

  // Numbers: resolutions/resolved.json carries every resolved scalar round.
  for (const [roundId, resolution] of Object.entries(resolved)) {
    const value = resolution?.value;
    if (typeof value !== "number") continue;
    const row = db.acceptedArenaSubmission(entrant, roundId);
    if (!row) continue;
    const externalId = `arena:${roundId}`;
    const filed = db.getForecastAnswerByExternalId(owner, externalId);
    if (filed?.resolved_at != null) {
      opts.onSettled?.({ roundId, answerId: filed.id });
      continue;
    }
    const round = byId.get(roundId) ?? (await deps.data.round(roundId));
    const body = JSON.parse(row.body) as { topline?: Distribution; notes?: string };
    if (!round || !body.topline || !(body.topline.sd > 0)) {
      report.unscored.push({ roundId, reason: "no topline or round" });
      continue;
    }
    const { fileAnswer, resolveFiled } = await import("../outcomes/filing");
    const method = arenaMethod(body.notes);
    if (!filed) {
      const persistence = await persistenceOf(deps.data, roundId);
      fileAnswer(
        db as MarinaDB,
        {
          question: round.question,
          kind: "number",
          mean: body.topline.mean,
          sd: body.topline.sd,
          answer: {
            roundId,
            submissionId: row.id,
            topline: body.topline,
            family: round.tracker,
            ...method,
            ...(persistence !== undefined
              ? { persistence: { mean: persistence, sd: PERSISTENCE_SD } }
              : {}),
          },
        },
        { owner, source: "arena", externalId, evalMode: "live" },
      );
    }
    const r = resolveFiled(
      db as MarinaDB,
      owner,
      externalId,
      { value },
      publishedAt(resolution, now),
      refsFor(entrant, round, method),
    );
    if (r && typeof r === "object") {
      report.settled++;
      report.number++;
    } else if (r === undefined) {
      report.unscored.push({ roundId, reason: "not scorable against the resolution" });
    }
    const answer = db.getForecastAnswerByExternalId(owner, externalId);
    if (answer) opts.onSettled?.({ roundId, answerId: answer.id });
  }

  // Profiles and rankings: the outcome lives in the arena's site data only.
  const shaped = rounds.filter(
    (r) =>
      (r.target_type === "profile_energy" || r.target_type === "ranking_list") &&
      Date.parse(r.lock_at) <= now &&
      !db.getOutcomeBySubject(shapeSubject(entrant, r.round_id)) &&
      db.acceptedArenaSubmission(entrant, r.round_id),
  );
  if (shaped.length === 0) return report;
  const site = (await deps.data.siteRounds().catch(
    logRejection(logger, "arena", "arena site rounds unavailable", {
      level: "debug",
      fallback: [],
    }),
  )) as SiteRound[];
  const siteById = new Map((Array.isArray(site) ? site : []).map((r) => [r.round_id, r]));
  const { recordResolved } = await import("../outcomes/record");
  for (const round of shaped) {
    const published = siteById.get(round.round_id);
    if (published?.status !== "resolved") continue;
    const row = db.acceptedArenaSubmission(entrant, round.round_id)!;
    const body = JSON.parse(row.body) as {
      profile?: Record<string, Distribution>;
      ranking?: string[];
      notes?: string;
    };
    const scored = await scoreShape(round, published, body);
    if ("reason" in scored) {
      report.unscored.push({ roundId: round.round_id, reason: scored.reason });
      continue;
    }
    const method = arenaMethod(body.notes);
    const recorded = recordResolved(db as MarinaDB, {
      subject: shapeSubject(entrant, round.round_id),
      kind: "forecast",
      source: `arena:${scored.shape}`,
      domain: "forecast",
      owner,
      succeeded: scored.skill > 0,
      ...(scored.quality !== undefined ? { quality: scored.quality } : {}),
      loss: scored.loss,
      metric: scored.metric,
      truth: scored.truth,
      detail: `${scored.metric} ${scored.loss.toFixed(3)} vs persistence ${scored.persistenceLoss.toFixed(3)} (skill ${scored.skill >= 0 ? "+" : ""}${scored.skill.toFixed(3)}); family ${round.tracker}; method ${method.method}`,
      basis: "mechanical",
      evalMode: "live",
      refs: [
        `arena:${round.round_id}`,
        `arena-submission:${row.id}`,
        ...refsFor(entrant, round, method),
      ],
      resolvedAt: publishedAt(published.resolution, now),
    });
    if (recorded.created) {
      report.settled++;
      report[scored.shape]++;
    }
    opts.onSettled?.({ roundId: round.round_id });
  }
  return report;
}

/** The subject of a profile or ranking round's outcome. */
export function shapeSubject(entrant: string, roundId: string): string {
  return `arena:${entrant}:${roundId}`;
}

function refsFor(entrant: string, round: ArenaRound, method: ArenaMethod): string[] {
  return [`arena-entrant:${entrant}`, `family:${round.tracker}`, `method:${method.methodKind}`];
}

/** The arena's persistence mean for a scalar round (its frozen history's last value). */
async function persistenceOf(data: ArenaData, roundId: string): Promise<number | undefined> {
  const lock = await data
    .lock(roundId)
    .catch(logRejection(logger, "arena", "arena round lock unavailable", { level: "debug" }));
  const last = (lock?.answer_history ?? lock?.history ?? []).at(-1)?.value;
  return typeof last === "number" && Number.isFinite(last) ? last : undefined;
}

type ShapeScore =
  | {
      shape: "profile" | "ranking";
      loss: number;
      persistenceLoss: number;
      skill: number;
      quality?: number;
      metric: string;
      truth: unknown;
    }
  | { reason: string };

/** Score a filed profile / ranking the way the arena does (`score-shapes.ts`). */
async function scoreShape(
  round: ArenaRound,
  published: SiteRound,
  body: { profile?: Record<string, Distribution>; ranking?: string[] },
): Promise<ShapeScore> {
  const { profileEnergy, rboLoss } = await import("./score-shapes");
  const outcome = published.resolution?.outcome;
  if (round.target_type === "ranking_list") {
    const persistence = published.scores?.persistence?.loss;
    if (!Array.isArray(outcome) || !outcome.every((s) => typeof s === "string"))
      return { reason: "no published ranking outcome" };
    if (typeof persistence !== "number") return { reason: "no persistence loss" };
    if (!body.ranking?.length) return { reason: "filing carries no ranking" };
    const spec = round.ranking as { length?: number; rbo_p?: number } | undefined;
    const loss = rboLoss(body.ranking, outcome, spec?.rbo_p ?? 0.9, spec?.length);
    return {
      shape: "ranking",
      loss,
      persistenceLoss: persistence,
      skill: persistence === 0 ? 0 : 1 - loss / persistence,
      // Rank-biased overlap itself: 1 = the published list exactly.
      quality: Math.min(1, Math.max(0, 1 - loss)),
      metric: "rbo-loss",
      truth: { options: outcome },
    };
  }
  const persistence = published.scores?.persistence?.energy;
  const cells = round.cells ?? [];
  const values = outcome as Record<string, unknown> | undefined;
  if (!values || typeof values !== "object") return { reason: "no published profile outcome" };
  if (!(typeof persistence === "number" && persistence > 0))
    return { reason: "no persistence energy" };
  if (!body.profile || cells.length === 0) return { reason: "filing carries no profile" };
  if (!cells.every((c) => body.profile![c] && typeof values[c] === "number"))
    return { reason: "profile cells do not match the outcome" };
  const loss = profileEnergy(body.profile, values as Record<string, number>, cells);
  return {
    shape: "profile",
    loss,
    persistenceLoss: persistence,
    skill: 1 - loss / persistence,
    metric: "energy",
    truth: { value: values },
  };
}
