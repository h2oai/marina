// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";
import { decodeInheritanceBundle, inheritanceDigest } from "../inheritance-bundle";

export function inheritCommand(deps: {
  db?: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "inherit",
    aliases: [],
    category: "Knowledge",
    minRank: 2,
    help: "Import a bounded Marina inheritance bundle as quarantined evidence. Usage: inherit <bundle-token>",
    handler: (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      if (!deps.db || !entity) return;
      const token = input.args.trim();
      if (!token) {
        ctx.send(input.entity, "Usage: inherit <bundle-token>");
        return;
      }
      try {
        const bundle = decodeInheritanceBundle(token);
        const digest = inheritanceDigest(token);
        const poolName = `inheritance:${digest.slice(0, 12)}`;
        const existing = deps.db.getMemoryPool(poolName);
        if (existing) {
          ctx.send(input.entity, `Inheritance bundle already imported as pool "${poolName}".`);
          return;
        }
        const poolId = `pool_inheritance_${digest.slice(0, 24)}`;
        deps.db.createMemoryPool(poolId, poolName, entity.name);
        for (const artifact of bundle.artifacts) {
          const provenance = `[Unverified inheritance · claimed source=${bundle.assertedSource} · original pool=${artifact.pool} · claimed author=${artifact.author}]`;
          deps.db.addPoolNote(
            poolId,
            entity.name,
            `${provenance} ${artifact.content}`,
            artifact.importance,
            "evidence",
          );
        }
        ctx.send(
          input.entity,
          `Imported ${bundle.artifacts.length} artifacts into "${poolName}" as unverified evidence. Nothing was activated, executed, or merged into guide/tradition memory.`,
        );
      } catch (cause) {
        ctx.send(
          input.entity,
          cause instanceof Error ? cause.message : "Inheritance import failed.",
        );
      }
    },
  };
}
