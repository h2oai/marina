import { arrival, departure } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";

export function moveCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  getRoom: (entity: EntityId) => LoadedRoom | undefined;
  getRoomById: (id: RoomId) => LoadedRoom | undefined;
  moveEntity: (entity: EntityId, to: RoomId) => boolean;
  buildContext: (room: RoomId) => RoomContext | undefined;
  sendLook: (entity: EntityId) => void;
}): CommandDef {
  return {
    name: "move",
    aliases: [
      "go",
      "north",
      "south",
      "east",
      "west",
      "up",
      "down",
      "n",
      "s",
      "e",
      "w",
      "u",
      "d",
      "northeast",
      "northwest",
      "southeast",
      "southwest",
      "ne",
      "nw",
      "se",
      "sw",
    ],
    help: "Move in a direction. Usage: north, south, go <direction>",
    handler: (_ctx: RoomContext, input) => {
      const room = deps.getRoom(input.entity);
      if (!room) return;

      // The verb itself might be the direction (e.g., "north"),
      // or the direction is the arg (e.g., "go north")
      let direction = input.verb === "move" || input.verb === "go" ? input.args : input.verb;
      direction = expandDirection(direction);

      const exits = room.module.exits ?? {};
      const targetId = exits[direction];
      if (!targetId) {
        _ctx.send(input.entity, "You can't go that way.");
        return;
      }

      const target = deps.getRoomById(targetId);
      if (!target) {
        _ctx.send(input.entity, "That exit leads nowhere.");
        return;
      }

      // Check canEnter guard
      if (target.module.canEnter) {
        const targetCtx = deps.buildContext(targetId);
        if (targetCtx) {
          const result = target.module.canEnter(targetCtx, input.entity);
          if (result !== true) {
            _ctx.send(input.entity, result);
            return;
          }
        }
      }

      // Leave current room
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const name = entity.name;

      if (room.module.onLeave) {
        const ctx = deps.buildContext(room.id);
        if (ctx) room.module.onLeave(ctx, input.entity);
      }
      _ctx.broadcastExcept(input.entity, departure(name, direction), "leave");

      // Move
      deps.moveEntity(input.entity, targetId);

      // Enter new room
      const newCtx = deps.buildContext(targetId);
      if (newCtx) {
        newCtx.broadcastExcept(input.entity, arrival(name), "arrive");
        if (target.module.onEnter) {
          target.module.onEnter(newCtx, input.entity);
        }
      }

      // Auto-look
      deps.sendLook(input.entity);
    },
  };
}

function expandDirection(dir: string): string {
  const map: Record<string, string> = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    u: "up",
    d: "down",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
  };
  return map[dir] ?? dir;
}
