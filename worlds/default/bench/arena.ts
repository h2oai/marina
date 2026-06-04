import type { RoomId, RoomModule } from "../../../src/types";
import { benchHub } from "../../evolve";

// Compose: grid room description + benchmark hub handlers (ArenaMaster NPC, scoreboard, onTick)
const room: RoomModule = {
  short: "Benchmark Arena",
  long: "Capability benchmarking and testing. Run navigation, retrieval, codegen, memory, adaptation, coordination, and collaboration tests. Scoreboard tracks all results. Use 'bench list' to see tests, 'examine scoreboard' for scores.",
  exits: {
    north: "analysis/room" as RoomId,
    south: "eval/chamber" as RoomId,
    west: "markets/floor" as RoomId,
    sw: "strategy/room" as RoomId,
    nw: "markets/desk" as RoomId,
  },
  items: {
    ...(benchHub.items as Record<string, string | ((...args: unknown[]) => string)>),
  },
  onEnter: benchHub.onEnter,
  onTick: benchHub.onTick,
  commands: benchHub.commands,
};

export default room;
