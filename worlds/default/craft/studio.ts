// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { craftWorkshop } from "../../craft";

// Compose: grid room exits + craft workshop handlers (spec workflow, interview→spec→implement→ship)
const room: RoomModule = {
  short: "Spec Studio",
  long: "Specification and design workspace. The craft workflow: interview → spec → implement → ship. Use 'task goal' to set objectives, 'craft start' to begin a workflow.",
  exits: {
    north: "research/lab" as RoomId,
    east: "hub/crossroads" as RoomId,
    south: "craft/review" as RoomId,
    west: "craft/forge" as RoomId,
    ne: "knowledge/hub" as RoomId,
  },
  items: craftWorkshop.items,
  onEnter: craftWorkshop.onEnter,
  onTick: craftWorkshop.onTick,
  commands: craftWorkshop.commands,
};

export default room;
