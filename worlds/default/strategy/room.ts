// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Strategy Room",
  long: "Planning and orchestration. Design workflows, assign orchestration patterns, coordinate multi-agent operations. Run 'pool coordination-patterns recall' or 'help project' for the current pattern set.",
  exits: {
    north: "markets/floor" as RoomId,
    east: "eval/chamber" as RoomId,
    south: "channels/hub" as RoomId,
    west: "commons" as RoomId,
    nw: "hub/crossroads" as RoomId,
    ne: "bench/arena" as RoomId,
  },
  items: {
    patterns:
      "Orchestration pattern library. Use 'project <name> orchestrate <pattern>' to assign.",
    planner: "Multi-agent operation planner. Decompose problems into tasks, assign agents.",
  },
};

export default room;
