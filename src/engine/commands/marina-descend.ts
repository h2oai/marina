// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";
import type { WorldCollectiveManager } from "../../world/world-collective-manager";
import { notFound } from "./command-messages";

const HELP = `Create and operate sovereign Marina descendants through World Collective.
Gated capability: earn it via \`witness request admin.destructive\` or an operator grant (see \`standing\`).
Usage:
  marina-descend create <genome-hash> | <name> | <parents csv> | <mode> | <hypothesis> [| mutations csv]
  marina-descend start <descendant-id>
  marina-descend stop <descendant-id>
  marina-descend list`;

export function marinaDescendCommand(deps: {
  db: MarinaDB;
  manager: () => WorldCollectiveManager;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "marina-descend",
    aliases: [],
    category: "Lineage",
    minRank: 5,
    gate: "admin.destructive",
    help: HELP,
    handler: async (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "create") {
        const raw = input.args.slice(sub.length).trim();
        const [
          hash = "",
          name = "",
          parentsText = "",
          mode = "direct-fork",
          hypothesis = "",
          mutationsText = "",
          ...extra
        ] = raw.split("|").map((part) => part.trim());
        const genome = deps.db.getMarinaGenome(hash);
        if (!genome || !name || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        let manifest: { worldTemplate?: string };
        try {
          manifest = JSON.parse(genome.manifest_json) as { worldTemplate?: string };
        } catch {
          ctx.send(input.entity, `Genome ${hash} has a malformed manifest; cannot descend.`);
          return;
        }
        const variant = deps.manager().create({
          name,
          worldTemplate: manifest.worldTemplate ?? "default",
          hypothesis,
          createdBy: String(actor.id),
        });
        const row = deps.db.createMarinaDescendant({
          name,
          genomeHash: hash,
          parentWorldIds: parentsText
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
          mode,
          hypothesis,
          mutations: mutationsText
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
          initialHabitat: `world-variant:${variant.id}`,
          worldVariantId: variant.id,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Declared sovereign descendant ${row.id}; isolated runtime ${variant.id} is initially stopped.`,
        );
        return;
      }
      if (sub === "start" || sub === "stop") {
        const row = deps.db.getMarinaDescendant(input.tokens[1] ?? "");
        if (!row?.world_variant_id) {
          ctx.send(input.entity, notFound("descendant runtime", "marina-descend list"));
          return;
        }
        const variant =
          sub === "start"
            ? await deps.manager().start(row.world_variant_id)
            : await deps.manager().stop(row.world_variant_id);
        ctx.send(
          input.entity,
          `${row.id} runtime is ${variant.status} on port ${variant.ws_port}.`,
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listMarinaDescendants();
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((row) => `${row.id} · ${row.name} · ${row.genome_hash}`).join("\n")
            : "No Marina descendants recorded.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
