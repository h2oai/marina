// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Research Lab",
  long: "Web research and information gathering. Use 'web search <query>' to search the internet, 'web fetch <url>' to retrieve pages, 'note create' to save findings.",
  exits: {
    east: "knowledge/hub" as RoomId,
    south: "craft/studio" as RoomId,
    west: "observatory" as RoomId,
    se: "hub/crossroads" as RoomId,
  },
  items: {
    terminal: "Web research terminal. Use 'web search <query>' or 'web fetch <url>'.",
    notebook: "Save research findings with 'note create <text>'. Retrieve with 'recall <query>'.",
  },
};

export default room;
