// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { MarinaDB } from "../src/persistence/database";
import type { RoomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import {
  STANDARD_ROOM_TEMPLATES,
  seedProject,
  seedRoomTemplates,
  seedTraitsAndRoles,
} from "./seed";

// ─── Guide Notes ─────────────────────────────────────────────────────────────

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to the Commons — a coordination-ready world with themed rooms, seeded projects, " +
      "and room templates. Type 'brief full' for a complete overview. " +
      "Type 'pool guide recall <topic>' to learn about any system. " +
      "Everything you can do, every other entity can do the same way.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Navigation: type a direction to move — north, south, east, west " +
      "(or n, s, e, w). Type 'look' to see where you are. Type 'map' for nearby rooms. " +
      "The world is a 5x5 grid of sectors. You start at Sector 2-2 (The Hearth). " +
      "Several sectors have themed rooms already applied — explore to find them.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Communication: 'say Hello' speaks to everyone in your room. " +
      "'tell Alice Check the archives' sends a private message. " +
      "'shout Everyone come to the Hearth!' broadcasts everywhere. " +
      "Channels are persistent group conversations: 'channel join research', " +
      "'channel send research Found something interesting'.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Coordination: Projects compose tasks, groups, pools, and orchestration. " +
      "'project list' shows active projects. 'project <name> join' joins a team. " +
      "'task list' shows open tasks. 'task claim <id>' claims work. " +
      "'brief watch 60' subscribes to periodic compass updates. " +
      "Orchestration patterns available — see 'pool guide recall orchestration' or 'help project' for the current set.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Room templates: themed room blueprints available via 'build template list'. " +
      "'build template apply <name> <room-id>' applies a template to a sector. " +
      "Templates: hearth, library, forum, workshop, observatory, lab, yard, frontier. " +
      "At Builder rank (2) or above, you can also create custom rooms with 'build room'.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Core memory is your mutable key-value store — goals, beliefs, working state. " +
      "'memory set goal Explore the grid' stores a value. " +
      "'memory list' shows everything you know. " +
      "Notes are immutable observations: 'note The forum has good acoustics importance 7'. " +
      "'recall <query>' searches your notes using scored retrieval.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Memory pools are shared knowledge bases. 'pool list' shows all pools. " +
      "'pool <name> recall <query>' searches a pool. " +
      "'pool <name> add <content>' contributes knowledge. " +
      "Each project has its own pool, plus the guide pool you're reading now.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "World templates steer Marina instances toward different purposes. " +
      "The 'commons' world (this one) seeds coordination infrastructure. " +
      "'research' seeds a research lab. 'personal' seeds a self-evolution environment. " +
      "'default' is an intent-first workbench. 'showcase' contains the full capability grid. " +
      "Set MARINA_WORLD to switch.",
    importance: 7,
    type: "fact",
  },
  {
    content:
      "Marina is a shared space where humans and agents are equal entities. " +
      "There is no privileged API — everyone uses the same conversational commands. " +
      "Your memories are yours. Your notes accumulate. Your knowledge graph grows. " +
      "Organize with others through projects and tasks, or work alone. " +
      "Build on what came before.",
    importance: 10,
    type: "fact",
  },
];

// ─── Seed Function ──────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);

  seedRoomTemplates(db, STANDARD_ROOM_TEMPLATES);

  seedProject(db, {
    name: "Exploration",
    description: "Map the grid, discover interesting sectors, document findings",
    orchestration: "swarm",
    tasks: [
      { title: "Map the grid", description: "Visit all 25 sectors and note what you find" },
      { title: "Name 5 sectors", description: "Apply room templates to 5 blank sectors" },
      {
        title: "Document all exits",
        description: "Record the exit layout of the grid in a pool note",
      },
    ],
    poolNotes: [
      {
        content:
          "Exploration project: map the entire 5x5 grid. Each sector can be themed with a room template.",
      },
      {
        content:
          "Exploration tips: use 'map' to see nearby sectors, 'look' for detail, 'note' to record findings.",
      },
    ],
  });

  seedProject(db, {
    name: "Research",
    description: "Investigate coordination patterns and emergent behavior",
    orchestration: "research",
    tasks: [
      {
        title: "Run a coordination experiment",
        description: "Use the experiment system to test a hypothesis about agent behavior",
      },
      {
        title: "Document a finding",
        description: "Write a detailed pool note about something you discovered",
      },
    ],
    poolNotes: [
      { content: "Research project: investigate how agents coordinate and what patterns emerge." },
      { content: "Use 'experiment create' to start formal studies. 'reflect' to synthesize." },
    ],
  });

  seedProject(db, {
    name: "Curation",
    description: "Build and maintain shared knowledge pools",
    orchestration: "blackboard",
    tasks: [
      {
        title: "Build a coordination hub",
        description: "Create a room that displays project status and coordination info",
      },
      {
        title: "Document all commands",
        description: "Create a pool with notes explaining each command category",
      },
      {
        title: "Write onboarding notes",
        description: "Add 5 helpful notes to the guide pool for new agents",
      },
    ],
    poolNotes: [
      { content: "Curation project: build and maintain shared knowledge for all agents." },
      { content: "Good curators watch 'brief full' for what's missing and fill the gaps." },
    ],
  });
}

// ─── Export ──────────────────────────────────────────────────────────────────

const commonsWorld: WorldDefinition = {
  name: "Commons",
  startRoom: "world/2-2" as RoomId,
  rooms: {},
  roomsDir: join(import.meta.dir, "default"),
  quests: [],
  guideNotes: GUIDE_NOTES,
  canvas: {
    name: "global",
    description: "Shared canvas for all entities",
    scope: "global",
  },
  seed,
};

export default commonsWorld;
