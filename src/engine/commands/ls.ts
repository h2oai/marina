import type { Board } from "../../coordination/board-manager";
import { boardTag, category, dim, entity as fmtEntity, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";

export function lsCommand(deps: {
  getEntityRoom: (entity: EntityId) => LoadedRoom | undefined;
  getAllRooms: () => LoadedRoom[];
  getAllEntities: () => Entity[];
  getEntitiesInRoom: (room: RoomId) => Entity[];
  getRoomBoards?: (roomId: string) => Board[];
}): CommandDef {
  return {
    name: "ls",
    aliases: ["list", "dir"],
    help: "Browse rooms, entities, and room contents. Usage: ls [rooms|entities|<room-id>]",
    handler: (ctx: RoomContext, input) => {
      const sub = input.tokens[0]?.toLowerCase();

      if (!sub) {
        lsCurrent(ctx, input.entity, deps);
      } else if (sub === "rooms") {
        lsRooms(ctx, input.entity, deps);
      } else if (sub === "entities") {
        lsEntities(ctx, input.entity, deps);
      } else {
        lsPath(ctx, input.entity, sub, deps);
      }
    },
  };
}

/** ls (no args) — compact view of current room */
function lsCurrent(
  ctx: RoomContext,
  entityId: EntityId,
  deps: {
    getEntityRoom: (entity: EntityId) => LoadedRoom | undefined;
    getEntitiesInRoom: (room: RoomId) => Entity[];
    getRoomBoards?: (roomId: string) => Board[];
  },
): void {
  const room = deps.getEntityRoom(entityId);
  if (!room) {
    ctx.send(entityId, "You are nowhere.");
    return;
  }

  const lines: string[] = [header(`${room.module.short} ${dim(`(${room.id})`)}`), separator(50)];

  // Entities
  const entities = deps.getEntitiesInRoom(room.id).filter((e) => e.id !== entityId);
  if (entities.length > 0) {
    lines.push(category("Entities"));
    for (const e of entities) {
      lines.push(`  ${fmtEntity(e.name)} ${dim(`[${e.kind}]`)} ${dim(e.short)}`);
    }
  }

  // Items
  const items = room.module.items ?? {};
  const itemNames = Object.keys(items);
  if (itemNames.length > 0) {
    lines.push(category("Objects"));
    for (const name of itemNames) {
      lines.push(`  ${name}`);
    }
  }

  // Exits
  const exits = room.module.exits ?? {};
  const exitEntries = Object.entries(exits);
  if (exitEntries.length > 0) {
    lines.push(category("Exits"));
    for (const [dir, target] of exitEntries) {
      lines.push(`  ${dir} → ${dim(target as string)}`);
    }
  }

  // Boards
  if (deps.getRoomBoards) {
    const boards = deps.getRoomBoards(room.id as string);
    if (boards.length > 0) {
      lines.push(boardTag(boards.map((b) => b.name).join(", ")));
    }
  }

  ctx.send(entityId, lines.join("\n"));
}

/** ls rooms — all rooms grouped by path prefix */
function lsRooms(
  ctx: RoomContext,
  entityId: EntityId,
  deps: {
    getAllRooms: () => LoadedRoom[];
    getEntitiesInRoom: (room: RoomId) => Entity[];
  },
): void {
  const rooms = deps.getAllRooms();
  if (rooms.length === 0) {
    ctx.send(entityId, "No rooms found.");
    return;
  }

  // Group by prefix (part before first /)
  const groups = new Map<string, LoadedRoom[]>();
  for (const room of rooms) {
    const id = room.id as string;
    const slash = id.indexOf("/");
    const prefix = slash >= 0 ? id.slice(0, slash) : id;
    let list = groups.get(prefix);
    if (!list) {
      list = [];
      groups.set(prefix, list);
    }
    list.push(room);
  }

  // Sort groups alphabetically, sort rooms within each group
  const sortedKeys = [...groups.keys()].sort();
  const lines: string[] = [header(`Rooms (${rooms.length})`), separator(50)];

  for (const prefix of sortedKeys) {
    const groupRooms = groups.get(prefix)!;
    groupRooms.sort((a, b) => (a.id as string).localeCompare(b.id as string));
    lines.push(category(prefix));
    for (const room of groupRooms) {
      const pop = deps.getEntitiesInRoom(room.id).length;
      const popStr = pop > 0 ? ` ${dim(`(${pop})`)}` : "";
      lines.push(`  ${dim(room.id as string)} ${room.module.short}${popStr}`);
    }
  }

  ctx.send(entityId, lines.join("\n"));
}

/** ls entities — all entities grouped by kind */
function lsEntities(
  ctx: RoomContext,
  entityId: EntityId,
  deps: { getAllEntities: () => Entity[] },
): void {
  const entities = deps.getAllEntities();
  if (entities.length === 0) {
    ctx.send(entityId, "No entities found.");
    return;
  }

  const byKind = new Map<string, Entity[]>();
  for (const e of entities) {
    let list = byKind.get(e.kind);
    if (!list) {
      list = [];
      byKind.set(e.kind, list);
    }
    list.push(e);
  }

  const kindOrder = ["agent", "npc", "object"];
  const lines: string[] = [header(`Entities (${entities.length})`), separator(50)];

  for (const kind of kindOrder) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(category(`${kind}s (${group.length})`));
    for (const e of group) {
      lines.push(`  ${fmtEntity(e.name)} ${dim(`in ${e.room}`)}`);
    }
  }

  ctx.send(entityId, lines.join("\n"));
}

