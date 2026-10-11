// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Identity and availability are data contracts, never a judge's confidence. */
export interface MeasurementIdentity {
  measure: string;
  population?: string;
  response?: string;
  subgroup?: string;
  unit?: string;
}

export interface EvidenceTarget extends MeasurementIdentity {
  /** Series/provider identity. Different pollsters can explain changes, not replace levels. */
  source?: string;
  cells?: string[];
  terms?: string[];
}

export interface Measurement extends MeasurementIdentity {
  value: number;
  source: string;
  url: string;
  /** Exact source passage, checked against captured bytes. */
  quote: string;
  observedFrom?: string;
  observedThrough?: string;
  publishedAt?: string;
  availableAt?: string;
  /** Canonical primary-source URL when established by a structured adapter. */
  origin?: string;
  /** Explicitly declared explanatory series; never inferred from a matching number. */
  relation?: "explanatory";
}

export type EvidenceEligibility = "target" | "change" | "background" | "rejected";
export const normalizeIdentity = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const fields = ["measure", "population", "response", "subgroup", "unit"] as const;

/** A day-only availability is known by END of day, never assumed known at midnight. */
export function availableInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
    return undefined;
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day)
    return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function measurementEligibility(
  m: Measurement,
  target: EvidenceTarget | undefined,
  window: { cutoff: string; since?: string; text: string; capturedAt: string; archived: boolean },
): { eligibility: EvidenceEligibility; reason: string } {
  const cutoff = Date.parse(window.cutoff);
  const normQuote = normalizeIdentity(m.quote);
  if (
    !Number.isFinite(m.value) ||
    !normQuote ||
    !normalizeIdentity(window.text).includes(normQuote)
  )
    return { eligibility: "rejected", reason: "measurement has no matching captured passage" };
  const numbers = [
    ...m.quote.replace(/−/g, "-").matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?/g),
  ].map((n) => Number(n[0].replace(/,/g, "")));
  if (!numbers.includes(m.value))
    return { eligibility: "rejected", reason: "measurement value absent from quoted passage" };
  const dates = [m.publishedAt, m.availableAt, m.observedFrom, m.observedThrough];
  if (!Number.isFinite(cutoff) || dates.some((d) => d && availableInstant(d) === undefined))
    return { eligibility: "rejected", reason: "invalid measurement date" };
  if ([m.publishedAt, m.availableAt].some((d) => d && availableInstant(d)! > cutoff))
    return { eligibility: "rejected", reason: "publication or vintage after cutoff" };
  // Observation dates describe the survey, never when it became public.
  if ([m.observedFrom, m.observedThrough].some((d) => d && Date.parse(d) > cutoff))
    return { eligibility: "rejected", reason: "observation after cutoff" };
  if (
    m.observedFrom &&
    m.observedThrough &&
    Date.parse(m.observedFrom) > Date.parse(m.observedThrough)
  )
    return { eligibility: "rejected", reason: "inverted observation period" };
  if (!window.archived && Date.parse(window.capturedAt) > cutoff && !m.availableAt)
    return {
      eligibility: "background",
      reason: "live capture does not establish historical availability",
    };
  const knownAt = Math.max(
    availableInstant(m.publishedAt) ?? -Infinity,
    availableInstant(m.availableAt) ?? -Infinity,
  );
  if (!Number.isFinite(knownAt))
    return { eligibility: "background", reason: "publication and vintage unknown" };
  if (!target) return { eligibility: "background", reason: "target identity unspecified" };
  const missing = fields.filter((f) => target[f] !== undefined && m[f] === undefined);
  const mismatch = fields.filter(
    (f) =>
      target[f] !== undefined &&
      m[f] !== undefined &&
      normalizeIdentity(target[f]!) !== normalizeIdentity(m[f]!),
  );
  if (missing.length && m.relation !== "explanatory")
    return { eligibility: "background", reason: `unknown ${missing.join(", ")}` };
  if (mismatch.length && m.relation !== "explanatory")
    return { eligibility: "background", reason: `different ${mismatch.join(", ")}` };
  if (target.cells?.length && (!m.subgroup || !target.cells.includes(m.subgroup)))
    return { eligibility: "background", reason: "cell outside target profile" };
  if (window.since && knownAt <= Date.parse(window.since))
    return { eligibility: "background", reason: "already available at anchor" };
  const observed = m.observedThrough ?? m.observedFrom;
  if (
    window.since &&
    observed &&
    Date.parse(observed) <= Date.parse(window.since) &&
    m.relation !== "explanatory"
  )
    return {
      eligibility: "background",
      reason: "anchor or older observation; new publication alone is not a new measurement",
    };
  if (
    m.relation === "explanatory" ||
    (target.source && normalizeIdentity(target.source) !== normalizeIdentity(m.source))
  )
    return { eligibility: "change", reason: "related source; changes only" };
  return { eligibility: "target", reason: "matching identity and dated availability" };
}

/** Same observation from a mirror is one claim. Revisions retain their vintage. */
export function measurementKey(m: Measurement): string {
  return JSON.stringify([
    ...fields.map((f) => (m[f] === undefined ? null : normalizeIdentity(m[f]!))),
    normalizeIdentity(m.source),
    m.value,
    m.observedFrom ?? null,
    m.observedThrough ?? null,
    m.availableAt ?? m.publishedAt ?? null,
  ]);
}
