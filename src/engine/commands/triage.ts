// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AnswerSpec } from "../../forecast/answer-types";
import { type TriageResult, triageQuestion } from "../../forecast/triage";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { currentEvidenceCutoff } from "../evidence-fence";
import { parseModifiers } from "../parse-input";
import { typedSpec } from "./forecast";

/**
 * `triage <question or task>` — rank-0 intake triage (`src/forecast/triage.ts`):
 * which method a question needs before any money is spent on it. Deterministic,
 * no model call, no network, milliseconds. The class comes from the text, the
 * answer type and the clock:
 *
 *   lookup    already published at now — read the field and stop
 *   anchor    a numeric series not yet out — project the latest reading (quant fit)
 *   list      a ranking or board — rebuild it, project, sort
 *   forecast  open — the full method (`forecast …`)
 *
 * `asof:` sets NOW (a backtest's cutoff); otherwise it is the world clock.
 */

export const TRIAGE_USAGE = `Usage:
  triage <question or task> [type:choice|multi|number|ranking|text] [options:A,B,…] [size:N] [ends:<ISO>] [resolves:<ISO>] [asof:<ISO>]

The class is decided by dates, never guessed: a figure whose release (or event) is before NOW is a lookup.
asof: sets NOW (default: the world clock); resolves: is when the answer becomes known.
When to triage, and what each class does next: skill builtin intake-triage`;

const HELP = `Intake triage — which method a question or task needs. No model call, milliseconds.
${TRIAGE_USAGE}

Examples:
  triage What was the US CPI-U inflation rate for August 2026? type:number
  triage Will Arsenal beat Aston Villa on 31 August 2026? type:choice options:Yes,No
  triage Which five films will top the domestic box office for 18-20 September 2026? type:ranking size:5
  triage What will EIA report for crude stocks for the week ending 28 August 2026? asof:2026-08-25`;

export function renderTriage(r: TriageResult): string[] {
  const f = r.facts;
  const facts = [
    f.publisher ? `publisher ${f.publisher}${f.domain ? ` (${f.domain})` : ""}` : "",
    f.metric ? `metric ${f.metric}` : "",
    f.period ? `period ${f.period.label}` : "",
    f.releaseDate ? `release ${f.releaseDate}` : "",
    f.eventDate ? `event ${f.eventDate}` : "",
    f.list
      ? `list${f.list.size ? ` of ${f.list.size}` : ""}${f.list.ordered ? ", ordered" : ""}`
      : "",
    f.series ? "numeric series" : f.numeric ? "numeric" : "",
  ].filter(Boolean);
  const pub = r.published;
  const b = r.budget;
  return [
    `  ${bold("class")}: ${r.class}  ${dim(`— ${r.reason}`)}`,
    `  ${bold("published")}: ${pub.status}${pub.basis ? ` (${pub.basis}${pub.at ? `, ${pub.at.slice(0, 10)}` : ""})` : ""}${pub.window ? ` ${dim(`usual window ${pub.window.from}..${pub.window.to}`)}` : ""}`,
    `  ${bold("facts")}: ${facts.length ? facts.join("; ") : dim("none stated")}  ${dim(`[${f.kind}]`)}`,
    `  ${bold("method")}: ${r.method.card} — ${r.method.summary}`,
    ...r.method.steps.map((s, i) => `    ${i + 1}. ${s}`),
    ...(r.method.fallback ? [`  ${bold("fallback")}: ${r.method.fallback}`] : []),
    `  ${bold("budget")}: ${b.researchRounds} research round(s), ${b.runs} run(s)${b.critique ? ", critique" : ""}${b.stopEarly ? ", stop at the first verified value" : ""} ${dim(`(~${Math.round(b.relativeCost * 100)}% of the full panel)`)}`,
    `  ${dim(`now ${r.now}`)}`,
  ];
}

/** `triage …` → reply lines. Throws RangeError on bad input. */
export function runTriage(args: string, now: Date): string[] {
  const parsed = parseModifiers(args.split(/\s+/).filter(Boolean), {
    type: { type: "string" },
    options: { type: "string" },
    size: { type: "string" },
    ends: { type: "string" },
    resolves: { type: "string" },
    asof: { type: "string", aliases: ["now", "cutoff"] },
  });
  if (parsed.errors.length) throw new RangeError(parsed.errors.join("; "));
  const question = parsed.rest.join(" ").trim();
  if (!question) throw new RangeError("no question given");
  const typed = typedSpec(parsed.values);
  if (typed && "error" in typed) throw new RangeError(typed.error);
  let spec: AnswerSpec | undefined;
  let endTime: string | undefined;
  if (typed) {
    spec = typed.spec;
    endTime = typed.endTime;
  }
  const iso = (key: "resolves" | "asof"): string | undefined => {
    const v = parsed.values[key];
    if (typeof v !== "string") return undefined;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new RangeError(`${key}: takes an ISO time, e.g. 2026-09-15`);
    return new Date(t).toISOString();
  };
  const resolvesAt = iso("resolves");
  let at = iso("asof") ?? now.toISOString();
  // The as-of fence (src/engine/evidence-fence.ts): NOW is never after the cutoff.
  const fence = currentEvidenceCutoff();
  if (fence && Date.parse(at) > Date.parse(fence)) at = fence;
  const r = triageQuestion({
    question: question.slice(0, 2_000),
    ...(spec ? { answer: spec } : {}),
    ...(endTime ? { endTime } : {}),
    ...(resolvesAt ? { resolvesAt } : {}),
    now: at,
  });
  return renderTriage(r);
}

export function triageCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  /** The world clock (tests pin it). */
  now?: () => Date;
}): CommandDef {
  return {
    category: "Markets & Forecasting",
    usage: [
      {
        syntax:
          "triage <question or task> [type:<choice|multi|number|ranking|text>] [options:<id,id,…>] [size:<n>] [ends:<iso>] [resolves:<iso>] [asof:<iso>]",
        effect: "read",
      },
    ],
    name: "triage",
    aliases: [],
    minRank: 0,
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      if (!deps.getEntity(input.entity)) return;
      const args = input.args?.trim() ?? "";
      if (!args || args.toLowerCase() === "help") {
        ctx.send(input.entity, TRIAGE_USAGE);
        return;
      }
      let body: string[];
      try {
        body = runTriage(args, deps.now?.() ?? new Date());
      } catch (err) {
        ctx.send(input.entity, `triage: ${(err as Error).message}\n${TRIAGE_USAGE}`);
        return;
      }
      ctx.send(input.entity, [header("triage"), separator(), ...body].join("\n"));
    },
  };
}
