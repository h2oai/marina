// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Integration Bay",
  long: "External platform integrations. Connect Telegram, Discord, and other services. Manage adapters, federation gateways, and API connectors.",
  exits: {
    north: "eval/chamber" as RoomId,
    south: "audit/room" as RoomId,
    west: "channels/hub" as RoomId,
    sw: "memory/vault" as RoomId,
    nw: "strategy/room" as RoomId,
  },
  items: {
    adapters: "Platform adapter management. Configure Telegram/Discord bot tokens via dashboard.",
    gateway: "Federation gateway for connecting multiple Marina instances.",
  },
};

export default room;
