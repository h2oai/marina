// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Code Forge",
  long: "Code generation and room building. Create rooms, define dynamic commands, write and execute code. Use 'build room <id> <name>' to create rooms, 'build command create <name>' for dynamic commands.",
  exits: {
    north: "observatory" as RoomId,
    east: "craft/studio" as RoomId,
    south: "debug/room" as RoomId,
    se: "craft/review" as RoomId,
  },
  items: {
    workbench: "Room building tools. Use 'build room', 'build modify', 'build link', 'build code'.",
    compiler: "Dynamic command system. Use 'build command create/code/validate/reload <name>'.",
  },
};

export default room;
