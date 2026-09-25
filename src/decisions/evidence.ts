// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-world evidence for the verifier's `grounded` question. A draft or a task
 * submission that cites `note:N`, `task:N` or `chronicle:N` has those records
 * sent along as the evidence its claims are checked against — the civic
 * version of "the files and tool results the answer was based on".
 *
 * Nothing is required: an uncited answer is simply not checked for grounding.
 * Citing is a habit agents can discover pays off, not a rule imposed on them.
 * Access is the CITER's: a note they cannot read, or a task in a group they are
 * not in, is dropped silently — citing never reveals what the citer can't see.
 * Text is masked (emails, key-shaped strings) and capped before it leaves.
 */

import { memoryAccess } from "../memory/access";
import type { MarinaDB } from "../persistence/database";
import { maskSensitiveText } from "./gate";

export type EvidenceKind = "note" | "task" | "chronicle";

export interface Evidence {
  ref: string;
  text: string;
}

const REF = /\b(note|task|chronicle):(\d{1,12})\b/g;
export const MAX_EVIDENCE_REFS = 8;
const MAX_EVIDENCE_CHARS = 1_500;

/** Distinct `kind:N` refs in first-seen order, capped. */
export function parseEvidenceRefs(text: string): Array<{ kind: EvidenceKind; id: number }> {
  const seen = new Set<string>();
  const out: Array<{ kind: EvidenceKind; id: number }> = [];
  for (const m of text.matchAll(REF)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1] as EvidenceKind, id: Number(m[2]) });
    if (out.length >= MAX_EVIDENCE_REFS) break;
  }
  return out;
}

/** Resolve the refs cited in `text` that `actor` may read. */
export function resolveEvidence(
  db: MarinaDB,
  actor: { name: string; id?: string },
  text: string,
): Evidence[] {
  const refs = parseEvidenceRefs(text);
  if (refs.length === 0) return [];
  const access = memoryAccess(db, actor);
  const actorId = actor.id ?? db.findEntityIdByName(actor.name);
  const out: Evidence[] = [];
  for (const { kind, id } of refs) {
    let body: string | undefined;
    if (kind === "note") {
      const note = db.getNote(id);
      if (access.read(note)) body = note.content;
    } else if (kind === "task") {
      const task = db.getTask(id);
      const visible =
        task && (!task.group_id || (!!actorId && !!db.getGroupMember(task.group_id, actorId)));
      if (visible) body = [task.title, task.description].filter(Boolean).join("\n");
    } else {
      const entry = db.getChronicleEntry(id);
      if (entry) body = `${entry.title}\n${entry.body}`;
    }
    if (body?.trim()) {
      out.push({ ref: `${kind}:${id}`, text: maskSensitiveText(body.trim(), MAX_EVIDENCE_CHARS) });
    }
  }
  return out;
}
