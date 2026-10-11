// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { ArenaData } from "./data";
import type { RoundForecast } from "./forecast";
import { auditForecastFreshness } from "./freshness";
import type { ArenaLock, ArenaRound } from "./types";

function object(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function roundHealth(
  round: ArenaRound,
  store: ArenaStore,
  entrant: string,
  now = Date.now(),
) {
  const accepted = store.acceptedArenaSubmission(entrant, round.round_id);
  const events = store.listArenaAttempts({ entrant, roundId: round.round_id, limit: 2 });
  const attempt = events[0];
  const details = object(accepted?.detail ?? "{}");
  const attemptDetail = object(attempt?.detail ?? "{}");
  const config = details.config as { fingerprint?: string; spec?: string } | undefined;
  const cutoff = new Date(Math.min(now, Date.parse(round.lock_at))).toISOString();
  const freshness = (() => {
    if (!details.lock || !details.forecast) return undefined;
    try {
      return auditForecastFreshness(
        round,
        details.lock as ArenaLock,
        details.forecast as RoundForecast,
        cutoff,
      );
    } catch (error) {
      return {
        ok: false,
        issues: [`Stored input trace is not auditable: ${getErrorMessage(error)}`],
      };
    }
  })();
  const forecast = details.forecast as
    | {
        fallback?: string;
        rounds?: { status: string }[];
        dossier?: {
          status?: string;
          error?: string;
          researchLoop?: { costFinal?: boolean };
          evidence?: { capturedAt: string; index?: { fingerprint: string } };
        };
      }
    | undefined;
  const incomplete =
    !!forecast?.fallback ||
    (forecast?.rounds !== undefined &&
      (!Array.isArray(forecast.rounds) || forecast.rounds.some((r) => r?.status !== "ok"))) ||
    forecast?.dossier?.status === "failed" ||
    !!forecast?.dossier?.error ||
    forecast?.dossier?.researchLoop?.costFinal === false;
  const lockInHours = (Date.parse(round.lock_at) - now) / 3_600_000;
  return {
    roundId: round.round_id,
    lockAt: round.lock_at,
    lockInHours,
    state: !accepted
      ? "unfiled"
      : freshness?.ok === false
        ? "stale"
        : incomplete
          ? "degraded"
          : "accepted",
    accepted: accepted
      ? {
          id: accepted.id,
          at: new Date(accepted.updated_at).toISOString(),
          ageHours: (now - accepted.updated_at) / 3_600_000,
          strategy: typeof config?.spec === "string" ? config.spec : undefined,
          fingerprint: typeof config?.fingerprint === "string" ? config.fingerprint : undefined,
          evidenceCapturedAt: forecast?.dossier?.evidence?.capturedAt,
          evidenceFingerprint: forecast?.dossier?.evidence?.index?.fingerprint,
        }
      : undefined,
    freshness: freshness ?? {
      ok: undefined,
      issues: ["legacy submission has no auditable input dates"],
    },
    lastAttempt: attempt
      ? {
          id: attempt.attempt_id,
          at: new Date(attempt.created_at).toISOString(),
          status: attempt.status,
          unfinished: attempt.phase === "started",
          reason: typeof attemptDetail.reason === "string" ? attemptDetail.reason : undefined,
          budget: attemptDetail.budget,
        }
      : undefined,
  };
}

/** Read-only; includes recent locked rounds so missed refreshes do not disappear. */
export async function arenaHealth(
  data: ArenaData,
  store: ArenaStore,
  entrant: string,
  now = Date.now(),
) {
  const rounds = new Map((await data.openRounds(now)).map((r) => [r.round_id, r]));
  const recent = store
    .listArenaSubmissions({ entrant, limit: 100 })
    .filter((r) => r.created_at >= now - 7 * 86_400_000);
  const attempts = store
    .listArenaAttempts({ entrant, limit: 100 })
    .filter((r) => r.created_at >= now - 7 * 86_400_000);
  const ids = [...new Set([...recent, ...attempts].map((r) => r.round_id))].filter(
    (id) => !rounds.has(id),
  );
  const loaded = await Promise.allSettled(ids.map((id) => data.round(id)));
  const warnings: string[] = [];
  loaded.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value)
      rounds.set(result.value.round_id, result.value);
    else warnings.push(`round metadata unavailable: ${ids[i]}`);
  });
  return {
    asOf: new Date(now).toISOString(),
    warnings,
    rounds: [...rounds.values()]
      .sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at))
      .map((round) => roundHealth(round, store, entrant, now)),
  };
}

export function formatArenaHealth(health: Awaited<ReturnType<typeof arenaHealth>>): string {
  return [
    "Arena submission health",
    ...health.warnings,
    ...health.rounds.map(
      (r) =>
        `${r.roundId}: ${r.state}; lock ${r.lockAt}\n  accepted ${r.accepted ? `#${r.accepted.id} ${r.accepted.at}; strategy ${r.accepted.strategy ?? "unknown"}; version ${r.accepted.fingerprint?.slice(0, 12) ?? "unknown"}` : "none"}\n  refresh ${r.lastAttempt ? `${r.lastAttempt.status} at ${r.lastAttempt.at}${r.lastAttempt.reason ? `: ${r.lastAttempt.reason}` : ""}` : "not recorded"}${r.freshness.issues.length ? `\n  inputs: ${r.freshness.issues.join("; ")}` : ""}`,
    ),
  ].join("\n");
}
