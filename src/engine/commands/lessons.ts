// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { formatLesson, OUTCOME_DOMAINS, type OutcomeDomain } from "../../learning/outcomes";
import { recallAcross } from "../../learning/service";
import { dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, RoomContext } from "../../types";
import { parseModifiers } from "../parse-input";
import { requiresPersistence } from "./command-messages";

/**
 * `lessons <topic> [domain:<d>]` — what past outcomes taught (src/learning/):
 * judged lessons from benchmark runs, resolved forecasts, Code Mode
 * verifications and arena rounds, trusted first, unverified labelled. Read-only.
 */
export function lessonsCommand(deps: { db?: MarinaDB }): CommandDef {
  return {
    category: "Knowledge",
    usage: ["lessons <topic>", "lessons <topic> domain:<forecast|code|tools|benchmark|arena>"],
    name: "lessons",
    aliases: [],
    minRank: 0,
    help: "Recall lessons Marina learned from past outcomes (benchmark runs, resolved forecasts, code verifications, arena rounds), trusted first.\nUsage: lessons <topic> [domain:<forecast|code|tools|benchmark|arena>]\n\nEvery verdict becomes a candidate lesson; the decision layer judges it and only passing (trusted) or unjudged (unverified, labelled) lessons are served. Read-only.",
    handler: async (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("lessons"));
        return;
      }
      const parsed = parseModifiers(input.tokens, { domain: { type: "string" } });
      const topic = parsed.rest.join(" ").trim();
      const rawDomain = parsed.values.domain;
      const domainArg = typeof rawDomain === "string" ? rawDomain.toLowerCase() : undefined;
      if (!topic || parsed.errors.length) {
        ctx.send(
          input.entity,
          "Usage: lessons <topic> [domain:<forecast|code|tools|benchmark|arena>]",
        );
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
      const got = await recallAcross(deps.db, domains, topic, { limit: 8, maxBytes: 2_400 });
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
