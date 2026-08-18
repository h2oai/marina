// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { craftReview } from "../../craft";

// Compose: grid room exits + craft review handlers (verification, holdout wall)
const room: RoomModule = {
  short: "Review Room",
  long: "Code and spec review workspace. Verify implementations against specs, run validation, approve or reject. The holdout wall — nothing ships without review.",
  exits: {
    north: "craft/studio" as RoomId,
    east: "commons" as RoomId,
    south: "coord/tasks" as RoomId,
    west: "debug/room" as RoomId,
    nw: "craft/forge" as RoomId,
    ne: "hub/crossroads" as RoomId,
  },
  items: craftReview.items,
  onEnter: craftReview.onEnter,
  onTick: craftReview.onTick,
  commands: craftReview.commands,
};

export default room;
