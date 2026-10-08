// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ResearchReport } from "../arena/research/retrieve";

export class ResearchEvidenceRefusal extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
  ) {
    super(`Required research refused: ${message}`);
  }
}

/** An operator-required research run must not become a closed-book fallback. */
export function requireResearchEvidence(
  report: Pick<ResearchReport, "retriever" | "researchLoop" | "readSwarm"> & {
    sources: number | ResearchReport["sources"];
  },
  verified: string,
  error?: string,
): void {
  const problem =
    error ??
    report.researchLoop?.error ??
    (report.researchLoop?.costFinal === false ? "research cost is not final" : undefined) ??
    (report.retriever.split("+").includes("closed-book") ? "closed-book retrieval" : undefined) ??
    (!(typeof report.sources === "number" ? report.sources : report.sources.length) ||
    !verified.trim()
      ? "no verified research evidence"
      : undefined);
  if (problem) throw new ResearchEvidenceRefusal(problem, { ...report, verified });
  if (report.retriever.includes("read-swarm")) {
    const reads = report.readSwarm ?? [];
    if (!reads.some((r) => r.docsRead > 0 && r.readerCalls > r.readerFailures))
      throw new ResearchEvidenceRefusal("no successful full-page reader", { ...report, verified });
  }
}
