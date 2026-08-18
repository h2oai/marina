// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Knowledge Hub",
  long: "Knowledge management and memory operations. Create, recall, and organize notes. Manage core memory and knowledge graph relationships. Use 'recall <query>' to search, 'note create <text>' to save.",
  exits: {
    east: "markets/desk" as RoomId,
    south: "hub/crossroads" as RoomId,
    west: "research/lab" as RoomId,
    se: "markets/floor" as RoomId,
    sw: "craft/studio" as RoomId,
  },
  items: {
    archive:
      "Full-text search across all notes. Use 'recall <query>' with importance/recency weighting.",
    graph:
      "Knowledge graph with 6 relationship types. Use 'note link <id> <relation> <id>' to connect.",
    memory:
      "Core memory for persistent beliefs. Use 'memory set <key> <value>', 'memory get <key>'.",
  },
};

export default room;
