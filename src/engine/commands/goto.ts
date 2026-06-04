import { arrival, dim } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";

export function gotoCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  getRoomById: (id: RoomId) => LoadedRoom | undefined;
  hasRoom: (id: RoomId) => boolean;
  moveEntity: (entity: EntityId, to: RoomId) => boolean;
  buildContext: (room: RoomId) => RoomContext | undefined;
  sendLook: (entity: EntityId) => void;
  getAllEntities: () => Entity[];
  getEntityRoom: (entity: EntityId) => LoadedRoom | undefined;
}): CommandDef {
  return {
    name: "goto",
    aliases: ["tp", "teleport"],
    help: "Teleport to a room or entity. Usage: goto <room-id|entity-name>",
    handler: (ctx: RoomContext, input) => {
      if (!input.args) {
        ctx.send(input.entity, "Usage: goto <room-id|entity-name>");
        return;
      }

      const target = input.args;
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const currentRoom = deps.getEntityRoom(input.entity);
      const currentRoomId = currentRoom?.id;

      // Try as room ID first
      const targetRoomId = target as RoomId;
      if (deps.hasRoom(targetRoomId)) {
        if (currentRoomId === targetRoomId) {
          ctx.send(input.entity, "You are already there.");
          return;
        }
        teleport(ctx, input.entity, entity.name, currentRoom, targetRoomId, deps);
        return;
      }

      // Try as entity name (case-insensitive exact, then prefix)
      const allEntities = deps.getAllEntities();
      const lowerTarget = target.toLowerCase();

      // Exact match first
      let found = allEntities.find((e) => e.name.toLowerCase() === lowerTarget);

      // Prefix match fallback
      if (!found) {
        found = allEntities.find((e) => e.name.toLowerCase().startsWith(lowerTarget));
      }

      if (found) {
        if (found.room === currentRoomId) {
          ctx.send(input.entity, "You are already there.");
          return;
        }
        ctx.send(input.entity, dim(`Teleporting to ${found.name}...`));
        teleport(ctx, input.entity, entity.name, currentRoom, found.room, deps);
        return;
      }

      ctx.send(input.entity, `No room or entity matching "${target}".`);
    },
  };
}

function teleport(
  ctx: RoomContext,
  entityId: EntityId,
  name: string,
  currentRoom: LoadedRoom | undefined,
  targetRoomId: RoomId,
  deps: {
    getRoomById: (id: RoomId) => LoadedRoom | undefined;
    moveEntity: (entity: EntityId, to: RoomId) => boolean;
    buildContext: (room: RoomId) => RoomContext | undefined;
    sendLook: (entity: EntityId) => void;
  },
): void {
  // Fire onLeave in current room
  if (currentRoom?.module.onLeave) {
    const oldCtx = deps.buildContext(currentRoom.id);
    if (oldCtx) currentRoom.module.onLeave(oldCtx, entityId);
  }

  // Broadcast departure
  ctx.broadcastExcept(entityId, dim(`${name} vanishes.`), "leave");

  // Move
  deps.moveEntity(entityId, targetRoomId);

  // Fire onEnter + broadcast arrival in new room
  const target = deps.getRoomById(targetRoomId);
  const newCtx = deps.buildContext(targetRoomId);
  if (newCtx) {
    newCtx.broadcastExcept(entityId, arrival(name), "arrive");
    if (target?.module.onEnter) {
      target.module.onEnter(newCtx, entityId);
    }
  }

  // Auto-look
  deps.sendLook(entityId);
}
