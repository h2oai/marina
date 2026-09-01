// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { header, separator } from "../../net/ansi";
import type { ComponentDisposition, MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

const HELP = `Create independently identified intellect descendants.
Usage:
  reproduce intellect <parent-ids csv> | <name> | <purpose> | <components JSON> [| contributors csv] [| evidence refs csv]
  reproduce show <reproduction-id>
  reproduce list
Component: {"kind":"model|memory|personality|architecture|...","ref":"...","disposition":"inherited|mutated|introduced|excluded","sourceRef":"..."}`;

export function reproduceCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "reproduce",
    aliases: ["offspring"],
    category: "Growth",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "intellect") {
        const raw = input.args.slice(sub.length).trim();
        const [
          parentsText = "",
          name = "",
          purpose = "",
          componentsText = "",
          contributorsText = "",
          evidenceText = "",
          ...extra
        ] = raw.split("|").map((x) => x.trim());
        let components: Array<{
          kind: string;
          ref: string;
          disposition: ComponentDisposition;
          sourceRef?: string;
        }> = [];
        try {
          components = JSON.parse(componentsText);
        } catch {}
        const parents = parentsText
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const dispositions = new Set(["inherited", "mutated", "introduced", "excluded"]);
        if (
          extra.length ||
          !name ||
          !parents.length ||
          parents.some((id) => !deps.db.getIntellect(id)) ||
          !Array.isArray(components) ||
          !components.length ||
          components.some(
            (c) =>
              !c ||
              typeof c.kind !== "string" ||
              typeof c.ref !== "string" ||
              !dispositions.has(c.disposition),
          )
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const child = deps.db.createIntellect({
          displayName: name,
          purpose,
          originMarina: process.env.MARINA_NAME ?? "local",
          createdBy: String(actor.id),
          contributors: (contributorsText || String(actor.id))
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        });
        for (const parent of parents) {
          deps.db.appendIntellectEvent({
            intellectId: child.id,
            kind: "descended",
            actorId: String(actor.id),
            relatedIntellectId: parent,
            data: { relationship: "descendant_of" },
          });
        }
        const row = deps.db.recordCognitiveReproduction({
          descendantIntellectId: child.id,
          mode: parents.length > 1 ? "recombination" : "descent",
          parentIds: parents,
          contributors: (contributorsText || String(actor.id))
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          hypothesis: purpose,
          evidenceRefs: evidenceText
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          components,
          createdBy: String(actor.id),
        });
        const active = components.filter((c) => c.disposition !== "excluded");
        const principal = active.find((c) => c.kind === "principal")?.ref;
        const model = active.find((c) => c.kind === "model")?.ref;
        const harness = active.find((c) => c.kind === "harness")?.ref;
        const environment = active.find((c) => c.kind === "environment")?.ref;
        if (principal || model || harness || environment)
          deps.db.createIntellectInstance({
            intellectId: child.id,
            localPrincipalId: principal,
            modelRef: model,
            harnessRef: harness,
            environmentRef: environment,
            createdBy: String(actor.id),
          });
        ctx.send(
          input.entity,
          `${header("Intellect descendant created")}\n${separator()}\n${child.id} · reproduction ${row.id}\nIndependent identity; ancestry does not imply ownership.`,
        );
        return;
      }
      if (sub === "show") {
        const row = deps.db.getCognitiveReproduction(input.tokens[1] ?? "");
        if (!row) {
          ctx.send(input.entity, "Reproduction not found.");
          return;
        }
        ctx.send(
          input.entity,
          `${header("Cognitive reproduction")}\n${separator()}\n${row.id}\nDescendant: ${row.descendant_intellect_id}\nMode: ${row.mode}\nParents: ${JSON.parse(row.parent_ids_json).join(", ")}\nComponents:\n${deps.db
            .listReproductionComponents(row.id)
            .map((c) => `  ${c.disposition} ${c.kind}:${c.ref}`)
            .join("\n")}`,
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listCognitiveReproductions();
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((r) => `${r.id} · ${r.descendant_intellect_id} · ${r.mode}`).join("\n")
            : "No cognitive reproductions recorded.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
