// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  daysUntil,
  describeEvidence,
  type PostureEntry,
  type PostureEvidence,
  postureEntries,
} from "../../config/capability-posture";
import { environmentCatalog } from "../../config/environment";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, RoomContext } from "../../types";

const USAGE = [
  "Usage: posture            what is waiting on evidence, soonest decision first",
  "       posture all        also what is off by design, with the reason",
  "       posture due        only entries past their decide-by date",
  "       posture <text>     entries whose name contains <text>",
].join("\n");

/** Recent judge rows scanned for a prefix or any-surface lookup (the command is on demand). */
const JUDGE_SCAN = 2_000;

export type PostureDb = Pick<MarinaDB, "listOutcomes" | "listJudgeLedger" | "queryBenchmarkRuns">;

/** When the entry's evidence source last recorded anything, or undefined (none, or operator). */
export function lastEvidenceAt(db: PostureDb, e: PostureEvidence): number | undefined {
  switch (e.kind) {
    case "outcomes":
      return db.listOutcomes({
        ...(e.source ? { source: e.source } : {}),
        ...(e.outcomeKind ? { kind: e.outcomeKind } : {}),
        limit: 1,
      })[0]?.resolved_at;
    case "judge": {
      const exact = e.surface && !e.surface.endsWith(":");
      const rows = db.listJudgeLedger({
        ...(exact ? { surface: e.surface } : {}),
        limit: exact ? 1 : JUDGE_SCAN,
      });
      return rows.find((r) => !e.surface || r.surface.startsWith(e.surface))?.opined_at;
    }
    case "benchmark":
      return db.queryBenchmarkRuns({
        ...(e.benchmark ? { benchmark: e.benchmark } : {}),
        limit: 1,
      })[0]?.started_at;
    case "operator":
      return undefined;
  }
}

/** A setting's value as shown: short plain values verbatim, anything else only as "set". */
export function shownValue(key: string, env: NodeJS.ProcessEnv, defaults: Map<string, string>) {
  const v = env[key];
  if (v === undefined || v === "") return `${defaults.get(key) ?? "unset"} (default)`;
  return /^[A-Za-z0-9_.:-]{1,24}$/.test(v) ? v : "set";
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function deadline(decideBy: string, now: number): string {
  const d = daysUntil(decideBy, now);
  return d < 0 ? `${-d}d PAST` : `${d}d left`;
}

function renderEntry(
  e: PostureEntry,
  value: string,
  db: PostureDb | undefined,
  now: number,
): string[] {
  const p = e.posture;
  if (p.class === "by-design") return [`  ○ ${e.subject} = ${value} — by design: ${p.reason}`];
  let last = "";
  if (p.evidence.kind !== "operator") {
    let at: number | undefined;
    let unreadable = false;
    try {
      at = db ? lastEvidenceAt(db, p.evidence) : undefined;
    } catch {
      unreadable = true; // a database before the ledger tables: say so, never fail the readout
    }
    last = unreadable
      ? " · last unknown (ledger not readable)"
      : db
        ? ` · last ${at === undefined ? "never" : `${day(at)} (${Math.max(0, Math.floor((now - at) / 86_400_000))}d ago)`}`
        : " · last unknown (no database)";
  }
  const icon = daysUntil(p.decideBy, now) < 0 ? "⚠" : "·";
  return [
    `  ${icon} ${e.subject} = ${value} · decide by ${p.decideBy} (${deadline(p.decideBy, now)})`,
    `      evidence: ${describeEvidence(p.evidence)}${last}`,
    `      promote when: ${p.promoteWhen}`,
  ];
}

/**
 * `posture` — what Marina ships but does not run by default, what evidence
 * would switch each one on, and when it is due for a decision. Read-only (rank
 * 0): settings show only short plain values; anything else reads "set".
 */
export function postureCommand(deps: {
  db?: PostureDb;
  /** The annotated environment reference (defaults come from it). */
  reference: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): CommandDef {
  return {
    category: "System",
    usage: [
      { syntax: "posture", effect: "read" },
      { syntax: "posture all", effect: "read" },
      { syntax: "posture due", effect: "read" },
      { syntax: "posture <text>", effect: "read" },
    ],
    name: "posture",
    aliases: [],
    minRank: 0,
    help: `Capability posture: every feature or setting that is off or observe-only by default, the evidence that would switch it on, and its decide-by date.\n${USAGE}`,
    handler: (ctx: RoomContext, input) => {
      const arg = input.args.trim().toLowerCase();
      if (arg === "help") return ctx.send(input.entity, USAGE);
      const now = deps.now?.() ?? Date.now();
      const env = deps.env ?? process.env;
      const defaults = new Map(environmentCatalog(deps.reference()).map((s) => [s.key, s.example]));
      const all = postureEntries();
      const shownOf = (e: PostureEntry) =>
        e.type === "setting" ? shownValue(e.subject, env, defaults) : (e.status ?? "");
      const measured = all
        .filter((e) => e.posture.class === "measure")
        .sort((a, b) =>
          a.posture.class === "measure" && b.posture.class === "measure"
            ? a.posture.decideBy.localeCompare(b.posture.decideBy) ||
              a.subject.localeCompare(b.subject)
            : 0,
        );
      const due = measured.filter(
        (e) => e.posture.class === "measure" && daysUntil(e.posture.decideBy, now) < 0,
      );
      const byDesign = all.filter((e) => e.posture.class === "by-design");
      const header = `Capability posture — ${measured.length} waiting on evidence (${due.length} past due) · ${byDesign.length} off by design`;

      let shown: PostureEntry[];
      if (arg === "" || arg === "all") shown = measured;
      else if (arg === "due") shown = due;
      else shown = all.filter((e) => e.subject.toLowerCase().includes(arg));
      const lines = [header, ""];
      if (shown.length === 0)
        lines.push(
          arg === "due" ? "  Nothing is past its decide-by date." : `  No entry matches "${arg}".`,
        );
      for (const e of shown) lines.push(...renderEntry(e, shownOf(e), deps.db, now));
      if (arg === "all") {
        lines.push("", "Off by design:");
        for (const e of byDesign) lines.push(...renderEntry(e, shownOf(e), deps.db, now));
      }
      if (arg === "") lines.push("", "`posture all` adds what is off by design.");
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
