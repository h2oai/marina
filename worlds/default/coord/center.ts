// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Coordination Center",
  long: "Group coordination and delegation. Manage groups, memory pools, and multi-agent workflows. Use 'group create <name>', 'pool create <name>', 'group join <name>' to coordinate.",
  exits: {
    north: "commons" as RoomId,
    east: "channels/hub" as RoomId,
    south: "ops/launch" as RoomId,
    west: "coord/tasks" as RoomId,
    ne: "strategy/room" as RoomId,
    nw: "craft/review" as RoomId,
  },
  items: {
    groups: "Group management. Use 'group create/join/leave/list'. Groups share pools and tasks.",
    pools:
      "Memory pools for shared knowledge. Use 'pool create <name>', 'pool recall <pool> <query>'.",
  },
};

export default room;
