// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../src/persistence/database";
import type { RoomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import { seedTraitsAndRoles } from "./seed";

const emptyWorld: WorldDefinition = {
  name: "Empty",
  startRoom: "void/center" as RoomId,
  rooms: {
    "void/center": {
      short: "The Void",
      long: "An infinite expanse of nothing. You float in silence.",
    },
  },
  quests: [],
  guideNotes: [],
  seed: (db: MarinaDB) => seedTraitsAndRoles(db),
};

export default emptyWorld;
