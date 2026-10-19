// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { competenceMap, renderCompetence } from "../../forecast/competence";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import { requiresPersistence } from "./command-messages";

const USAGE = [
  "Usage: competence [<family prefix>]        what Marina's resolved record says each method is good at",
  "       competence mine [<family prefix>]   the same, adding your own (and your agents') work",
  "       competence judged [<family prefix>] also show judged grades, labelled (judged)",
  "Families: work:task, work:code, work:request (+ :role:<role>), forecast classes, arena trackers, benchmark names.",
].join("\n");

/**
 * `competence` — the work-wide competence map: per (family, method), what the
 * one outcome path records — forecasts, arena rounds, benchmark runs, task
 * verdicts, Code Mode checks and reported requests. Read-only (rank 0). Work
 * done for a person stays in that person's own view (`competence mine`).
 */
export function competenceCommand(deps: {
  db?: Pick<MarinaDB, "listOutcomes">;
  getEntity?: (id: EntityId) => { name: string } | undefined;
}): CommandDef {
  return {
    category: "Information",
    usage: [
      { syntax: "competence [<family prefix>]", effect: "read" },
      { syntax: "competence mine [<family prefix>]", effect: "read" },
      { syntax: "competence judged [<family prefix>]", effect: "read" },
    ],
    name: "competence",
    aliases: [],
    minRank: 0,
    help: `Marina's competence map from its own resolved outcomes — per kind of work and method.\n${USAGE}`,
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) return ctx.send(input.entity, requiresPersistence("the competence map"));
      const tokens = input.args.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0]?.toLowerCase();
      if (first === "help" || tokens.length > 2) return ctx.send(input.entity, USAGE);
      const mine = first === "mine";
      const judged = first === "judged";
      const prefix = (mine || judged ? tokens[1] : tokens[0])?.replace(/^family:/, "");
      if (!mine && !judged && tokens.length > 1) return ctx.send(input.entity, USAGE);
      const viewer = mine ? deps.getEntity?.(input.entity)?.name : undefined;
      try {
        const cells = competenceMap(deps.db, {
          ...(prefix ? { family: prefix } : {}),
          ...(judged ? { includeJudged: true } : {}),
          ...(viewer ? { viewer } : {}),
        });
        ctx.send(input.entity, renderCompetence(cells));
      } catch (err) {
        ctx.send(input.entity, `Competence map unavailable: ${getErrorMessage(err)}`);
      }
    },
  };
}
