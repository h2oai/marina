// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, CommandInput, Entity, RoomContext } from "../../types";
import {
  decodeInheritanceBundle,
  encodeInheritanceBundle,
  type InheritanceBundle,
  inheritanceDigest,
  isExportableInheritancePool,
} from "../inheritance-bundle";
import { getRank } from "../permissions";
import { requiresPersistence } from "./command-messages";

/**
 * One command for the whole inheritance domain. Historically `inheritance`
 * (list/export) and `inherit` (import) were separate commands with
 * near-identical names — a coin-flip discovery problem. `inherit <token>` is
 * kept as an alias that routes straight to import.
 */
export function inheritanceCommand(deps: {
  db?: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "inheritance",
    aliases: ["inherit"],
    category: "Knowledge",
    minRank: 0,
    help: "Inspect, export, or import shared Marina inheritance. Usage: inheritance [list] | inheritance export <guide|tradition-pool> | inheritance import <bundle-token> (import: rank 2+; `inherit <token>` also works)",
    handler: (ctx, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("inheritance"));
        return;
      }
      const db = deps.db;
      // Back-compat: invoked as `inherit`, the whole argument is a token.
      if (input.verb === "inherit") {
        importBundle(ctx, input, db, deps.getEntity, input.args.trim());
        return;
      }
      const sub = input.tokens[0]?.toLowerCase();
      if (!sub || sub === "list") {
        const pools = db
          .listMemoryPools()
          .filter((pool) => pool.group_id === null && isExportableInheritancePool(pool.name));
        const lines = [header("Shared Marina Inheritance"), separator()];
        if (pools.length === 0) lines.push("  No exportable guide or tradition pools yet.");
        for (const pool of pools)
          lines.push(`  ${pool.name} · ${db.countPoolNotes(pool.id)} notes`);
        lines.push(
          "  Exported bundles contain shared evidence only; private memory is never included.",
        );
        lines.push("  Use: inheritance export <pool> | inheritance import <bundle-token>");
        ctx.send(input.entity, lines.join("\n"));
        return;
      }
      if (sub === "import") {
        importBundle(ctx, input, db, deps.getEntity, input.tokens.slice(1).join(" ").trim());
        return;
      }
      if (sub !== "export") {
        ctx.send(
          input.entity,
          "Usage: inheritance [list] | inheritance export <pool> | inheritance import <bundle-token>",
        );
        return;
      }
      const name = input.tokens.slice(1).join(" ").trim();
      const pool = db.getMemoryPool(name);
      if (!pool || pool.group_id !== null || !isExportableInheritancePool(pool.name)) {
        ctx.send(input.entity, `Exportable inheritance pool "${name}" not found.`);
        return;
      }
      const artifacts = db
        .getPoolNotes(pool.id, 50)
        .filter((note) => note.content.length <= 1_000)
        .slice(0, 12)
        .map((note) => ({
          pool: pool.name,
          author: note.entity_name,
          content: note.content,
          noteType: note.note_type,
          importance: note.importance,
          createdAt: note.created_at,
        }));
      if (artifacts.length === 0) {
        ctx.send(input.entity, `Inheritance pool "${name}" has no bounded exportable notes.`);
        return;
      }
      const bundle: InheritanceBundle = {
        schema: "marina.inheritance.v1",
        assertedSource: (process.env.MARINA_NAME ?? "marina").slice(0, 80),
        createdAt: Date.now(),
        artifacts,
      };
      try {
        const token = encodeInheritanceBundle(bundle);
        ctx.send(
          input.entity,
          `Inheritance bundle ${bundle.schema} (${artifacts.length} artifacts). Claimed source is unverified until independently authenticated.\ninherit ${token}`,
        );
      } catch (cause) {
        ctx.send(
          input.entity,
          cause instanceof Error ? cause.message : "Inheritance export failed.",
        );
      }
    },
  };
}

/** Import a bounded bundle as quarantined evidence. Requires rank 2+. */
function importBundle(
  ctx: RoomContext,
  input: CommandInput,
  db: MarinaDB,
  getEntity: (id: string) => Entity | undefined,
  token: string,
): void {
  const entity = getEntity(input.entity);
  if (!entity) return;
  if (!token) {
    ctx.send(input.entity, "Usage: inheritance import <bundle-token>");
    return;
  }
  // Import writes a new pool — kept at the old `inherit` command's rank floor.
  if (getRank(entity) < 2) {
    ctx.send(input.entity, "Importing an inheritance bundle requires rank 2+.");
    return;
  }
  try {
    const bundle = decodeInheritanceBundle(token);
    const digest = inheritanceDigest(token);
    const poolName = `inheritance:${digest.slice(0, 12)}`;
    const existing = db.getMemoryPool(poolName);
    if (existing) {
      ctx.send(input.entity, `Inheritance bundle already imported as pool "${poolName}".`);
      return;
    }
    const poolId = `pool_inheritance_${digest.slice(0, 24)}`;
    db.createMemoryPool(poolId, poolName, entity.name);
    for (const artifact of bundle.artifacts) {
      const provenance = `[Unverified inheritance · claimed source=${bundle.assertedSource} · original pool=${artifact.pool} · claimed author=${artifact.author}]`;
      db.addPoolNote(
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
    ctx.send(input.entity, cause instanceof Error ? cause.message : "Inheritance import failed.");
  }
}
