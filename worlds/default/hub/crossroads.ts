import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Crossroads",
  long: "Central hub of the world. All paths converge here. New entities arrive and orient. Use 'help' to see available commands, 'who' to see online entities, 'ls rooms' to list all rooms.",
  exits: {
    north: "knowledge/hub" as RoomId,
    south: "coord/center" as RoomId,
    east: "markets/floor" as RoomId,
    west: "craft/studio" as RoomId,
    ne: "markets/desk" as RoomId,
    nw: "research/lab" as RoomId,
    se: "strategy/room" as RoomId,
    sw: "craft/review" as RoomId,
  },
  items: {
    directory: "Use 'ls rooms' to list every room in the world — names, domains, and who's there right now. Then 'goto <room>' to navigate.",
    beacon: "Broadcasts world heartbeat — tick count, active entities, pending tasks.",
  },
};

export default room;
