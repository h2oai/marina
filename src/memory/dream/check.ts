// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mechanical checks over proposed ops — before anything could be applied, and
 * with no model in the loop. Each rejection names the check that failed
 * (TRUSTMEM's coverage / preservation / faithfulness, OpenClaw's loss bound,
 * Marina's taint rule).
 *
 * - region: every id is in the region (own, fact-like, live).
 * - taint: a verified note is never merged away, superseded or decayed.
 * - coverage (merge): each duplicate shares ≥ MERGE_MIN_OVERLAP word shingles
 *   with the keeper — notes that differ in a number or a name stay apart.
 * - faithfulness (supersede): every number, name and identifier in the new
 *   text appears in the superseded note, the cited refs, or the owner's own
 *   journal episodes of the window (`journal.ts`).
 * - evidence (decay): served ≥ DECAY_MIN_SERVES times, never cited, and the
 *   usefulness mean below neutral — decay follows use evidence, never taste.
 * - preservation: at most PRESERVATION_MAX_LOSS of the region may leave the
 *   active set in one dream (merge-into, supersede, decay).
 * - procedure (propose-skill): the key names one of the region's repeated
 *   procedures (`procedures.ts`), the name makes a slug, the description fits.
 * - pool: a pool dream proposes merge, link and decay only — nothing that
 *   writes new text over another member's words.
 */

import { shingleSimilarity } from "../near-duplicate";
import { SKILL_DESCRIPTION_MAX, skillSlug } from "../skill-draft";
import type { DreamOp, DreamRegion, RegionRecord, RejectedOp } from "./types";

export const MERGE_MIN_OVERLAP = 0.5;
export const DECAY_MIN_SERVES = 5;
export const PRESERVATION_MAX_LOSS = 0.25;
export const SUPERSEDE_MAX_CHARS = 1000;

/**
 * Faithfulness of a restatement to its sources: every number (with its unit
 * or suffix), identifier-like token (digits, `_`, `/`, `.`, `:` inside) and
 * capitalised word past a sentence start in `text` must appear in `sources`,
 * case-insensitively. Rewording is free; a new fact is not. (`groundedIn`
 * holds a VALUE verbatim; a restatement is prose, so it is held token by token.)
 */
export function faithfulTo(text: string, sources: string): boolean {
  const hay = sources.toLowerCase();
  const tokens = new Set<string>();
  for (const m of text.matchAll(/\d[\d.,:%/-]*[a-zA-Z%]*/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z][\w]*[_/.:][\w/.:-]*\b/g)) tokens.add(m[0]);
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (const [i, w] of words.entries()) {
      if (i === 0) continue;
      const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (/^\p{Lu}[\p{L}\p{N}'-]+$/u.test(bare)) tokens.add(bare);
    }
  }
  for (const token of tokens) {
    const needle = token.replace(/[.,;:]+$/, "").toLowerCase();
    if (!needle) continue;
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function opIds(op: DreamOp): number[] {
  switch (op.op) {
    case "merge":
      return [op.keep, ...op.into];
    case "supersede":
      return [op.id, ...op.refs];
    case "link":
      return [op.from, op.to];
    case "decay":
      return [op.id];
    case "propose-skill":
      return [];
  }
}

/** Ids an op would remove from the active set. */
export function leavingIds(op: DreamOp): number[] {
  switch (op.op) {
    case "merge":
      return op.into;
    case "supersede":
    case "decay":
      return [op.id];
    case "link":
    case "propose-skill":
      return [];
  }
}

export function checkOps(
  ops: readonly DreamOp[],
  region: DreamRegion,
): { accepted: DreamOp[]; rejected: RejectedOp[]; leaving: number } {
  const byId = new Map<number, RegionRecord>(region.records.map((r) => [r.id, r]));
  const accepted: DreamOp[] = [];
  const rejected: RejectedOp[] = [];
  const leaving = new Set<number>();
  const reject = (op: DreamOp, reason: string) =>
    rejected.push({ op: op.op, ids: opIds(op), reason });

  for (const op of ops) {
    if (region.pool && (op.op === "supersede" || op.op === "propose-skill")) {
      reject(
        op,
        "pool: a restatement or a skill over a shared pool is written by a member, not dreamed",
      );
      continue;
    }
    if (op.op === "propose-skill") {
      if (!region.procedures.some((p) => p.key === op.procedure)) {
        reject(op, `procedure: ${op.procedure} is not a repeated procedure of this dream`);
        continue;
      }
      if (!skillSlug(op.name)) {
        reject(op, "propose-skill: the name is empty");
        continue;
      }
      if (!op.description.trim() || op.description.length > SKILL_DESCRIPTION_MAX) {
        reject(op, `propose-skill: the description must be 1–${SKILL_DESCRIPTION_MAX} characters`);
        continue;
      }
      accepted.push(op);
      continue;
    }
    const ids = opIds(op);
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      reject(op, `region: #${missing.join(", #")} not in this dream's region`);
      continue;
    }
    const protectedIds = leavingIds(op).filter((id) => byId.get(id)!.verified);
    if (protectedIds.length) {
      reject(op, `taint: #${protectedIds.join(", #")} is verified and stays as it is`);
      continue;
    }
    if (op.op === "merge") {
      if (op.into.includes(op.keep)) {
        reject(op, "merge: keeper listed among the duplicates");
        continue;
      }
      const keep = byId.get(op.keep)!;
      const apart = op.into.filter(
        (id) => shingleSimilarity(keep.content, byId.get(id)!.content) < MERGE_MIN_OVERLAP,
      );
      if (apart.length) {
        reject(
          op,
          `coverage: #${apart.join(", #")} shares too little with #${op.keep} to be the same note`,
        );
        continue;
      }
    }
    if (op.op === "supersede") {
      if (op.text.length > SUPERSEDE_MAX_CHARS) {
        reject(op, `supersede: text over ${SUPERSEDE_MAX_CHARS} characters`);
        continue;
      }
      // Its sources: the note, the refs — and the owner's own episodes (evidence).
      const sources = [
        ...[op.id, ...op.refs].map((id) => byId.get(id)!.content),
        ...region.episodes.map((e) => e.text),
      ].join("\n");
      if (!faithfulTo(op.text, sources)) {
        reject(
          op,
          "faithfulness: the new text carries a number, name or identifier not in its sources",
        );
        continue;
      }
      if (byId.get(op.id)!.content === op.text) {
        reject(op, "supersede: the text is unchanged");
        continue;
      }
    }
    if (op.op === "link" && op.from === op.to) {
      reject(op, "link: a note cannot link to itself");
      continue;
    }
    if (op.op === "decay") {
      const r = byId.get(op.id)!;
      if (r.serves < DECAY_MIN_SERVES || r.cited > 0 || r.mean >= 0.5) {
        reject(
          op,
          `evidence: decay needs ≥ ${DECAY_MIN_SERVES} serves, no citation and a usefulness mean below 0.5 (served ${r.serves}, cited ${r.cited}, mean ${r.mean.toFixed(2)})`,
        );
        continue;
      }
    }
    const would = new Set(leaving);
    for (const id of leavingIds(op)) would.add(id);
    const bound = Math.floor(region.records.length * PRESERVATION_MAX_LOSS);
    if (would.size > bound) {
      reject(
        op,
        `preservation: ${would.size} of ${region.records.length} records would leave the active set; the bound is ${bound}`,
      );
      continue;
    }
    for (const id of leavingIds(op)) leaving.add(id);
    accepted.push(op);
  }
  return { accepted, rejected, leaving: leaving.size };
}
