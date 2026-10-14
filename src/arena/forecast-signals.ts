// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed signals: what a forecast's evidence said, as data rather than prose,
 * so later learned weights can be fitted per signal type (which kinds of
 * evidence moved the outcome, and by how much).
 *
 *   from members   an `unanchored` formation asks every member to list, per
 *                  cited source or data point, its direction, signed size in
 *                  the question's unit and dates (`SIGNALS_REQUEST`)
 *   from research  the research dossier's typed measurements (target / change
 *                  claims with a value, unit and dates) — mechanical, no model
 *
 * A signal is `stale` when what it observed predates the start reading: the
 * start already contains it, so it is background, not news. Pure functions.
 */

import type { EvidenceIndex } from "../research/evidence-index";

export interface ForecastSignal {
  /** Short description of the claim or series. */
  claim: string;
  direction?: "up" | "down" | "flat";
  /** Signed size in `unit` (the question's unit for member signals). */
  magnitude?: number;
  /** A measured level (research signals). */
  value?: number;
  unit?: string;
  /** Last date the signal observed (YYYY-MM-DD). */
  observed?: string;
  /** When its source published it (YYYY-MM-DD). */
  sourceDate?: string;
  /** Observed before the start reading: background, not news. */
  stale: boolean;
  /** Where it came from: a member (`<stage>:<member>`) or `research:<eligibility>`. */
  origin: string;
  url?: string;
}

/** Appended to an unanchored member's reply contract. */
export const SIGNALS_REQUEST =
  'Add to that JSON object a "signals" array, one entry per cited source or data point you relied on (empty if none): {"claim": "<short>", "direction": "up" | "down" | "flat", "magnitude": <signed change it implies, in the question\'s unit>, "unit": "<unit>", "observed": "YYYY-MM-DD", "source_date": "YYYY-MM-DD"}.';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (x: unknown) =>
  typeof x === "string" && DAY.test(x.slice(0, 10)) ? x.slice(0, 10) : undefined;
const text = (x: unknown, n = 160) =>
  typeof x === "string" && x.trim() ? x.trim().slice(0, n) : undefined;

function staleOf(observed: string | undefined, sourceDate: string | undefined, startDate?: string) {
  const at = observed ?? sourceDate;
  return Boolean(startDate && at && at < startDate);
}

/** Validated member signals from recorded protocol steps (unknown shapes dropped). */
export function memberSignals(
  steps: Array<{ stage: string; member: string; status: string; reply?: Record<string, unknown> }>,
  startDate?: string,
  limit = 40,
): ForecastSignal[] {
  const out: ForecastSignal[] = [];
  for (const s of steps) {
    const list = s.status === "ok" ? s.reply?.signals : undefined;
    if (!Array.isArray(list)) continue;
    for (const raw of list.slice(0, 12)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const claim = text(r.claim);
      if (!claim) continue;
      const dir =
        r.direction === "up" || r.direction === "down" || r.direction === "flat"
          ? r.direction
          : undefined;
      const mag =
        typeof r.magnitude === "number" && Number.isFinite(r.magnitude) ? r.magnitude : undefined;
      const observed = day(r.observed);
      const sourceDate = day(r.source_date);
      const unit = text(r.unit, 40);
      out.push({
        claim,
        ...(dir ? { direction: dir } : {}),
        ...(mag !== undefined ? { magnitude: mag } : {}),
        ...(unit ? { unit } : {}),
        ...(observed ? { observed } : {}),
        ...(sourceDate ? { sourceDate } : {}),
        stale: staleOf(observed, sourceDate, startDate),
        origin: `${s.stage}:${s.member}`,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** The research dossier's typed measurements as signals (target / change claims only). */
export function researchSignals(
  index: EvidenceIndex | undefined,
  verified: string,
  startDate?: string,
  limit = 12,
): ForecastSignal[] {
  const out: ForecastSignal[] = [];
  for (const c of index?.claims ?? []) {
    const m = c.measurement;
    if (!m || (c.eligibility !== "target" && c.eligibility !== "change")) continue;
    if (!verified.includes(c.text)) continue;
    const observed = day(m.observedThrough ?? m.observedFrom);
    const sourceDate = day(m.publishedAt ?? c.publishedAt);
    out.push({
      claim: [m.source, m.measure, m.subgroup].filter(Boolean).join(" / ").slice(0, 160),
      value: m.value,
      ...(m.unit ? { unit: m.unit } : {}),
      ...(observed ? { observed } : {}),
      ...(sourceDate ? { sourceDate } : {}),
      stale: staleOf(observed, sourceDate, startDate),
      origin: `research:${c.eligibility}`,
      url: m.url,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** One line per signal, for a briefing or a handoff. */
export function signalLines(signals: ForecastSignal[]): string {
  return signals
    .map((s) => {
      const size =
        s.magnitude !== undefined
          ? ` ${s.direction ?? ""} ${s.magnitude}${s.unit ? ` ${s.unit}` : ""}`
          : s.value !== undefined
            ? ` = ${s.value}${s.unit ? ` ${s.unit}` : ""}`
            : s.direction
              ? ` ${s.direction}`
              : "";
      const dates = [
        s.observed ? `observed ${s.observed}` : "",
        s.sourceDate ? `published ${s.sourceDate}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${s.stale ? "STALE " : ""}${s.claim}:${size}${dates ? ` (${dates})` : ""} [${s.origin}]`;
    })
    .join("\n");
}
