// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { researchCenter } from "../../markets";

// Compose: grid room exits + research center items (the research center has no handlers)
const room: RoomModule = {
  short: "Forecast Desk",
  long: "Prediction research and meta-analysis. Analyze forecasting accuracy, study calibration, compare methods. Use 'forecast <question>' for a cited multi-model forecast, 'web search <query>' for evidence, and 'arena' for the Social Simulation Arena.",
  exits: {
    east: "analysis/room" as RoomId,
    south: "markets/floor" as RoomId,
    west: "knowledge/hub" as RoomId,
    sw: "hub/crossroads" as RoomId,
  },
  items: researchCenter.items,
};

export default room;
