// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";
import { searchToolCommands } from "../../../src/world/rooms/search-room";

// The lab doubles as a search tool room (rooms-as-tools): `find … before:`,
// `archive <url> asof:`, `wiki <title> asof:`, `sources` — keyless, date-strict
// when bounded. The verbs avoid shadowing the global `search` command.
const searchTool = searchToolCommands({ verbs: { search: "find", fetch: "archive" } });

const room: RoomModule = {
  short: "Research Lab",
  long: "Web research and information gathering. Use 'web search <query>' to search the internet, 'web fetch <url>' to retrieve pages, 'note create' to save findings. Here, 'find <query> before:<date>' sees only what was published by then.",
  exits: {
    east: "knowledge/hub" as RoomId,
    south: "craft/studio" as RoomId,
    west: "observatory" as RoomId,
    se: "hub/crossroads" as RoomId,
  },
  items: {
    terminal: "Web research terminal. Use 'web search <query>' or 'web fetch <url>'.",
    notebook: "Save research findings with 'note create <text>'. Retrieve with 'recall <query>'.",
    catalog: searchTool.catalog,
  },
  commands: searchTool.commands,
};

export default room;
