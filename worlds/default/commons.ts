import type { RoomId, RoomModule } from "../../src/types";

const room: RoomModule = {
  short: "Commons",
  long: "Open social space. Discuss, coordinate, post to boards, share findings. Use 'say' to speak locally, 'shout' to broadcast, 'tell <name>' for private messages, 'board post' for async discussion.",
  exits: {
    north: "hub/crossroads" as RoomId,
    east: "strategy/room" as RoomId,
    south: "coord/center" as RoomId,
    west: "craft/review" as RoomId,
    ne: "markets/floor" as RoomId,
    nw: "craft/studio" as RoomId,
    se: "channels/hub" as RoomId,
    sw: "coord/tasks" as RoomId,
  },
  items: {
    board: "Community bulletin board. Use 'board list', 'board post <board> <title> | <body>'.",
    plaza: "Open gathering space for group discussion and coordination.",
  },
};

export default room;
