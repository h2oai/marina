// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Analysis Room",
  long: "Data analysis, comparison, and reporting. Analyze task completion rates, agent performance metrics, project progress. Use 'novelty stats' for activity analysis, 'novelty suggest' for gap detection.",
  exits: {
    south: "bench/arena" as RoomId,
    west: "markets/desk" as RoomId,
    sw: "markets/floor" as RoomId,
  },
  items: {
    metrics: "Performance metrics dashboard. Use 'novelty stats' to see command success rates.",
    reports: "Generate analysis reports from task, project, and agent activity data.",
  },
};

export default room;
