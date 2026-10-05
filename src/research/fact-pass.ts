// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A cross-model fact and citation pass over a finished research report: a
 * SECOND model (never the writer — same-model self-review did not help in our
 * measurements) reads each section with the evidence of the sources it cites
 * and proposes minimal edits: a figure corrected to the evidence, a citation
 * re-pointed to the source that supports it, an unsupported clause removed.
 *
 * The checker cannot rewrite: an edit applies only when its `find` text
 * occurs exactly once in the section, and a replacement may not introduce a
 * figure that is in none of the section's cited evidence (checked
 * mechanically, like the citation audit). Everything proposed, applied and
 * refused is kept for the audit trail. Because it runs on a finished report,
 * a run with and without the pass share the same research and draft.
 */

import { figuresMissing } from "../arena/research/verify";
import { extractJsonValue } from "../repair/output-repair";
import { citedNumbers, type Evidence, normalizeCitationMarkers } from "./citations";
import { FACT_PASS_SYSTEM, languageName } from "./prompts";
import { evidenceBlock, finishReport, type ReportModel, type ResearchReportResult } from "./report";

export interface FactEdit {
  section: number;
  find: string;
  replace: string;
  reason: string;
  status: "applied" | "not-found" | "ambiguous" | "new-figure" | "no-op";
}

export interface FactPassAudit {
  checker: string;
  sections: number;
  failedSections: number;
  proposed: number;
  applied: number;
  edits: FactEdit[];
}

/** Evidence characters shown to the checker per section. */
const CHECK_EVIDENCE_CHARS = 40_000;

/** Split a body into its `## ` sections (the text before the first one is section 0). */
export function splitSections(body: string): string[] {
  const parts = body.split(/\n(?=## )/);
  return parts.filter((p) => p.length > 0);
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length))
    count++;
  return count;
}

/** Apply one section's proposed edits under the rules in the module comment. */
export function applyEdits(
  section: string,
  index: number,
  proposals: Array<{ find: string; replace: string; reason: string }>,
  evidence: readonly Evidence[],
): { text: string; edits: FactEdit[] } {
  let text = section;
  const edits: FactEdit[] = [];
  for (const p of proposals) {
    const replace = normalizeCitationMarkers(p.replace);
    const base = { section: index, find: p.find, replace, reason: p.reason };
    if (p.find === replace) {
      edits.push({ ...base, status: "no-op" });
      continue;
    }
    const n = occurrences(text, p.find);
    if (n === 0) {
      edits.push({ ...base, status: "not-found" });
      continue;
    }
    if (n > 1) {
      edits.push({ ...base, status: "ambiguous" });
      continue;
    }
    // A replacement may only carry figures the cited evidence holds.
    const cited = citedNumbers(replace);
    const pages = evidence.filter((e) => cited.includes(e.n)).map((e) => e.quote);
    const fresh = figuresMissing(replace.replace(/\[\d+\]/g, " "), pages).filter(
      (f) => !p.find.includes(f),
    );
    if (fresh.length > 0) {
      edits.push({ ...base, status: "new-figure" });
      continue;
    }
    text = text.replace(p.find, () => replace);
    edits.push({ ...base, status: "applied" });
  }
  return { text, edits };
}

/**
 * Run the pass over `report` with `checker` (sections `concurrency` at a
 * time). Returns the edited report (renumbered and re-audited) and the audit.
 * A section whose check fails is left as written and counted.
 */
export async function factCheckReport(
  report: ResearchReportResult,
  checker: ReportModel,
  opts: { concurrency?: number; log?: (line: string) => void } = {},
): Promise<{ report: ResearchReportResult; audit: FactPassAudit }> {
  const sections = splitSections(report.body);
  const titleOf = (n: number) => report.sources.find((s) => s.n === n)?.title;
  const out = [...sections];
  const audit: FactPassAudit = {
    checker: checker.name,
    sections: 0,
    failedSections: 0,
    proposed: 0,
    applied: 0,
    edits: [],
  };
  const queue = sections.map((_, i) => i);
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const section = sections[i]!;
        const cited = citedNumbers(section);
        if (cited.length === 0) continue;
        audit.sections++;
        const evidence = report.evidence.filter((e) => cited.includes(e.n));
        try {
          const reply = await checker.complete(
            FACT_PASS_SYSTEM,
            [
              `Report language: ${languageName(report.language)}.`,
              `SECTION:\n${section}`,
              `EVIDENCE (by source number):\n${evidenceBlock(evidence, titleOf, CHECK_EVIDENCE_CHARS)}`,
            ].join("\n\n"),
          );
          const v = extractJsonValue(reply) as { edits?: unknown } | undefined;
          const proposals = (Array.isArray(v?.edits) ? v.edits : [])
            .map((e) => e as Record<string, unknown>)
            .filter((e) => typeof e?.find === "string" && (e.find as string).trim().length >= 8)
            .map((e) => ({
              find: e.find as string,
              replace: typeof e.replace === "string" ? e.replace : "",
              reason: typeof e.reason === "string" ? e.reason.slice(0, 200) : "",
            }));
          audit.proposed += proposals.length;
          const applied = applyEdits(section, i, proposals, evidence);
          out[i] = applied.text;
          audit.edits.push(...applied.edits);
          audit.applied += applied.edits.filter((e) => e.status === "applied").length;
        } catch (err) {
          audit.failedSections++;
          opts.log?.(`fact pass: section ${i} failed: ${(err as Error).message.slice(0, 120)}`);
        }
      }
    }),
  );
  audit.edits.sort((a, b) => a.section - b.section);
  const edited = finishReport({
    language: report.language,
    plan: report.plan,
    draft: out.join("\n"),
    sources: report.sources,
    evidence: report.evidence,
    sections: report.sections,
    searchUsd: report.searchUsd,
    searches: report.searches,
    warnings: report.warnings,
  });
  return { report: edited, audit };
}
