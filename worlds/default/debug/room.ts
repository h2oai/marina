// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Debug Room",
  long: "Debugging and troubleshooting workspace. Inspect errors, analyze logs, test commands in isolation. Use 'look' to inspect room state, 'who' for entity status, 'brief full' for detailed system compass.",
  exits: {
    north: "craft/forge" as RoomId,
    east: "craft/review" as RoomId,
    south: "agent/modes" as RoomId,
    se: "coord/tasks" as RoomId,
  },
  items: {
    console: "Debug console. Inspect entity properties, room state, and command behavior.",
    logs: "Error and activity log viewer. Check entity_activity for success/failure rates.",
  },
};

export default room;
