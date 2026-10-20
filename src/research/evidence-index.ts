// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { ResearchBrief } from "../arena/research/briefs";
import type { CapturedSource } from "./evidence";
import {
  availableInstant,
  type EvidenceEligibility,
  type Measurement,
  measurementEligibility,
  measurementKey,
  normalizeIdentity,
} from "./measurement";

export interface EvidenceClaim {
  id: string;
  text: string;
  urls: string[];
  origins: string[];
  eligibility: EvidenceEligibility;
  reason: string;
  publishedAt?: string;
  measurement?: Measurement;
}

export interface EvidenceIndex {
  version: 1;
  claims: EvidenceClaim[];
  /** Content identity excludes capture time and mirrors, includes measurement vintages. */
  fingerprint: string;
  stats: {
    inputLines: number;
    uniqueClaims: number;
    duplicates: number;
    target: number;
    change: number;
    background: number;
    rejected: number;
    independentOrigins: number;
    dated: number;
  };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const urlsIn = (text: string) => [
  ...new Set([...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!)),
];
const rank: Record<EvidenceEligibility, number> = {
  target: 3,
  change: 2,
  background: 1,
  rejected: 0,
};

/** Conservative text dedupe: only list formatting and citation labels disappear.
 * Paraphrases stay separate unless a structured adapter establishes the same measurement.
 */
export function claimTextKey(text: string): string {
  return normalizeIdentity(
    text
      .replace(/\[[^\]]*\]\(https?:\/\/[^)]+\)/g, "")
      .replace(/^\[verified\]\s*/i, "")
      .replace(/^\[authoritative\]\s*/i, "")
      .replace(/^[\s>*]+/, "")
      .replace(/^[-•]\s+/, ""),
  );
}

export function indexEvidence(
  brief: ResearchBrief,
  verified: string,
  sources: CapturedSource[],
  cutoff: string,
): EvidenceIndex {
  const byUrl = new Map(sources.map((s) => [s.url, s]));
  const unique = new Map<string, EvidenceClaim>();
  const lines = verified.split("\n").filter((l) => l.trim());
  const add = (key: string, claim: Omit<EvidenceClaim, "id">) => {
    const id = hash(key);
    const previous = unique.get(id);
    if (!previous) unique.set(id, { id, ...claim });
    else {
      previous.urls = [...new Set([...previous.urls, ...claim.urls])].sort();
      previous.origins = [...new Set([...previous.origins, ...claim.origins])].sort();
      // Duplicate text cannot upgrade unknown provenance to an eligible measurement.
      if (rank[claim.eligibility] < rank[previous.eligibility]) {
        previous.eligibility = claim.eligibility;
        previous.reason = claim.reason;
      }
    }
  };
  for (const text of lines) {
    const urls = urlsIn(text);
    const referenced = urls.map((url) => byUrl.get(url));
    // A typed observation and its verbatim report citation are one fact. Keeping
    // the raw copy could also reintroduce a rejected measurement as background.
    if (
      referenced.some((source) =>
        source?.measurements?.some(
          (m) => m.url === source.url && claimTextKey(text) === claimTextKey(m.quote),
        ),
      )
    )
      continue;
    const valid = referenced.length > 0 && referenced.every((s) => s && !s.error);
    const dated =
      valid &&
      referenced.every((s) => {
        const at = availableInstant(s!.availableAt ?? s!.published);
        return at !== undefined && at <= Date.parse(cutoff);
      });
    add(claimTextKey(text), {
      text,
      urls,
      origins: [...new Set(referenced.flatMap((s) => (s ? [s.origin ?? s.url] : [])))],
      eligibility: valid ? "background" : "rejected",
      reason: dated
        ? "provenance checked; measurement identity unstructured"
        : "publication or measurement identity unknown",
      ...(dated
        ? {
            publishedAt: referenced
              .map((s) => s!.availableAt ?? s!.published!)
              .sort()
              .at(-1)!,
          }
        : {}),
    });
  }
  let measurements = 0;
  for (const source of sources) {
    if (source.error) continue;
    for (const m of source.measurements ?? []) {
      measurements++;
      const result =
        m.url !== source.url
          ? {
              eligibility: "rejected" as const,
              reason: "measurement URL does not match captured source",
            }
          : measurementEligibility(m, brief.target, {
              cutoff,
              since: brief.since,
              text: source.text,
              capturedAt: source.capturedAt,
              archived: source.temporal === "archive",
            });
      add(measurementKey(m), {
        text: `${m.quote} [${m.source}](${m.url})`,
        urls: [m.url],
        origins: [m.origin ?? source.origin ?? m.url],
        ...result,
        measurement: m,
        ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
      });
    }
  }
  const claims = [...unique.values()];
  return summarizeIndex(claims, lines.length + measurements);
}

