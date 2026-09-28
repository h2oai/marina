// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { auditKnowledgeNotes } from "../src/engine/commands/knowledge-hygiene";
import { MarinaDB, type NoteRow } from "../src/persistence/database";
import type { RoomModule } from "../src/types";
import { PLATFORM_GUIDE_NOTES } from "../src/world/seed-guide";
import type { WorldDefinition } from "../src/world/world-definition";
import { loadWorld } from "../src/world/world-loader";
import dataInvestigationWorld from "../worlds/data-investigation";
import deepResearchWorld from "../worlds/deep-research";
import defaultWorld from "../worlds/default";
import dueDiligenceWorld from "../worlds/due-diligence";
import predictionLabWorld from "../worlds/prediction-lab";
import redTeamWorld from "../worlds/red-team";
import showcaseWorld from "../worlds/showcase";
import { createTestEngine } from "./engine-fixture";
import { cleanupDb } from "./helpers";

async function loadWorldRooms(world: WorldDefinition): Promise<Map<string, RoomModule>> {
  const rooms = new Map<string, RoomModule>(Object.entries(world.rooms));
  if (!world.roomsDir) return rooms;

  for await (const file of new Glob("**/*.ts").scan({ cwd: world.roomsDir, absolute: true })) {
    const id = relative(world.roomsDir, file).replace(/\.ts$/, "");
    const module = await import(file);
    rooms.set(id, module.default ?? module);
  }
  return rooms;
}

