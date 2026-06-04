import type { RoomId, RoomModule } from "../../../src/types";
import { tradingFloor } from "../../markets";

// Compose: grid room exits + trading floor handlers (market feeds, commands, onTick)
const room: RoomModule = {
  short: "Trade Floor",
  long: "Prediction markets and live data feeds. Monitor markets, stake positions, track Brier scores. Use 'market list' to browse, 'market watch <feed>' for live data, 'market position <claim>' to stake.",
  exits: {
    north: "markets/desk" as RoomId,
    east: "bench/arena" as RoomId,
    south: "strategy/room" as RoomId,
    west: "hub/crossroads" as RoomId,
    nw: "knowledge/hub" as RoomId,
    ne: "analysis/room" as RoomId,
  },
  items: tradingFloor.items,
  onEnter: tradingFloor.onEnter,
  onTick: tradingFloor.onTick,
  commands: tradingFloor.commands,
};

export default room;
