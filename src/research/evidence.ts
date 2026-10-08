// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Portable evidence captured once, verified against those bytes, and replayed without I/O. */
import { createHash } from "node:crypto";
import type { ResearchBrief } from "../arena/research/briefs";
import type { ResearchReport, Retriever, Source } from "../arena/research/retrieve";
import { fetchAllowed, type PageText, verifyDossier } from "../arena/research/verify";
import { getErrorMessage } from "../engine/errors";

export const evidenceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface CapturedSource extends Omit<Source, "text"> {
  text: string;
  textHash: string;
  capturedAt: string;
  temporal: "archive" | "live" | "rejected";
  error?: string;
}

export interface EvidenceSnapshot {
  version: 1;
  brief: ResearchBrief;
  capturedAt: string;
  /** Publication bound, distinct from the time the bytes were read. */
  cutoff: string;
  sources: CapturedSource[];
  report: string;
  verified: string;
  stats: Record<string, number>;
  warnings: string[];
  hash: string;
}

export function citedUrls(text: string): string[] {
  return [...new Set([...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!))];
}

/** A day precision publication may precede an intraday bound, but is not proof of its time. */
function afterCutoff(value: string | undefined, cutoff: string): boolean {
  if (!value) return false;
  return !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.parse(cutoff);
}

export async function captureEvidence(
  brief: ResearchBrief,
  report: ResearchReport,
  pageText: PageText,
  opts: { archived?: boolean; now?: () => Date; signal?: AbortSignal } = {},
): Promise<EvidenceSnapshot> {
  const now = opts.now ?? (() => new Date());
  const cutoff = brief.untilAt ?? (brief.until ? `${brief.until}T00:00:00Z` : now().toISOString());
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("invalid evidence cutoff");
  const urls = [...new Set([...report.sources.map((s) => s.url), ...citedUrls(report.report)])];
  const warnings = [...(report.warnings ?? [])];
  const sources: CapturedSource[] = [];
  // A bounded page set. The retriever normally already supplies the page text.
  for (const url of urls.slice(0, 64)) {
    opts.signal?.throwIfAborted();
    const source = report.sources.find((s) => s.url === url) ?? { url };
    const { text: provided, ...metadata } = source;
    let text = "";
    let error: string | undefined;
    if (!fetchAllowed(url)) error = "source is not readable under the source policy";
    else if (afterCutoff(source.published, cutoff) || afterCutoff(source.availableAt, cutoff))
      error = "source publication or vintage is after the cutoff";
    else {
      try {
        text = (provided ?? pageText.provided?.(url) ?? (await pageText(url)) ?? "").slice(
          0,
          256_000,
        );
        if (!text) error = "source text unavailable";
      } catch (e) {
        error = getErrorMessage(e).slice(0, 200);
      }
    }
    sources.push({
      ...metadata,
      text,
      textHash: evidenceHash(text),
      capturedAt: now().toISOString(),
      temporal: error ? "rejected" : opts.archived ? "archive" : "live",
      ...(error ? { error } : {}),
    });
  }
  if (urls.length > 64) warnings.push("Evidence page limit reached; uncaptured sources excluded.");
  if (!opts.archived)
    warnings.push(
      "Live captures prove what was read, not historical page availability. Unknown publication dates are background only.",
    );
  const pages = new Map(sources.filter((s) => !s.error).map((s) => [s.url, s.text]));
  const reader: PageText = Object.assign(async (url: string) => pages.get(url), {
    provided: (url: string) => pages.get(url),
  });
  // A line citing any unavailable/post-cutoff source is rejected as a whole.
  const text = report.report
    .split("\n")
    .filter((line) => {
      const links = citedUrls(line);
      return links.length > 0 && links.every((url) => pages.has(url));
    })
    .join("\n");
  const checked = await verifyDossier(text, reader);
  const value = {
    version: 1 as const,
    brief: structuredClone(brief),
    capturedAt: now().toISOString(),
    cutoff,
    sources,
    report: report.report,
    verified: checked.verifiedText,
    stats: checked.stats,
    warnings,
  };
  return { ...value, hash: evidenceHash(value) };
}

export function validateEvidence(snapshot: EvidenceSnapshot): void {
  const { hash, ...value } = snapshot;
  if (
    snapshot.version !== 1 ||
    evidenceHash(value) !== hash ||
    snapshot.sources.some((s) => evidenceHash(s.text) !== s.textHash)
  )
    throw new Error("evidence snapshot hash mismatch");
}

/** Replays the same question/cutoff only. A modified question requires a new capture. */
export function replayEvidence(snapshot: EvidenceSnapshot): Retriever {
  validateEvidence(snapshot);
  const frozen = structuredClone(snapshot);
  return async (brief) => {
    if (evidenceHash(brief) !== evidenceHash(frozen.brief))
      throw new Error("evidence replay brief or cutoff mismatch");
    return {
      report: frozen.verified,
      sources: structuredClone(frozen.sources.filter((s) => !s.error)),
      searches: 0,
      costUsd: 0,
      retriever: `replay:${frozen.hash}`,
      evidence: structuredClone(frozen),
    };
  };
}
