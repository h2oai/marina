// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { demoLobby } from "../../demos";

// Compose: grid room exits + demo lobby handlers (Guide NPC, tutorial)
const room: RoomModule = {
  short: "Launch Pad",
  long: "Agent spawning and lifecycle management. Spawn new agents with roles, traits, and models. The Guide NPC can walk you through getting started. Use 'agent spawn <name> --model <model> --role <role>'.",
  exits: {
    north: "coord/center" as RoomId,
    east: "memory/vault" as RoomId,
    west: "projects/room" as RoomId,
    ne: "channels/hub" as RoomId,
    nw: "coord/tasks" as RoomId,
  },
  items: {
    launcher: "Agent spawning console. Use 'agent spawn', 'agent list', 'agent stop <name>'.",
    roles: "Role and trait library. Use 'role list', 'trait list' to browse.",
    ...(demoLobby.items ?? {}),
  },
  onEnter: demoLobby.onEnter,
  onTick: demoLobby.onTick,
  commands: demoLobby.commands,
};

export default room;
