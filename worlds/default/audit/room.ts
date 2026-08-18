// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Audit Room",
  long: "System audit, logging, and health monitoring. Review activity history, entity actions, command success rates, and system resource usage.",
  exits: {
    north: "integration/bay" as RoomId,
    west: "memory/vault" as RoomId,
    nw: "channels/hub" as RoomId,
  },
  items: {
    logs: "Activity log viewer. Entity actions, commands, errors — searchable history.",
    health: "System health dashboard. Memory usage, connection count, tick rate, uptime.",
  },
};

export default room;
