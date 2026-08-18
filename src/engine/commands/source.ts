// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId, RoomModule } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";
import { requireRank } from "../permissions";

const ROOMS_DIR = join(import.meta.dir, "../../../rooms");

export interface SourceDeps {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  getRoom: (id: RoomId) => { id: RoomId; module: RoomModule } | undefined;
  getEntityRoom: (entityId: EntityId) => LoadedRoom | undefined;
}

function numberLines(source: string): string {
  return source
    .split("\n")
    .map((line, i) => `\x1b[2m${String(i + 1).padStart(3)}\x1b[0m ${line}`)
    .join("\n");
}

export function sourceCommand(deps: SourceDeps): CommandDef {
  return {
    name: "source",
    aliases: [],
    help: "View source code. Usage: source [here|room/id] | source command <name> | source connector <name>",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      // ── Subcommand: source command <name> ──
      if (sub === "command") {
        const name = tokens[1]?.toLowerCase();
        if (!name) {
          ctx.send(input.entity, "Usage: source command <name>");
          return;
        }
        if (!deps.db) {
          ctx.send(input.entity, "No database available.");
          return;
        }
        const cmd = deps.db.getCommandByName(name);
        if (!cmd) {
          ctx.send(input.entity, `Command "${name}" not found.`);
          return;
        }
        ctx.send(
          input.entity,
          `\x1b[1;36mCommand: ${cmd.name} (v${cmd.version}, dynamic)\x1b[0m\n${numberLines(cmd.source)}`,
        );
        return;
      }

      // ── Subcommand: source connector <name> (admin only) ──
      if (sub === "connector") {
        if (!requireRank(entity, 7)) {
          ctx.send(input.entity, "Requires steward rank (7).");
          return;
        }
        const name = tokens[1]?.toLowerCase();
        if (!name) {
          ctx.send(input.entity, "Usage: source connector <name>");
          return;
        }
        if (!deps.db) {
          ctx.send(input.entity, "No database available.");
          return;
        }
        const conn = deps.db.getConnectorByName(name);
        if (!conn) {
          ctx.send(input.entity, `Connector "${name}" not found.`);
          return;
        }
        const lines = [
          `\x1b[1;36mConnector: ${conn.name}\x1b[0m`,
          `  Transport: ${conn.transport}`,
          `  URL: ${conn.url ?? "(none)"}`,
          `  Command: ${conn.command ?? "(none)"}`,
          `  Args: ${conn.args ?? "(none)"}`,
          `  Auth type: ${conn.auth_type ?? "(none)"}`,
          "  Auth data: [REDACTED]",
          `  Lifecycle: ${conn.lifecycle}`,
          `  Created by: ${conn.created_by}`,
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ── Room source: resolve room ID ──
      let targetRoomId: string;

      if (!sub || sub === "here") {
        // Current room
        const room = deps.getEntityRoom(input.entity);
        if (!room) {
          ctx.send(input.entity, "You are not in a space.");
          return;
        }
        targetRoomId = room.id as string;
      } else if (sub.includes("/")) {
        // Explicit room ID
        targetRoomId = sub;
      } else {
        // Ambiguous: try as room first, then command fallback
        const room = deps.getRoom(sub as RoomId);
        if (room) {
          targetRoomId = sub;
        } else if (deps.db) {
          const cmd = deps.db.getCommandByName(sub);
          if (cmd) {
            ctx.send(
              input.entity,
              `\x1b[1;36mCommand: ${cmd.name} (v${cmd.version}, dynamic)\x1b[0m\n${numberLines(cmd.source)}`,
            );
            return;
          }
          ctx.send(input.entity, `No space or command "${sub}" found.`);
          return;
        } else {
          ctx.send(input.entity, `No space "${sub}" found.`);
          return;
        }
      }

      // ── Resolve room source: DB first, then file ──
      if (deps.db) {
        const dbSource = deps.db.getRoomSource(targetRoomId);
        if (dbSource) {
          ctx.send(
            input.entity,
            `\x1b[1;36mSpace: ${targetRoomId} (v${dbSource.version}, DB)\x1b[0m\n${numberLines(dbSource.source)}`,
          );
          return;
        }
      }

      // Try file-based
      try {
        const filePath = join(ROOMS_DIR, `${targetRoomId}.ts`);
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (exists) {
          const source = await file.text();
          ctx.send(
            input.entity,
            `\x1b[1;36mSpace: ${targetRoomId} (file)\x1b[0m\n${numberLines(source)}`,
          );
          return;
        }
      } catch {
        // Fall through to "not available"
      }

      ctx.send(input.entity, `No source available for "${targetRoomId}".`);
    },
  };
}
