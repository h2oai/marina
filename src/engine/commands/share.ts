// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { category, dim, header, id, separator, success } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";

/**
 * Share — quick deposit into a shared memory pool.
 *
 * Composes the two steps that "post to a pool" always involves: resolve
 * the pool by name (refuse to auto-create — that's `pool create`'s job)
 * and write the note with a reasonable default importance. Reuses
 * `pool <name> add` semantics under the hood; this is the named verb so
 * an agent doesn't have to remember the longer form.
 */
export function shareCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "share",
    aliases: [],
    help: "Drop a note into a shared pool. Usage: share <pool> <content>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (!deps.db) {
        ctx.send(input.entity, "Share requires database support.");
        return;
      }
      const db = deps.db;

      const poolName = input.tokens[0];
      const content = input.tokens.slice(1).join(" ").trim();
      if (!poolName || !content) {
        ctx.send(input.entity, "Usage: share <pool> <content>");
        return;
      }

      const pool = db.getMemoryPool(poolName);
      if (!pool) {
        ctx.send(
          input.entity,
          `Pool "${poolName}" not found. List pools with \`pool list\`, or create one with \`pool create ${poolName}\`.`,
        );
        return;
      }

      const noteId = db.addPoolNote(pool.id, entity.name, content, 6, "observation");
      deps.logEvent?.({
        type: "pool_note",
        entity: input.entity,
        noteId,
        poolName: pool.name,
        content,
        importance: 6,
        timestamp: Date.now(),
      });

      const lines = [
        header(`Shared to ${pool.name}`),
        separator(),
        category("Note"),
        `  ${id(noteId)} ${content}`,
        "",
        success(`Posted as #${noteId} (importance 6, type observation).`),
        dim(`Pool members can find this via \`pool ${pool.name} recall <topic>\`.`),
      ];
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
