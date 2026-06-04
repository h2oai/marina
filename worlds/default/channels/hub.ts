import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Channels Hub",
  long: "Communication channels and messaging. Create channels, subscribe, send messages, manage broadcasts. Use 'channel create <name>', 'channel send <name> <msg>', 'channel sub <name>'.",
  exits: {
    north: "strategy/room" as RoomId,
    east: "integration/bay" as RoomId,
    south: "memory/vault" as RoomId,
    west: "coord/center" as RoomId,
    nw: "commons" as RoomId,
    ne: "eval/chamber" as RoomId,
  },
  items: {
    channels: "Channel directory. Use 'channel list' to browse, 'channel create' to add.",
    broadcasts: "Broadcast system. Use 'broadcast <message>' to reach all entities.",
  },
};

export default room;
