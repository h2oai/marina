// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { researchCenter } from "../../markets";

// Compose: grid room exits + research center handlers (research commands, evidence analysis)
const room: RoomModule = {
  short: "Forecast Desk",
  long: "Prediction research and meta-analysis. Analyze forecasting accuracy, study calibration, compare methods. Use 'market research <topic>' to investigate.",
  exits: {
    east: "analysis/room" as RoomId,
    south: "markets/floor" as RoomId,
    west: "knowledge/hub" as RoomId,
    sw: "hub/crossroads" as RoomId,
  },
  items: researchCenter.items,
  onEnter: researchCenter.onEnter,
  onTick: researchCenter.onTick,
  commands: researchCenter.commands,
};

export default room;