/** ls <path> — exact match or prefix match on room IDs */
function lsPath(
  ctx: RoomContext,
  entityId: EntityId,
  path: string,
  deps: {
    getAllRooms: () => LoadedRoom[];
    getEntitiesInRoom: (room: RoomId) => Entity[];
    getRoomBoards?: (roomId: string) => Board[];
  },
): void {
  const rooms = deps.getAllRooms();

  // Exact match
  const exact = rooms.find((r) => (r.id as string) === path);
  if (exact) {
    const lines: string[] = [
      header(`${exact.module.short} ${dim(`(${exact.id})`)}`),
      separator(50),
    ];

    const entities = deps.getEntitiesInRoom(exact.id);
    if (entities.length > 0) {
      lines.push(category("Entities"));
      for (const e of entities) {
        lines.push(`  ${fmtEntity(e.name)} ${dim(`[${e.kind}]`)} ${dim(e.short)}`);
      }
    }

    const exits = exact.module.exits ?? {};
    const exitEntries = Object.entries(exits);
    if (exitEntries.length > 0) {
      lines.push(category("Exits"));
      for (const [dir, target] of exitEntries) {
        lines.push(`  ${dir} → ${dim(target as string)}`);
      }
    }

    if (deps.getRoomBoards) {
      const boards = deps.getRoomBoards(exact.id as string);
      if (boards.length > 0) {
        lines.push(boardTag(boards.map((b) => b.name).join(", ")));
      }
    }

    ctx.send(entityId, lines.join("\n"));
    return;
  }

  // Prefix match
  const matches = rooms.filter((r) => (r.id as string).startsWith(path));
  if (matches.length === 0) {
    ctx.send(entityId, `No rooms matching "${path}".`);
    return;
  }

  matches.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  const lines: string[] = [header(`Rooms matching "${path}" (${matches.length})`), separator(50)];
  for (const room of matches) {
    const pop = deps.getEntitiesInRoom(room.id).length;
    const popStr = pop > 0 ? ` ${dim(`(${pop})`)}` : "";
    lines.push(`  ${dim(room.id as string)} ${room.module.short}${popStr}`);
  }

  ctx.send(entityId, lines.join("\n"));
}
