// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "System Config",
  long: "System configuration and security. Manage API keys, environment variables, MCP tools, and access controls. Use 'key list' to see configured keys, admin functions available via dashboard.",
  exits: {
    north: "agent/modes" as RoomId,
    east: "projects/room" as RoomId,
    ne: "coord/tasks" as RoomId,
  },
  items: {
    keys: "API key management. Use 'key add/remove/list' or dashboard Admin > Keys tab.",
    security: "Security configuration. Rate limits, SSRF protection, gateway auth.",
  },
};

export default room;
