// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arbiter`: the Arbiter's mechanics as a free, read-only world command, so a
 * resident Arbiter (role `arbiter`) and anyone who invites one apply the same
 * rules as the library (`src/orchestration/arbiter.ts`):
 *
 *   arbiter contested [type:<t>] -- <a> | <b> | …   is this contested? (run agreement by type)
 *   arbiter check [type:<t>] [majority:<answer>] [agreement:<0-1>] -- <verdict JSON>
 *                                                   the overrule bar, applied mechanically
 *   arbiter policy                                  the thresholds in force
 *
 * No model call, nothing written.
 */

import { bold, dim } from "../../net/ansi";
import {
  type ArbiterAnswerType,
  type ArbiterPolicy,
  applyOverruleBar,
  arbiterPolicyFromEnv,
  type Disagreement,
  detectDisagreement,
  formatArbiterValue,
  parseArbiterVerdict,
  toArbiterValue,
} from "../../orchestration/arbiter";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { parseModifiers, splitOnTerminator, unknownSubcommand } from "../parse-input";

const TYPES: readonly ArbiterAnswerType[] = ["choice", "multi", "number", "ranking", "text"];

export const ARBITER_USAGE = `Usage:
  arbiter contested [type:choice|multi|number|ranking|text] -- <answer> | <answer> | …
  arbiter check [type:<t>] [majority:<answer>] [agreement:<0-1>] -- <verdict JSON>
  arbiter policy`;

const HELP = `The Arbiter's rules, free and mechanical — no model call.
${ARBITER_USAGE}

contested: the answers independent attempts gave (multi/ranking items comma-separated). Contested = they disagree.
check: apply the overrule bar to an Arbiter verdict:
  {"verdict":"keep"|"overrule"|"abstain","answer":…,"items":[{"item":…,"citations":[{"source":<url>,"quote":…}]}],
   "source_quality":0-1,"reasoning_quality":0-1,"confidence":0-1,"reason":…}
  Overruling a majority needs citations for every answer item from independent domains and enough confidence; short of that it is kept or abstained.
Invite an Arbiter: a resident with role \`arbiter\` (\`agent spawn <name> role:arbiter\`), then \`tell <name> arbitrate: <question> | answers: … | evidence: …\`.`;

function policyLines(p: ArbiterPolicy): string[] {
  return [
    `  contested below agreement ${p.contestedBelow}; majority above ${p.majorityAbove}`,
    `  overrule a majority: ≥ ${p.minDomains} independent domain(s), confidence ≥ ${p.minConfidence}`,
    `  overrule without a majority: ≥ ${p.minDomainsNoMajority} domain(s)`,
    `  cap ${p.cap === 0 ? "none" : `${p.cap} item(s) per batch or per day`}; judge spread > ${p.judgeSpread} is contested`,
    `  earned trust: ${p.earn.minResolved} resolved overrules at precision ≥ ${p.earn.minPrecision}; until then ${p.earn.unearned}`,
  ];
}

function disagreementLines(d: Disagreement): string[] {
  return [
    `  ${bold(d.contested ? "contested" : "not contested")}${d.reasons.length ? ` (${d.reasons.join(", ")})` : ""}`,
    `  agreement ${d.agreement}${d.majority !== undefined ? `; ${d.hasMajority ? "majority" : "plurality"}: ${formatArbiterValue(d.majority)}` : ""}`,
    ...d.answers.map((a) => dim(`    ${formatArbiterValue(a.answer)} — ${a.weight}`)),
  ];
}

function readType(raw: unknown): ArbiterAnswerType | { error: string } {
  if (raw === undefined) return "text";
  const t = String(raw).toLowerCase();
  return (TYPES as readonly string[]).includes(t)
    ? (t as ArbiterAnswerType)
    : { error: `type must be one of ${TYPES.join(", ")}` };
}

/** `arbiter contested …` — the reply lines. */
export function runContested(rest: string, policy: ArbiterPolicy): string[] {
  const [head, after] = splitOnTerminator(rest);
  const mods = parseModifiers(head.split(/\s+/).filter(Boolean), { type: { type: "string" } });
  if (mods.errors.length) throw new Error(mods.errors.join("; "));
  const type = readType(mods.values.type);
  if (typeof type !== "string") throw new Error(type.error);
  const body = after ?? mods.rest.join(" ");
  const answers = body
    .split("|")
    .map((a) => toArbiterValue(type, a))
    .filter((a) => a !== undefined);
  if (answers.length === 0) throw new Error("give the answers after `--`, separated by `|`");
  const d = detectDisagreement({ type, runs: answers.map((answer) => ({ answer })) }, policy);
  return disagreementLines(d);
}

