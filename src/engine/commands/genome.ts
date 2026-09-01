// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

const HELP = `Content-addressed Marina genomes.
Usage:
  genome create <world-template> | <components csv> | <compatibility csv> [| notes]
  genome show <sha256:hash>
  genome list`;
export function genomeCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "genome",
    aliases: ["genomes"],
    category: "Growth",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "create") {
        const raw = input.args.slice(sub.length).trim();
        const [worldTemplate = "", components = "", compatibility = "", notes = "", ...extra] = raw
          .split("|")
          .map((x) => x.trim());
        if (!worldTemplate || !components || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const row = deps.db.createMarinaGenome({
          manifest: {
            worldTemplate,
            components: components
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            compatibility: compatibility
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            notes,
          },
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Genome ${row.hash} created. Identical manifests converge on the same address.`,
        );
        return;
      }
      if (sub === "show") {
        const row = deps.db.getMarinaGenome(input.tokens[1] ?? "");
        ctx.send(input.entity, row ? `${row.hash}\n${row.manifest_json}` : "Genome not found.");
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listMarinaGenomes();
        ctx.send(
          input.entity,
          rows.length ? rows.map((r) => r.hash).join("\n") : "No Marina genomes recorded.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
