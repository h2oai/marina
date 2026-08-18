// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Demos World — guided demonstrations of Marina's core claims.
 *
 * Two rooms prove two things:
 *   demos/workshop — Self-bootstrapping: an AI agent builds a room from scratch
 *   demos/bridge   — Federation: two Marina instances connect and communicate
 *
 * Accessible to CEOs, grandmothers, and children. NPC guides explain everything.
 * A2UI dashboards visualize progress on the canvas.
 *
 * Any world can import these:
 *
 *   import { demoRooms } from "./demos";
 *   const world: WorldDefinition = {
 *     rooms: { ...demoRooms(), ...otherRooms },
 *     ...
 *   };
 *
 * Or use as a standalone world:
 *
 *   MARINA_WORLD=demos bun run start
 */

import type { MarinaDB } from "../src/persistence/database";
import type { Entity, RoomId, RoomModule } from "../src/types";
import { seedTraitsAndRoles } from "./seed";
import type { GuideNote, QuestDef, WorldDefinition } from "../src/world/world-definition";

import lobbyRoom from "./demos/lobby";
import workshopRoom from "./demos/workshop";
import bridgeRoom from "./demos/bridge";

// ─── Quests ────────────────────────────────────────────────────────────────

const BOOTSTRAP_QUEST: QuestDef = {
  id: "bootstrap",
  name: "The Self-Bootstrapping Loop",
  description:
    "Watch an AI agent spawn, build a room, write its code, and compile it — " +
    "then walk into the room it created.",
  reward: "Title: Architect's Apprentice",
  steps: [
    {
      id: "enter_workshop",
      description: "Enter the Workshop",
      hint: "Type 'workshop' or 'east' from the lobby.",
      check: (e: Entity) => !!e.properties.quest_entered_workshop,
    },
    {
      id: "spawn_agent",
      description: "Watch the Maker agent spawn",
      hint: "Type 'begin' in the Workshop.",
      check: (e: Entity) => !!e.properties.quest_agent_spawned,
    },
    {
      id: "room_built",
      description: "See the room get built",
      hint: "Wait for the Maker to finish. Type 'status' to check progress.",
      check: (e: Entity) => !!e.properties.quest_room_built,
    },
    {
      id: "visit_creation",
      description: "Visit the AI-built room",
      hint: "Type 'creation' to enter the room the Maker built.",
      check: (e: Entity) => !!e.properties.quest_visited_creation,
    },
  ],
  onComplete(entity: Entity) {
    entity.properties.title = "Architect's Apprentice";
  },
};

const FEDERATION_QUEST: QuestDef = {
  id: "federation",
  name: "The Bridge Between Worlds",
  description: "Connect two Marina instances and send a message across the bridge.",
  reward: "Title: Diplomat",
  steps: [
    {
      id: "enter_bridge",
      description: "Enter the Bridge",
      hint: "Type 'bridge' or 'west' from the lobby.",
      check: (e: Entity) => !!e.properties.quest_entered_bridge,
    },
    {
      id: "peer_launched",
      description: "Launch a peer instance",
      hint: "Type 'launch' in the Bridge room, then follow the instructions.",
      check: (e: Entity) => !!e.properties.quest_entered_bridge,
    },
    {
      id: "gateway_connected",
      description: "Connect the gateway",
      hint: "Type 'connect' then run the gateway command shown.",
      check: (e: Entity) => !!e.properties.quest_gateway_added,
    },
    {
      id: "channel_bridged",
      description: "Bridge a channel",
      hint: "Type 'link' then run the gateway bridge command.",
      check: (e: Entity) => !!e.properties.quest_channel_bridged,
    },
    {
      id: "message_sent",
      description: "Send a cross-instance message",
      hint: "Type 'ping' then send a message in the bridged channel.",
      check: (e: Entity) => !!e.properties.quest_cross_message,
    },
  ],
  onComplete(entity: Entity) {
    entity.properties.title = "Diplomat";
  },
};

// ─── Guide Notes ───────────────────────────────────────────────────────────

const GUIDE_NOTES: GuideNote[] = [
  {
    content:
      "The demos world has two guided experiences: " +
      "The Workshop (self-bootstrapping — an AI agent builds a room) and " +
      "The Bridge (federation — two Marina instances connect). " +
      "Start in the lobby and pick a direction.",
    importance: 9,
    type: "fact",
  },
  {
    content:
      "Self-bootstrapping means the system grows itself without developer intervention. " +
      "An AI agent spawns, creates a room, writes its TypeScript code, compiles it, " +
      "and the room becomes a living part of the world. " +
      "Visit The Workshop (east from lobby) and type 'begin'.",
    importance: 8,
    type: "fact",
  },
  {
    content:
      "Federation means scaling by connecting independent instances rather than " +
      "growing a single monolith. Each Marina is sovereign — its own database, " +
      "agents, and world. Gateways bridge channels between instances. " +
      "Visit The Bridge (west from lobby) and type 'launch'.",
    importance: 8,
    type: "fact",
  },
  {
    content:
      "The Maker agent is pre-registered at Architect rank (3) so it can write and " +
      "compile room code. In normal operation, agents earn rank through activity. " +
      "The rank system: Guest (0) < Citizen (1) < Builder (2) < Architect (3) < Admin (4).",
    importance: 6,
    type: "fact",
  },
  {
    content:
      "Rooms in Marina are TypeScript programs, not data. A room has lifecycle hooks " +
      "(onEnter, onLeave, onTick), custom commands, items, exits, and access to memory, " +
      "channels, boards, and HTTP. A room can be a database connector, a CI pipeline, " +
      "an LLM judge, or anything else expressible in TypeScript.",
    importance: 7,
    type: "fact",
  },
];

// ─── Seed ──────────────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);

  // Pre-register the Maker agent at Architect rank so it can build code/reload.
  // Name is the durable identity (used by getUserByName above); the id is
  // generated fresh on first seed to avoid collisions if this world is loaded
  // into a database that already has other users.
  const existing = db.getUserByName("Maker");
  if (!existing) {
    db.createUser({ id: `user_${crypto.randomUUID()}`, name: "Maker", rank: 3 });
  }

  // Create demos channel for federation demo
  try {
    db.createChannel({
      id: "ch_demos",
      type: "public",
      name: "demos",
      persistence: "permanent",
    });
  } catch {
    // Channel already exists
  }
}

// ─── Room Exports ──────────────────────────────────────────────────────────

/**
 * Returns demo rooms as a record, importable by any world.
 *
 *   import { demoRooms } from "./demos";
 *   const world: WorldDefinition = { rooms: { ...demoRooms(), ...otherRooms }, ... };
 */
// Individual exports for composition
export const demoLobby = lobbyRoom;
export const demoWorkshop = workshopRoom;
export const demoBridge = bridgeRoom;

export function demoRooms(): Record<string, RoomModule> {
  return {
    "demos/lobby": lobbyRoom,
    "demos/workshop": workshopRoom,
    "demos/bridge": bridgeRoom,
  };
}

// ─── World Export ──────────────────────────────────────────────────────────

const demosWorld: WorldDefinition = {
  name: "Demos",
  startRoom: "demos/lobby" as RoomId,
  rooms: demoRooms(),
  quests: [BOOTSTRAP_QUEST, FEDERATION_QUEST],
  autoQuest: "bootstrap",
  guideNotes: GUIDE_NOTES,
  seed,
};

export default demosWorld;