/** `arbiter check …` — the reply lines. */
export function runCheck(rest: string, policy: ArbiterPolicy): string[] {
  const [head, after] = splitOnTerminator(rest);
  if (after === undefined) throw new Error("give the verdict JSON after `--`");
  const mods = parseModifiers(head.split(/\s+/).filter(Boolean), {
    type: { type: "string" },
    majority: { type: "string" },
    agreement: { type: "number" },
  });
  if (mods.errors.length) throw new Error(mods.errors.join("; "));
  const type = readType(mods.values.type);
  if (typeof type !== "string") throw new Error(type.error);
  const verdict = parseArbiterVerdict(after);
  if (!verdict) throw new Error("no readable verdict (keep | overrule | abstain) in the JSON");
  const majority =
    mods.values.majority !== undefined ? toArbiterValue(type, mods.values.majority) : undefined;
  const agreement =
    typeof mods.values.agreement === "number" ? mods.values.agreement : majority ? 1 : 0;
  const d: Disagreement = {
    contested: true,
    reasons: ["dissent"],
    agreement,
    ...(majority !== undefined ? { majority } : {}),
    hasMajority: majority !== undefined && agreement > policy.majorityAbove,
    answers: majority !== undefined ? [{ answer: majority, weight: 1 }] : [],
    dissent: [],
    severity: 1,
  };
  const bar = applyOverruleBar(verdict, { type, disagreement: d, policy });
  const lines = [
    `  asked: ${bold(verdict.verdict)}${verdict.answer !== undefined ? ` → ${formatArbiterValue(toArbiterValue(type, verdict.answer) ?? String(verdict.answer))}` : ""} (confidence ${verdict.confidence}, sources ${verdict.sourceQuality}, reasoning ${verdict.reasoningQuality})`,
    `  after the bar: ${bold(bar.verdict)}${bar.answer !== undefined ? ` → ${formatArbiterValue(bar.answer)}` : ""}`,
  ];
  if (verdict.verdict === "overrule") {
    lines.push(
      `  independent domains: ${bar.domains.length ? bar.domains.join(", ") : "none"} (${bar.requiredDomains} required)`,
    );
    for (const why of bar.downgraded) lines.push(dim(`  downgraded: ${why}`));
  }
  if (bar.verdict !== "overrule") lines.push(dim("  the majority answer stands"));
  return lines;
}

export function arbiterCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    category: "System",
    usage: [
      {
        syntax: "arbiter contested [type:choice|multi|number|ranking|text] -- <a> | <b> | …",
        effect: "read",
      },
      {
        syntax: "arbiter check [type:<t>] [majority:<answer>] [agreement:<0-1>] -- <verdict JSON>",
        effect: "read",
      },
      { syntax: "arbiter policy", effect: "read" },
    ],
    name: "arbiter",
    aliases: [],
    minRank: 0,
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const args = input.args?.trim() ?? "";
      const space = args.search(/\s/);
      const sub = (space < 0 ? args : args.slice(0, space)).toLowerCase();
      const rest = space < 0 ? "" : args.slice(space + 1);
      const policy = arbiterPolicyFromEnv();
      if (sub === "" || sub === "help") {
        ctx.send(input.entity, ARBITER_USAGE);
        return;
      }
      if (sub === "policy") {
        ctx.send(input.entity, [bold("Arbiter policy"), ...policyLines(policy)].join("\n"));
        return;
      }
      if (sub !== "contested" && sub !== "check") {
        ctx.send(input.entity, unknownSubcommand("arbiter", sub, ARBITER_USAGE));
        return;
      }
      try {
        const lines = sub === "contested" ? runContested(rest, policy) : runCheck(rest, policy);
        ctx.send(input.entity, [bold(`arbiter ${sub}`), ...lines].join("\n"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.send(input.entity, `arbiter ${sub}: ${message}\n${ARBITER_USAGE}`);
      }
    },
  };
}
