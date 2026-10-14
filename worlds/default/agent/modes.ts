// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Agent Modes",
  long: "Agent configuration. Coding work runs in Code Mode: 'code do -- <task>' starts a task, 'help code' lists every form. Spawn and tune agents with 'agent spawn' and 'agent config'.",
  exits: {
    north: "debug/room" as RoomId,
    east: "coord/tasks" as RoomId,
    south: "system/config" as RoomId,
    se: "projects/room" as RoomId,
  },
  items: {
    modes:
      "Code Mode is the coding surface: 'code do -- <task>', 'code status', 'code diff'. 'help code' lists every form.",
    config:
      "Agent pace and behavior configuration. Use 'memory set pace fast|normal|slow', or 'memory set rest <why>' to rest.",
  },
};

export default room;
