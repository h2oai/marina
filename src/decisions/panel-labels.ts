// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Human-panel labels (the Gate Label Desk export) → gate cases. Pure.
 *
 * A labeler answers allow / ask (a person should confirm) / block / skip,
 * blind to the others. A case becomes a gate case only with a CONSENSUS:
 * an editor's adjudication, or at least `minAgree` labelers giving the same
 * three-way verdict with no other verdict ahead of it (a tie is no consensus).
 * The gate's labels are hold / allow (`ask` and `block` both hold); the
 * three-way verdict is kept too, so the ask-vs-block split can be measured once
 * there is enough of it. Reviewers genuinely disagree on the middle ("Oversight
 * Has a Capacity", arXiv 2606.08919, κ = 0.52), so agreement is reported with
 * the cases, never assumed.
 */

import type { GateCase } from "./qualify";

export type Verdict = "allow" | "ask" | "block";

/** One case as the page exports it. */
export interface PanelCase {
  id: string;
  pool: "marina" | "public";
  tool: string;
  arguments: Record<string, unknown>;
  context?: { goal: string; role: string; sources: string[] };
  source?: { dataset: string; revision?: string; license: string };
  /** labeler → verdict (or "skip"). */
  labels: Record<string, string>;
  adjudicated?: Verdict;
}

export interface PanelExport {
  cases: PanelCase[];
}

const VERDICTS: readonly Verdict[] = ["allow", "ask", "block"];
const isVerdict = (v: unknown): v is Verdict => VERDICTS.includes(v as Verdict);

export interface Consensus {
  verdict: Verdict;
  /** How many labelers gave it, of how many answered (skips excluded). */
  agree: number;
  answered: number;
  adjudicated: boolean;
}

export function consensus(c: PanelCase, minAgree = 2): Consensus | undefined {
  const votes = Object.values(c.labels).filter(isVerdict);
  if (c.adjudicated && isVerdict(c.adjudicated)) {
    return {
      verdict: c.adjudicated,
      agree: votes.filter((v) => v === c.adjudicated).length,
      answered: votes.length,
      adjudicated: true,
    };
  }
  const counts = VERDICTS.map((v) => [v, votes.filter((x) => x === v).length] as const).sort(
    (a, b) => b[1] - a[1],
  );
  const [top, second] = counts;
  if (!top || top[1] < minAgree || (second && second[1] === top[1])) return undefined;
  return { verdict: top[0], agree: top[1], answered: votes.length, adjudicated: false };
}

/** The gate case a panel case yields (undefined without a consensus). */
export function panelGateCase(
  c: PanelCase,
  minAgree = 2,
): (GateCase & { verdict: Verdict }) | undefined {
  const k = consensus(c, minAgree);
  if (!k) return undefined;
  const command =
    c.tool === "marina_command" && typeof c.arguments.command === "string"
      ? c.arguments.command
      : undefined;
  return {
    id: `panel:${c.id}`,
    ...(command ? { command } : { tool: c.tool, arguments: c.arguments }),
    ...(c.context
      ? { intent: { goal: c.context.goal, role: c.context.role, sources: c.context.sources } }
      : {}),
    expect: k.verdict === "allow" ? "allow" : "hold",
    verdict: k.verdict,
    // Comparable populations: Marina calls carry intent, public calls do not.
    family: c.pool === "marina" ? "panel-marina" : "panel-call-only",
    labeledBy: "human-panel",
    ...(c.source ? { source: { ...c.source } } : {}),
  };
}

export interface AuthorAgreement {
  compared: number;
  agreed: number;
  /** Tracked cases where the panel's consensus differs from the author's label. */
  disagreements: Array<{ id: string; author: "allow" | "hold"; panel: Verdict }>;
}

/**
 * How far the tracked cases' author labels agree with the panel (hold vs
 * allow), over the tracked cases the panel reached a consensus on.
 */
export function authorAgreement(
  panel: readonly PanelCase[],
  author: ReadonlyMap<string, "allow" | "hold">,
  minAgree = 2,
): AuthorAgreement {
  const out: AuthorAgreement = { compared: 0, agreed: 0, disagreements: [] };
  for (const c of panel) {
    if (!c.id.startsWith("tracked:")) continue;
    const a = author.get(c.id.slice("tracked:".length));
    const k = consensus(c, minAgree);
    if (!a || !k) continue;
    out.compared++;
    const panelHold = k.verdict === "allow" ? "allow" : "hold";
    if (panelHold === a) out.agreed++;
    else out.disagreements.push({ id: c.id, author: a, panel: k.verdict });
  }
  return out;
}
