import type { RoomId, RoomModule } from "../../src/types";

const room: RoomModule = {
  short: "Observatory",
  long: "World activity monitoring. Watch entity movements, event streams, and system metrics. Use 'who' for entity roster, 'brief' for world compass, 'novelty stats' for activity analysis.",
  exits: {
    east: "research/lab" as RoomId,
    south: "craft/forge" as RoomId,
    se: "craft/studio" as RoomId,
  },
  items: {
    dashboard: "Real-time feed of world events. Use 'brief' or 'brief full' to read.",
    tracker: "Entity position tracker. Use 'who' to see all online entities and their locations.",
  },
};

export default room;
