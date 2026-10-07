// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  formatLesson,
  type Lesson,
  type LessonSelector,
  OUTCOME_DOMAINS,
  type OutcomeDomain,
} from "../../learning/outcomes";
import { findLessons, recallAcross, retireLessons, supersedeLesson } from "../../learning/service";
import { workScopeFor } from "../../learning/work";
import { dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, CommandInput, EntityId, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import { parseModifiers, splitOnTerminator } from "../parse-input";
import { checkRoleEdit } from "../role-guard";
import { requiresPersistence } from "./command-messages";

const DOMAIN_HINT = OUTCOME_DOMAINS.join("|");
const RETIRE_USAGE = `lessons retire <id> reason:<text> [domain:<${DOMAIN_HINT}>] | lessons retire source:<s>|match:<text> [domain:<d>] [confirm:yes] reason:<text>`;
const SUPERSEDE_USAGE = "lessons supersede <id> reason:<text> -- <replacement lesson>";
/** Most lessons one criteria retirement touches; narrow the criteria for more. */
const RETIRE_CAP = 200;
const PREVIEW = 20;

const tag = (l: Lesson) => dim(`[${l.domain}${l.id ? ` ${l.id.slice(0, 8)}` : ""}]`);

/**
 * Split `… reason:<text…>` — the reason is everything after `reason:` (it must
 * come last, so it may contain spaces and colons).
 */
function splitReason(tokens: readonly string[]): { head: string[]; reason?: string } {
  const at = tokens.findIndex((t) => /^reason[:=]/i.test(t));
  if (at < 0) return { head: [...tokens] };
  const reason = [tokens[at]!.slice("reason:".length), ...tokens.slice(at + 1)].join(" ").trim();
  return { head: tokens.slice(0, at), ...(reason ? { reason } : {}) };
}

function parseDomain(raw: unknown): OutcomeDomain[] | string {
  if (raw === undefined) return [...OUTCOME_DOMAINS];
  const d = String(raw).toLowerCase();
  if (!OUTCOME_DOMAINS.includes(d as OutcomeDomain))
    return `Unknown domain "${d}". Domains: ${OUTCOME_DOMAINS.join(", ")}.`;
  return [d as OutcomeDomain];
}

/** `lessons retire …` — gated by role.edit; criteria need `confirm:yes`. */
async function retire(db: MarinaDB, entity: EntityId, tokens: string[]): Promise<string> {
  const { head, reason } = splitReason(tokens);
  const parsed = parseModifiers(head, {
    domain: { type: "string" },
    source: { type: "string" },
    match: { type: "string" },
    confirm: { type: "bool" },
  });
  if (parsed.errors.length) return `${parsed.errors.join("; ")}\nUsage: ${RETIRE_USAGE}`;
  const domains = parseDomain(parsed.values.domain);
  if (typeof domains === "string") return domains;
  const source = parsed.values.source as string | undefined;
  const match = parsed.values.match as string | undefined;
  const byCriteria = source !== undefined || match !== undefined;
  if (byCriteria ? parsed.rest.length > 0 : parsed.rest.length !== 1)
    return `Usage: ${RETIRE_USAGE}`;
  if (!reason)
    return `A reason is required (it is kept on the lesson's history).\nUsage: ${RETIRE_USAGE}`;
  const selector: LessonSelector = byCriteria
    ? { ...(source !== undefined ? { source } : {}), ...(match !== undefined ? { match } : {}) }
    : { id: parsed.rest[0]! };
  const found = await findLessons(db, domains, selector, { limit: RETIRE_CAP + 1 });
  if (found.length === 0) return "No current lesson matches.";
  if (!byCriteria && found.length > 1)
    return `"${selector.id}" matches ${found.length} lessons; give a longer id:\n${found
      .slice(0, PREVIEW)
      .map((l) => `- ${l.id} ${dim(`[${l.domain}]`)} ${l.text}`)
      .join("\n")}`;
  if (found.length > RETIRE_CAP)
    return `More than ${RETIRE_CAP} lessons match; narrow the criteria (domain:, source:, match:).`;
  if (byCriteria && parsed.values.confirm !== true)
    return [
      `${found.length} lesson(s) would be retired — repeat with confirm:yes to retire them:`,
      ...found.slice(0, PREVIEW).map((l) => `- ${formatLesson(l)} ${tag(l)}`),
      ...(found.length > PREVIEW ? [dim(`… and ${found.length - PREVIEW} more`)] : []),
    ].join("\n");
  const gate = checkRoleEdit(db, { id: entity }, `lessons retire ${found.length}`);
  if ("reason" in gate) return gate.reason;
  const result = await retireLessons(db, found, { reason, by: db.durableEntityKey(entity) });
  if (result.retired.length) gate.record();
  return [
    `Retired ${result.retired.length} lesson(s); recall no longer serves them and their history stays readable.`,
    ...result.retired.slice(0, PREVIEW).map((l) => `- ${l.text} ${tag(l)}`),
    ...result.failed.map((f) => `- failed ${tag(f.lesson)}: ${f.error}`),
  ].join("\n");
}

/** `lessons supersede <id> reason:<text> -- <replacement>` — gated by role.edit. */
async function supersede(db: MarinaDB, entity: EntityId, input: CommandInput): Promise<string> {
  const args = input.args.replace(/^\s*supersede\b/i, "");
  const [before, text] = splitOnTerminator(args);
  if (!text) return `Usage: ${SUPERSEDE_USAGE}`;
  const { head, reason } = splitReason(before.split(/\s+/).filter(Boolean));
  const parsed = parseModifiers(head, { domain: { type: "string" } });
  if (parsed.errors.length || parsed.rest.length !== 1) return `Usage: ${SUPERSEDE_USAGE}`;
  if (!reason) return `A reason is required.\nUsage: ${SUPERSEDE_USAGE}`;
  const domains = parseDomain(parsed.values.domain);
  if (typeof domains === "string") return domains;
  const found = await findLessons(db, domains, { id: parsed.rest[0]! }, { limit: 2 });
  if (found.length === 0) return "No current lesson matches.";
  if (found.length > 1) return `"${parsed.rest[0]}" matches several lessons; give a longer id.`;
  const gate = checkRoleEdit(db, { id: entity }, `lessons supersede ${found[0]!.id}`);
  if ("reason" in gate) return gate.reason;
  const next = await supersedeLesson(db, found[0]!, text, {
    reason,
    by: db.durableEntityKey(entity),
  });
  gate.record();
  return `Superseded ${tag(found[0]!)} by ${tag(next)} (unverified): ${next.text}`;
}

/**
 * `lessons <topic> [domain:<d>]` — what past outcomes taught (src/learning/):
 * judged lessons from benchmark runs, resolved forecasts, Code Mode
 * verifications and arena rounds, trusted first, unverified labelled.
 * `lessons retire|supersede` curate them (role.edit; nothing is erased).
 */
export function lessonsCommand(deps: { db?: MarinaDB }): CommandDef {
  return {
    category: "Knowledge",
    usage: [
      "lessons <topic>",
      `lessons <topic> domain:<${DOMAIN_HINT}>`,
      "lessons retire <id> reason:<text>",
      "lessons retire source:<source> [domain:<d>] [confirm:yes] reason:<text>",
      "lessons retire match:<text> [domain:<d>] [confirm:yes] reason:<text>",
      SUPERSEDE_USAGE,
    ],
    name: "lessons",
    aliases: [],
    minRank: 0,
    help: `Recall lessons Marina learned from past outcomes (benchmark runs, resolved forecasts, code verifications, arena rounds), trusted first; domain:meta holds the cross-board lessons (trusted, transferable methods and configurations mirrored from every producer).\nUsage: lessons <topic> [domain:<${DOMAIN_HINT}>]\n       ${RETIRE_USAGE}\n       ${SUPERSEDE_USAGE}\n\nEvery verdict becomes a candidate lesson; the decision layer judges it and only passing (trusted) or unjudged (unverified, labelled) lessons are served. A wrong lesson is retired, never erased: retire/supersede close its validity (recall stops serving it; its history stays readable) and need role.edit — a lesson steers every agent it is recalled for. Criteria retirements preview until confirm:yes.`,
    handler: async (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("lessons"));
        return;
      }
      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "retire" || sub === "supersede") {
        let reply: string;
        try {
          reply =
            sub === "retire"
              ? await retire(deps.db, input.entity, input.tokens.slice(1))
              : await supersede(deps.db, input.entity, input);
        } catch (err) {
          reply = `lessons ${sub} failed: ${getErrorMessage(err)}`;
        }
        ctx.send(input.entity, reply);
        return;
      }
      const parsed = parseModifiers(input.tokens, { domain: { type: "string" } });
      const topic = parsed.rest.join(" ").trim();
      const rawDomain = parsed.values.domain;
      const domainArg = typeof rawDomain === "string" ? rawDomain.toLowerCase() : undefined;
      if (!topic || parsed.errors.length) {
        ctx.send(input.entity, `Usage: lessons <topic> [domain:<${DOMAIN_HINT}>]`);
        return;
      }
      if (domainArg && !OUTCOME_DOMAINS.includes(domainArg as OutcomeDomain)) {
        ctx.send(
          input.entity,
          `Unknown domain "${domainArg}". Domains: ${OUTCOME_DOMAINS.join(", ")}.`,
        );
        return;
      }
      const domains = domainArg ? [domainArg as OutcomeDomain] : OUTCOME_DOMAINS;
      // The asker's own lessons (learned from its private work) ride with the
      // shared pool: a person reads its own, an agent its owner's.
      const name = ctx.getEntity?.(input.entity)?.name;
      const scope = name ? workScopeFor(deps.db, name) : undefined;
      const got = await recallAcross(deps.db, domains, topic, {
        limit: 8,
        maxBytes: 2_400,
        ...(scope?.kind === "owner" ? { owner: scope.owner } : {}),
      });
      if (got.mode === "off") {
        ctx.send(input.entity, "Lessons are off (MARINA_LESSONS=off).");
        return;
      }
      if (got.recalled.length === 0) {
        ctx.send(input.entity, `No lessons for "${topic}" yet.`);
        return;
      }
      ctx.send(
        input.entity,
        [
          header(`Lessons — ${topic}`),
          separator(),
          ...got.recalled.map(
            (l) =>
              `- ${formatLesson(l)} ${dim(`[${l.domain}${l.id ? ` ${l.id.slice(0, 8)}` : ""}]`)}`,
          ),
        ].join("\n"),
      );
    },
  };
}
