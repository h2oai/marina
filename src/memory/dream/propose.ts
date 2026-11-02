// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one model step of a dream: given the region, propose typed operations.
 * The model returns operation decisions, never replacement memory prose
 * beyond a `supersede` text that the checks hold to its sources. Anything
 * malformed is a rejected op with a reason, not an error.
 */

import type { Complete } from "../../model/reply";
import { extractJsonValue } from "../../repair/output-repair";
import {
  DREAM_LINK_RELATIONS,
  type DreamLinkRelation,
  type DreamOp,
  type DreamRegion,
  type RejectedOp,
} from "./types";

/** Ops a dream may propose, at most. */
export const DREAM_MAX_OPS = 32;

export const DREAM_SYSTEM_PROMPT = [
  "You are the memory consolidation pass for one agent, run while it is idle.",
  "You see its recent notes with ids, tiers and use evidence (how often each was served, cited, and its usefulness mean where 0.5 means no evidence).",
  "Propose operations, never prose. Reply with ONE JSON object and nothing else:",
  '{"ops":[...],"skipped":[{"id":N,"reason":"..."}]}',
  "Allowed ops:",
  '  {"op":"merge","keep":N,"into":[N,...],"reason":"..."} — notes that say the same thing; the keeper stays, the others are superseded by it.',
  '  {"op":"supersede","id":N,"text":"...","refs":[N,...],"reason":"..."} — one note restated more precisely. The text may contain ONLY facts, numbers and names present in note N or the refs. No new claims.',
  '  {"op":"link","from":N,"to":N,"relation":"related_to|supports|contradicts|derived_from|part_of","reason":"..."}',
  '  {"op":"decay","id":N,"reason":"..."} — served repeatedly, never used; only when the evidence says so.',
  "Rules: prefer doing nothing over a doubtful change. Never merge notes that differ in a number, date, name or outcome — that difference is the point. Never touch verified notes. At most 32 ops. Reasons are one short sentence.",
].join("\n");

export function regionPrompt(region: DreamRegion): string {
  const lines = [
    `Agent: ${region.entityName}. Window: ${new Date(region.since).toISOString()} → ${new Date(region.until).toISOString()}.`,
    `Outcomes in the window: ${region.outcomes.total} (${region.outcomes.succeeded} succeeded, ${region.outcomes.failed} failed).`,
    `Records (${region.records.length}):`,
  ];
  for (const r of region.records) {
    const age = Math.max(0, Math.round((region.until - r.createdAt) / 3_600_000));
    lines.push(
      `#${r.id} [${r.tier}/${r.noteType} imp=${r.importance}${r.verified ? " verified" : ""} age=${age}h served=${r.serves} cited=${r.cited} mean=${r.mean.toFixed(2)}] ${r.content.replace(/\s+/g, " ")}`,
    );
  }
  return lines.join("\n");
}

const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const ints = (v: unknown): number[] | undefined =>
  Array.isArray(v) && v.every(isInt) ? (v as number[]) : undefined;
const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Parse the model's reply into ops; anything malformed becomes a rejected op. */
export function parseOps(reply: string): { ops: DreamOp[]; rejected: RejectedOp[] } {
  const ops: DreamOp[] = [];
  const rejected: RejectedOp[] = [];
  const value = extractJsonValue(reply) as { ops?: unknown } | undefined;
  const list = Array.isArray(value?.ops) ? value.ops : undefined;
  if (!list) {
    rejected.push({ op: "reply", ids: [], reason: "no ops array in the reply" });
    return { ops, rejected };
  }
  for (const raw of list.slice(0, DREAM_MAX_OPS * 2)) {
    if (!raw || typeof raw !== "object") {
      rejected.push({ op: "?", ids: [], reason: "not an object" });
      continue;
    }
    const o = raw as Record<string, unknown>;
    const reason = str(o.reason) || "no reason given";
    switch (o.op) {
      case "merge": {
        const into = ints(o.into);
        if (!isInt(o.keep) || !into?.length) {
          rejected.push({ op: "merge", ids: [], reason: "merge needs keep and into[] ids" });
          break;
        }
        ops.push({ op: "merge", keep: o.keep, into: [...new Set(into)], reason });
        break;
      }
      case "supersede": {
        const text = str(o.text, 2000);
        if (!isInt(o.id) || !text) {
          rejected.push({ op: "supersede", ids: [], reason: "supersede needs id and text" });
          break;
        }
        ops.push({ op: "supersede", id: o.id, text, refs: ints(o.refs) ?? [], reason });
        break;
      }
      case "link": {
        const relation = str(o.relation, 40);
        if (
          !isInt(o.from) ||
          !isInt(o.to) ||
          !(DREAM_LINK_RELATIONS as readonly string[]).includes(relation)
        ) {
          rejected.push({
            op: "link",
            ids: [],
            reason: "link needs from, to and a known relation",
          });
          break;
        }
        ops.push({
          op: "link",
          from: o.from,
          to: o.to,
          relation: relation as DreamLinkRelation,
          reason,
        });
        break;
      }
      case "decay": {
        if (!isInt(o.id)) {
          rejected.push({ op: "decay", ids: [], reason: "decay needs an id" });
          break;
        }
        ops.push({ op: "decay", id: o.id, reason });
        break;
      }
      default:
        rejected.push({ op: str(o.op, 40) || "?", ids: [], reason: "unknown op" });
    }
    if (ops.length >= DREAM_MAX_OPS) break;
  }
  return { ops, rejected };
}

/** One model call: the region in, ops out. */
export async function proposeOps(
  complete: Complete,
  region: DreamRegion,
): Promise<{ ops: DreamOp[]; rejected: RejectedOp[]; reply: string }> {
  const reply = await complete(DREAM_SYSTEM_PROMPT, regionPrompt(region));
  return { ...parseOps(reply), reply };
}
