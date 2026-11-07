// Copyright 2025-2026 H2O.ai, Inc.
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
import type { RoomId, RoomModule } from "../src/types";
import { rankLabel } from "../src/world/seed-guide";
import type { GuideNote, WorldDefinition } from "../src/world/world-definition";
import { seedTraitsAndRoles } from "./seed";

/** `build`'s command floor (src/engine/commands/build.ts `minRank`). */
const MAKER_RANK = 4;

import bridgeRoom from "./demos/bridge";
import lobbyRoom from "./demos/lobby";
import workshopRoom from "./demos/workshop";

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
      "To watch it: from the lobby type 'workshop' (or 'east'); type 'begin' to spawn the Maker; " +
      "'status' shows its progress; when the room is built, 'creation' takes you into it.",
    importance: 9,
    type: "fact",
  },
  {
    content:
      "Federation means scaling by connecting independent instances rather than " +
      "growing a single monolith. Each Marina is sovereign — its own database, " +
      "agents, and world. Gateways bridge channels between instances. " +
      "To try it: from the lobby type 'bridge' (or 'west'), then 'launch', 'connect', 'link' and " +
      "'ping' in turn, following the commands the Navigator shows.",
    importance: 8,
    type: "fact",
  },
  {
    content:
      `The Maker agent is pre-registered at ${rankLabel(MAKER_RANK)}, the rank \`build\` needs. ` +
      "Compiling and reloading room code also takes the world.code gate, which is never " +
      "seeded for an agent: the Maker's `build code` and `build reload` are held for an " +
      "operator, who answers with `challenge approve <token>` (or grants the gate " +
      "explicitly with `gate grant Maker world.code`). `standing` shows the path to every gate.",
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

  // Pre-register the Maker agent at `build`'s command floor. Gate grants are
  // never seeded for agents: `build code`/`reload` need world.code, so those
  // runs are held for an operator to approve (or grant explicitly). Name is
  // the durable identity; the id is generated fresh on first seed to avoid
  // collisions if this world is loaded into a database that already has other
  // users. A database seeded at the old rank 3 is raised to the floor.
  let maker = db.getUserByName("Maker");
  if (!maker) {
    db.createUser({ id: `user_${crypto.randomUUID()}`, name: "Maker", rank: MAKER_RANK });
    maker = db.getUserByName("Maker");
  } else if (maker.rank < MAKER_RANK) {
    db.updateUserRank(maker.id, MAKER_RANK);
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
  guideNotes: GUIDE_NOTES,
  seed,
};

export default demosWorld;
