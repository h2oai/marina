// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `judge stats [surface]`: the one readout of every judge in the world — the
 * challenge judge, the submission verifier, the attention judges, the outcome
 * judges and the Arbiter — from the one judge ledger (`src/decisions/judges.ts`).
 * Per surface and judge (and class, for challenges): comparisons with a ground
 * truth, agreement, the Wilson lower bound, earned or not, and how many more
 * observations it needs at its current rate. Read-only; no model call.
 * `decision agreement`, `challenge stats` and `outcome agreement` are views of
 * the same ledger.
 */

import {
  EARNED_JUDGE_MIN_LOWER,
  EARNED_JUDGE_MIN_N,
  type JudgeStanding,
  judgeModeFor,
  judgeStandings,
} from "../../decisions/judges";
import { bold, dim, header, separator } from "../../net/ansi";
import type { JudgeLedgerStore } from "../../persistence/interfaces/judge-ledger-store";
import type { CommandDef, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { unknownSubcommand } from "../parse-input";

export const JUDGE_USAGE = `Usage:
  judge stats [challenge|verify|attention|outcome|arbiter]`;

const SURFACES = ["challenge", "verify", "attention", "outcome", "arbiter"] as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;

function modeLine(env: NodeJS.ProcessEnv): string {
  const parts = (["challenge", "verify", "attention", "outcome"] as const).map((s) => {
    const m = judgeModeFor(s, env);
    return `${s} ${m.mode}${m.variable ? ` (${m.variable})` : ""}`;
  });
  return `modes: ${parts.join(" · ")}`;
}

function standingLine(s: JudgeStanding): string {
  const name = `${s.surface}${s.question && s.surface === "challenge" ? `/${s.question}` : ""}`;
  const rate = s.compared ? pct(s.agreed / s.compared) : "n/a";
  const bound =
    s.rule === "arbiter-precision" ? `precision ${pct(s.lower)}` : `lower ${pct(s.lower)}`;
  const need = s.earned
    ? bold("earned")
    : s.needed === undefined
      ? dim("not earned · not at this rate")
      : dim(
          `not earned · needs ~${s.needed} more at ${s.compared ? "this rate" : "full agreement"}`,
        );
  const extra = [
    s.awaiting ? `awaiting truth ${s.awaiting}` : "",
    s.noOpinion ? `no opinion ${s.noOpinion}` : "",
    s.falsePass ? `false pass ${s.falsePass}` : "",
  ].filter(Boolean);
  return `  ${bold(name)} ${dim(s.judge)}  n ${s.compared} · agreed ${rate} · ${bound} · ${need}${extra.length ? dim(` · ${extra.join(" · ")}`) : ""}`;
}

/** The readout's lines (pure over the ledger; `backend` undefined ⇒ "no judge backend"). */
export function judgeStatsLines(
  store: Pick<JudgeLedgerStore, "judgeLedgerTallies"> | undefined,
  opts: { surface?: string; backend?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const env = opts.env ?? process.env;
  const filter = opts.surface === "attention" ? "attention:" : opts.surface;
  const rows = store ? judgeStandings(store, { ...(filter ? { surface: filter } : {}), env }) : [];
  const lines = [
    header(opts.surface ? `Judges · ${opts.surface}` : "Judges"),
    separator(),
    opts.backend
      ? dim(`backend: ${opts.backend}`)
      : "no judge backend (MARINA_DECISIONS): no judge calls are made",
    dim(modeLine(env)),
    dim(
      `earned = ≥ ${EARNED_JUDGE_MIN_N} comparisons with a ground truth, Wilson 95% lower bound ≥ ${pct(EARNED_JUDGE_MIN_LOWER)} (challenge: precision of allow, per class; arbiter: its own overrule bar)`,
    ),
  ];
  if (!rows.length) {
    lines.push("No judge opinions recorded yet.");
    return lines;
  }
  for (const s of rows) lines.push(standingLine(s));
  return lines;
}

export function judgeCommand(deps: {
  store: () => Pick<JudgeLedgerStore, "judgeLedgerTallies"> | undefined;
  backend: () => string | undefined;
}): CommandDef {
  return {
    category: "System",
    usage: [{ syntax: "judge stats [challenge|verify|attention|outcome|arbiter]", effect: "read" }],
    name: "judge",
    aliases: [],
    minRank: 0,
    help: `Every judge's record against ground truth, from the one judge ledger.\n${JUDGE_USAGE}\nMARINA_JUDGE=off|observe|on sets every judge surface; a surface's own variable (MARINA_CHALLENGE_JUDGE, MARINA_DECISION_VERIFY, MARINA_ATTENTION_JUDGE, MARINA_OUTCOME_JUDGE) overrides it. \`on\` lets only an earned judge act.`,
    handler: async (ctx: RoomContext, input) => {
      const tokens = (input.args?.trim() ?? "").split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "stats").toLowerCase();
      if (sub !== "stats") {
        ctx.send(input.entity, unknownSubcommand("judge", sub, JUDGE_USAGE));
        return;
      }
      const surface = tokens[1]?.toLowerCase();
      if (surface && !(SURFACES as readonly string[]).includes(surface)) {
        refuseCommand(ctx, input.entity, `Unknown judge surface "${surface}".\n${JUDGE_USAGE}`);
        return;
      }
      const backend = deps.backend();
      ctx.send(
        input.entity,
        judgeStatsLines(deps.store(), {
          ...(surface ? { surface } : {}),
          ...(backend ? { backend } : {}),
        }).join("\n"),
      );
    },
  };
}