describe.each([
  ["default", defaultWorld],
  ["showcase", showcaseWorld],
] as const)("%s world definition", (_name, world) => {
  it("has a valid start room, exits, and unique grid positions", async () => {
    const rooms = await loadWorldRooms(world);
    expect(rooms.has(world.startRoom)).toBe(true);

    for (const [id, room] of rooms) {
      expect(room.short.length).toBeGreaterThan(0);
      expect(room.long.length).toBeGreaterThan(0);
      for (const target of Object.values(room.exits ?? {})) {
        expect(rooms.has(target), `${id} exits to missing room ${target}`).toBe(true);
      }
    }

    const positions = Object.entries(world.gridPositions ?? {});
    expect(positions).toHaveLength(rooms.size);
    expect(new Set(positions.map(([, pos]) => `${pos.row},${pos.col}`)).size).toBe(
      positions.length,
    );
    for (const [id] of positions) expect(rooms.has(id)).toBe(true);
  });

  it("seeds its launch content idempotently", () => {
    const dbPath = `test_world_${world.name.toLowerCase()}.db`;
    cleanupDb(dbPath);
    const db = new MarinaDB(dbPath);
    try {
      world.seed?.(db);
      expect(
        db.getProjectByName(world.name === "Workbench" ? "Demo Pulse" : "Debut Tour"),
      ).toBeTruthy();
      const first = {
        agents: db.getAllAgentConfigs().length,
        pools: db.listMemoryPools().length,
        projects: db.listProjects().length,
        tasks: db.listTasks().length,
      };
      world.seed?.(db);
      expect({
        agents: db.getAllAgentConfigs().length,
        pools: db.listMemoryPools().length,
        projects: db.listProjects().length,
        tasks: db.listTasks().length,
      }).toEqual(first);
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });
});

describe("launch paths", () => {
  it("keeps the default world focused and the showcase world curated", () => {
    expect(Object.keys(defaultWorld.rooms)).toHaveLength(4);
    expect(defaultWorld.autoBootstrap).toContain("channel join general");
    expect(showcaseWorld.guideNotes[0]?.content).toContain("Debut Tour");
    expect(showcaseWorld.autoBootstrap).toContain("channel join general");
  });
});

const focusedWorlds = [
  ["prediction-lab", predictionLabWorld, "Calibration Sprint"],
  ["deep-research", deepResearchWorld, "Research Brief"],
  ["red-team", redTeamWorld, "Launch Plan Challenge"],
  ["due-diligence", dueDiligenceWorld, "Example Company Diligence"],
  ["data-investigation", dataInvestigationWorld, "Anomaly Investigation"],
] as const;

describe.each(focusedWorlds)("%s example world", (slug, world, project) => {
  it("has a closed, dashboard-positioned workflow topology", async () => {
    const rooms = await loadWorldRooms(world);
    expect(rooms.has(world.startRoom)).toBe(true);
    expect(rooms.size).toBeGreaterThanOrEqual(5);
    for (const [id, room] of rooms) {
      for (const target of Object.values(room.exits ?? {})) {
        expect(rooms.has(target), `${id} exits to missing room ${target}`).toBe(true);
      }
    }
    expect(Object.keys(world.gridPositions ?? {})).toHaveLength(rooms.size);
    expect(world.autoBootstrap?.some((command) => command.startsWith("channel join "))).toBe(true);
  });

  it("seeds its project, collaboration surfaces, and agents idempotently", () => {
    const dbPath = `test_world_${slug}.db`;
    cleanupDb(dbPath);
    const db = new MarinaDB(dbPath);
    try {
      world.seed?.(db);
      expect(db.getProjectByName(project)).toBeTruthy();
      expect(db.getAllAgentConfigs().length).toBeGreaterThanOrEqual(3);
      const first = {
        agents: db.getAllAgentConfigs().length,
        boards: db.getAllBoards().length,
        channels: db.getAllChannels().length,
        pools: db.listMemoryPools().length,
        projects: db.listProjects().length,
        tasks: db.listTasks().length,
      };
      world.seed?.(db);
      expect({
        agents: db.getAllAgentConfigs().length,
        boards: db.getAllBoards().length,
        channels: db.getAllChannels().length,
        pools: db.listMemoryPools().length,
        projects: db.listProjects().length,
        tasks: db.listTasks().length,
      }).toEqual(first);
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });
});

/** Every builtin world under worlds/ (helper modules export no WorldDefinition). */
const WORLDS_DIR = join(import.meta.dir, "..", "worlds");
const HELPER_MODULES = new Set(["seed", "focused-example"]);
/** Single-quoted phrases in world text that are names or values, not commands. */
const QUOTED_NON_COMMANDS = new Set([
  "anomaly investigation",
  "example company diligence",
  "launch plan challenge",
  "not configured",
]);
const builtinWorldSlugs = readdirSync(WORLDS_DIR)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => file.replace(/\.ts$/, ""))
  .filter((slug) => !HELPER_MODULES.has(slug))
  .sort();

describe("every builtin world", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let commandNames: string[];

  beforeAll(() => {
    fixture = createTestEngine();
    commandNames = fixture.engine.commands
      .allBuiltins()
      .flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]);
  });
  afterAll(() => fixture.dispose());

  it("finds the shipped worlds", () => {
    expect(builtinWorldSlugs).toContain("default");
    expect(builtinWorldSlugs.length).toBeGreaterThanOrEqual(15);
  });

  it.each(builtinWorldSlugs)(
    "%s starts in a room that exists after its rooms load",
    async (slug) => {
      const world = await loadWorld(slug, process.cwd(), WORLDS_DIR);
      const rooms = await loadWorldRooms(world);
      expect(rooms.has(world.startRoom), `${slug} startRoom ${world.startRoom} is missing`).toBe(
        true,
      );
    },
  );

  it.each(builtinWorldSlugs)(
    "%s guide notes and room descriptions reference only real commands",
    async (slug) => {
      const world = await loadWorld(slug, process.cwd(), WORLDS_DIR);
      const rooms = await loadWorldRooms(world);
      const texts = [
        ...[...PLATFORM_GUIDE_NOTES, ...world.guideNotes].map((note) => note.content),
        ...[...rooms.values()].map((room) => (typeof room.long === "string" ? room.long : "")),
      ];
      // World text quotes commands both as `code` and as 'single quotes'; the auditor reads
      // backticks, so lift single-quoted spans (not apostrophes) into backticks first.
      const notes = texts.map(
        (content, index) =>
          ({
            id: index + 1,
            content: content.replace(
              /(^|[\s(:,])'([a-z][^'\n]{2,80})'(?=[\s.,;:)!?]|$)/g,
              (_m, lead: string, ref: string) =>
                QUOTED_NON_COMMANDS.has(ref) ? `${lead}"${ref}"` : `${lead}\`${ref}\``,
            ),
          }) as NoteRow,
      );
      // A world's own room commands (evolve's `forge`, a market room's `predict`) are real too.
      const roomCommands = [...rooms.values()].flatMap((room) => Object.keys(room.commands ?? {}));
      const report = auditKnowledgeNotes(notes, {
        knownCommands: [...commandNames, ...roomCommands],
      });
      expect(report.staleCommands.map((finding) => finding.detail)).toEqual([]);
    },
  );
});
