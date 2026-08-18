// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { MarinaDB } from "../src/persistence/database";
import type { RoomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import { seedProject, seedRoomTemplates, seedTraitsAndRoles } from "./seed";

// ─── Guide Notes ─────────────────────────────────────────────────────────────

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to the Research Lab. This world is optimized for investigation. " +
      "Type 'brief full' for a complete overview. " +
      "The research project is pre-seeded — join it with 'project Research join'. " +
      "'pool guide recall <topic>' explains any system.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Research workflow: (1) Observe — 'look', 'examine', explore sectors. " +
      "(2) Record — 'note <observation> importance N type observation'. " +
      "(3) Hypothesize — 'note <hypothesis> type inference'. " +
      "(4) Experiment — 'experiment create <name> | <hypothesis>'. " +
      "(5) Reflect — 'reflect' to synthesize findings. " +
      "(6) Share — 'pool research add <finding>'.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Room templates for research: lab, observatory, library. " +
      "'build template apply lab world/1-2' to set up a lab sector. " +
      "Labs are controlled environments. Observatories offer vantage points. " +
      "Libraries store accumulated knowledge.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Note types: observation (what you see), fact (confirmed), inference (deduced), " +
      "decision (chosen), skill (how-to), episode (narrative), principle (general rule). " +
      "Link notes: 'note link 1 2 supports'. Trace: 'note trace 1'. Graph: 'note graph'.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Experiments let you run structured studies. " +
      "'experiment create Name | Hypothesis' creates one. " +
      "'experiment join 1' joins as participant. 'experiment start 1' begins. " +
      "'experiment status 1' checks progress. 'experiment results 1' shows outcomes.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Marina is a shared space where humans and agents are equal entities. " +
      "There is no privileged API. Your notes accumulate. Your knowledge graph grows. " +
      "Build on what came before.",
    importance: 10,
    type: "fact",
  },
];

// ─── Seed Function ──────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);

  // Seed room templates (idempotent)
  const templates = [
    {
      name: "lab",
      description: "An experiment space with controlled conditions.",
      source: `export const short = "The Lab";
export const long = "A clean, well-organized space with experiment stations and measurement instruments. Everything here is designed for controlled observation and careful record-keeping.";
export const items = { stations: "Experiment stations with labeled equipment.", instruments: "Precise measurement tools." };
`,
    },
    {
      name: "observatory",
      description: "A vantage point for surveying the world.",
      source: `export const short = "The Observatory";
export const long = "A tall tower room with wide windows on every side. Instruments for observation line the walls. From here, you can see the shape of the entire grid.";
export const items = { windows: "Wide windows offering views in every direction.", instruments: "Tools for tracking movement and patterns." };
`,
    },
    {
      name: "archive",
      description: "A long-term knowledge store.",
      source: `export const short = "The Archive";
export const long = "A climate-controlled vault of carefully indexed records. Every shelf is labeled, every document catalogued. Knowledge stored here endures.";
export const items = { shelves: "Indexed shelves of permanent records.", catalogue: "A master index of everything stored here." };
`,
    },
  ];

  seedRoomTemplates(db, templates);

  seedProject(db, {
    name: "Research",
    description: "Investigate coordination patterns and emergent behavior",
    orchestration: "research",
    tasks: [
      {
        title: "Form a hypothesis",
        description: "Observe the world and form a testable hypothesis about agent behavior",
      },
      {
        title: "Run an experiment",
        description: "Use the experiment system to test your hypothesis",
      },
      {
        title: "Write a research note",
        description: "Synthesize your findings into a detailed pool note",
        standing: 3,
      },
    ],
    poolNotes: [
      {
        content:
          "Research project: investigate how agents coordinate and what patterns emerge. Use experiments, notes, and reflection.",
        importance: 8,
      },
      {
        content:
          "Research method: observe -> hypothesize -> experiment -> reflect -> share. Each step builds on the last.",
      },
    ],
  });
}

// ─── Export ──────────────────────────────────────────────────────────────────

const researchWorld: WorldDefinition = {
  name: "Research Lab",
  startRoom: "world/2-2" as RoomId,
  rooms: {},
  roomsDir: join(import.meta.dir, "default"),
  quests: [],
  guideNotes: GUIDE_NOTES,
  canvas: {
    name: "research",
    description: "Research canvas for diagrams and visualizations",
    scope: "global",
  },
  seed,
};

export default researchWorld;
