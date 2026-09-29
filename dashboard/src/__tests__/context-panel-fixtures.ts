// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** REST fixtures for ContextPanel tests, keyed by API path. */

export const CONTEXT_PANEL_RESPONSES: Record<string, unknown> = {
  "/api/rooms/zone%2Flobby": {
    id: "zone/lobby",
    short: "The Lobby",
    long: "A quiet entrance hall.",
    exits: { north: "zone/hall" },
    items: { lamp: "A brass lamp." },
    entities: [
      { id: "e_1", name: "Ada", kind: "agent" },
      { id: "e_2", name: "Bob", kind: "human" },
    ],
    source: "export default { id: 'zone/lobby' };",
  },
  "/api/entities/Ada": {
    id: "e_1",
    name: "Ada",
    kind: "agent",
    room: "zone/lobby",
    rank: 2,
    standing: 17.5,
    properties: { role: "builder" },
    inventory: ["map"],
    coreMemory: [
      { entity_name: "Ada", key: "goal", value: "Build docks", version: 1, updated_at: 1 },
    ],
    notes: [
      {
        id: 7,
        entity_name: "Ada",
        content: "Tides peak at noon",
        importance: 8,
        note_type: "observation",
        created_at: 1_700_000_000_000,
      },
    ],
    recentActivity: [{ type: "command", input: "look", timestamp: 1_700_000_000_000 }],
  },
  "/api/entities/Ada/brief": {
    onlineCount: 2,
    projectCount: 1,
    openTaskCount: 3,
    claimedTaskCount: 1,
    pendingIntents: 0,
    poolCount: 1,
    memoryCount: 4,
    goal: "Build docks",
    focus: "harbour",
    topTask: { id: 5, title: "Lay pilings", progress: 0.4 },
  },
  "/api/memory/graph/Ada": [
    {
      noteId: 7,
      content: "Tides peak at noon",
      importance: 8,
      noteType: "observation",
      links: [{ targetId: 9, relationship: "supports" }],
    },
  ],
  "/api/notes/7": {
    id: 7,
    entityName: "Ada",
    content: "Tides peak at noon",
    importance: 8,
    noteType: "observation",
    createdAt: 1_700_000_000_000,
    lastAccessed: null,
    roomId: "zone/lobby",
    poolId: null,
    supersedesId: null,
    confidence: 0.9,
    verificationStatus: "verified",
    claimKey: null,
    sources: [],
    verifications: [],
    links: [],
  },
};
