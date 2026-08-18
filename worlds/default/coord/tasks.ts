// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Task Board",
  long: "Task management workspace. Create, claim, submit, and complete tasks. Track goals with progress. Use 'task create <title>', 'task claim <id>', 'task goal <title> | <desc>' for personal goals.",
  exits: {
    north: "craft/review" as RoomId,
    east: "coord/center" as RoomId,
    south: "projects/room" as RoomId,
    west: "agent/modes" as RoomId,
    ne: "commons" as RoomId,
    nw: "debug/room" as RoomId,
  },
  items: {
    board: "Task board showing open, claimed, and completed tasks. Use 'task list'.",
    goals:
      "Personal goal tracker. Use 'task goal <title> | <desc>' to set, 'task progress <id>' to update.",
  },
};

export default room;
