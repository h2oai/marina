// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Memory Vault",
  long: "Memory pools and shared knowledge systems. Create pools for team knowledge, manage belief systems, review contradictions. Use 'pool create <name>', 'pool note <pool> <text>', 'pool recall <pool> <query>'.",
  exits: {
    north: "channels/hub" as RoomId,
    east: "audit/room" as RoomId,
    west: "ops/launch" as RoomId,
    nw: "coord/center" as RoomId,
    ne: "integration/bay" as RoomId,
  },
  items: {
    vault: "Memory pool storage. Each pool is a shared knowledge base for a group.",
    beliefs: "Belief system manager. Core memory beliefs with contradiction detection.",
  },
};

export default room;