function summarizeIndex(claims: EvidenceClaim[], inputLines: number): EvidenceIndex {
  const usable = claims.filter((c) => c.eligibility !== "rejected");
  const stats = {
    inputLines,
    uniqueClaims: claims.length,
    duplicates: inputLines - claims.length,
    target: 0,
    change: 0,
    background: 0,
    rejected: 0,
    independentOrigins: new Set(usable.flatMap((c) => c.origins)).size,
    dated: usable.filter((c) => c.publishedAt).length,
  };
  for (const claim of claims) stats[claim.eligibility]++;
  return {
    version: 1,
    claims,
    fingerprint: hash(usable.map((c) => [c.id, c.eligibility]).sort()),
    stats,
  };
}

/** Preserve evidence from every independent research path and follow-up. */
export function mergeEvidenceIndexes(
  indexes: Array<EvidenceIndex | undefined>,
): EvidenceIndex | undefined {
  const known = indexes.filter((i): i is EvidenceIndex => i !== undefined);
  if (!known.length) return undefined;
  const claims = new Map<string, EvidenceClaim>();
  for (const index of known)
    for (const claim of index.claims) {
      const previous = claims.get(claim.id);
      const chosen =
        previous && rank[previous.eligibility] < rank[claim.eligibility] ? previous : claim;
      claims.set(claim.id, {
        ...chosen,
        urls: [...new Set([...(previous?.urls ?? []), ...claim.urls])].sort(),
        origins: [...new Set([...(previous?.origins ?? []), ...claim.origins])].sort(),
      });
    }
  return summarizeIndex(
    [...claims.values()],
    known.reduce((sum, i) => sum + i.stats.inputLines, 0),
  );
}

/** Whole claims, balanced across origins. Never cut a citation in half or let the first
 * large page consume the entire review window. Text remains untrusted evidence.
 */
export function selectEvidence(
  index: EvidenceIndex,
  brief: ResearchBrief,
  maxChars = brief.maxChars ?? 24_000,
  annotate = false,
): string {
  const terms =
    (brief.target?.terms ?? brief.queries ?? [])
      .join(" ")
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) ?? [];
  const score = (c: EvidenceClaim) =>
    rank[c.eligibility] * 100 +
    Number(!!c.publishedAt) * 5 +
    [...new Set(terms)].filter((t) => c.text.toLowerCase().includes(t)).length;
  const pending = index.claims
    .filter((c) => c.eligibility !== "rejected")
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const seen = new Map<string, number>();
  const output: string[] = [];
  let used = 0;
  while (pending.length) {
    pending.sort(
      (a, b) =>
        score(b) -
        (seen.get(b.origins[0] ?? "") ?? 0) * 10 -
        (score(a) - (seen.get(a.origins[0] ?? "") ?? 0) * 10),
    );
    const c = pending.shift()!;
    const line = annotate ? `[${c.eligibility}: ${c.reason}] ${c.text}` : c.text;
    if (used + line.length + 1 > maxChars) continue;
    output.push(line);
    used += line.length + 1;
    const origin = c.origins[0] ?? "";
    seen.set(origin, (seen.get(origin) ?? 0) + 1);
  }
  return output.join("\n");
}

export function evidenceChanges(previous: EvidenceIndex, next: EvidenceIndex) {
  const old = new Set(previous.claims.filter((c) => c.eligibility !== "rejected").map((c) => c.id));
  const added = next.claims.filter((c) => c.eligibility !== "rejected" && !old.has(c.id));
  return {
    changed: previous.fingerprint !== next.fingerprint,
    added: added.map((c) => c.id),
    eligibleUpdates: added.filter((c) => c.eligibility === "target" || c.eligibility === "change")
      .length,
  };
}
