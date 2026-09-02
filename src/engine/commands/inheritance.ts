// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef } from "../../types";
import {
  encodeInheritanceBundle,
  type InheritanceBundle,
  isExportableInheritancePool,
} from "../inheritance-bundle";
import { requiresPersistence } from "./command-messages";

export function inheritanceCommand(db?: MarinaDB): CommandDef {
  return {
    name: "inheritance",
    aliases: [],
    category: "Information",
    help: "Inspect or export shared Marina inheritance. Usage: inheritance [list] | inheritance export <guide|tradition-pool>",
    handler: (ctx, input) => {
      if (!db) {
        ctx.send(input.entity, requiresPersistence("inheritance"));
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
        lines.push("  Use: inheritance export <pool>");
        ctx.send(input.entity, lines.join("\n"));
        return;
      }
      if (sub !== "export") {
        ctx.send(input.entity, "Usage: inheritance [list] | inheritance export <pool>");
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
