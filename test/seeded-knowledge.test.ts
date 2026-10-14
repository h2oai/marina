// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What agents are told and read is product surface. Every world's seeded
 * knowledge — guide notes, every note a seed writes, seeded tasks, agent
 * goals, role/trait prompts — and every template and use-case recipe must
 * reference only commands and subcommands the live command set declares.
 * The vocabulary comes from the registered builtins' usage forms (plus each
 * world's own room commands), never from a hand-kept list.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  auditKnowledgeNotes,
  type CommandVocabularyEntry,
} from "../src/engine/commands/knowledge-hygiene";
import { allRecipeNames, getRecipe } from "../src/engine/commands/usecase";
import { MarinaDB, type NoteRow } from "../src/persistence/database";
import { BUILTIN_WORLDS, loadBuiltinWorld } from "../src/world/builtin-worlds";
import { seedGuidePool } from "../src/world/seed-guide";
import * as decomposition from "../src/world/templates/decomposition";
import * as memoryTemplates from "../src/world/templates/memory";
import * as orchestration from "../src/world/templates/orchestration";
import { createTestEngine } from "./engine-fixture";

const WORLDS_DIR = join(import.meta.dir, "..", "worlds");
const HELPER_MODULES = new Set(["seed", "focused-example", "index"]);
const worldSlugs = readdirSync(WORLDS_DIR)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => file.replace(/\.ts$/, ""))
  .filter((slug) => !HELPER_MODULES.has(slug))
  .sort();

/** Single-quoted phrases in seeded text that are names or values, not commands. */
const QUOTED_NON_COMMANDS = new Set([
  "anomaly investigation",
  "example company diligence",
  "launch plan challenge",
  "not configured",
]);

/**
 * Findings that are unavoidable, each with its reason. Keep this empty unless
 * the reference is right and the auditor cannot know it.
 */
const ALLOWED_FINDINGS: Record<string, string> = {};

/** World text quotes commands as `code` and as 'single quotes'; lift the latter into backticks. */
function asNotes(texts: string[]): NoteRow[] {
  return texts.map(
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
}

function rows(db: MarinaDB, sql: string): Record<string, unknown>[] {
  const raw = (db as unknown as { db: Database }).db;
  return raw.query(sql).all() as Record<string, unknown>[];
}

function textColumns(db: MarinaDB, sql: string): string[] {
  return rows(db, sql).flatMap((row) =>
    Object.values(row).filter((v): v is string => typeof v === "string" && v.length > 0),
  );
}

describe("seeded knowledge references only real commands", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let commands: CommandVocabularyEntry[];
  /** Every shipped world's room commands: recipes and templates may name a room's verbs. */
  let anyRoomCommands: string[];

  beforeAll(async () => {
    fixture = createTestEngine();
    commands = fixture.engine.commands.allBuiltins();
    const worlds = await Promise.all(worldSlugs.map((slug) => loadBuiltinWorld(slug)));
    anyRoomCommands = worlds.flatMap((world) =>
      Object.values(world.rooms).flatMap((room) => Object.keys(room.commands ?? {})),
    );
  });
  afterAll(() => fixture.dispose());

  function staleFindings(texts: string[], roomCommands: string[] = []): string[] {
    const report = auditKnowledgeNotes(asNotes(texts), { commands, knownCommands: roomCommands });
    return report.staleCommands
      .map((finding) => finding.detail)
      .filter((detail) => !ALLOWED_FINDINGS[detail]);
  }

  it("covers every shipped world", () => {
    expect(worldSlugs.length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(BUILTIN_WORLDS).sort()).toEqual(worldSlugs);
  });

  it.each(worldSlugs)("%s: seeded notes, tasks, goals, roles and rooms", async (slug) => {
    const world = await loadBuiltinWorld(slug);
    const db = new MarinaDB(":memory:");
    try {
      seedGuidePool(db, world.guideNotes, { commands });
      world.seed?.(db);
      const texts = [
        ...textColumns(db, "SELECT content FROM numeric_notes"),
        ...textColumns(db, "SELECT title, description FROM tasks"),
        ...textColumns(db, "SELECT goal FROM agent_configs"),
        ...textColumns(db, "SELECT description, guidelines FROM roles"),
        ...textColumns(db, "SELECT prompt FROM traits"),
        ...textColumns(db, "SELECT title, body FROM board_posts"),
        ...Object.values(world.rooms).map((room) =>
          typeof room.long === "string" ? room.long : "",
        ),
        ...world.quests.flatMap((quest) => [
          quest.description,
          ...quest.steps.flatMap((step) => [step.description, step.hint]),
        ]),
      ];
      const roomCommands = Object.values(world.rooms).flatMap((room) =>
        Object.keys(room.commands ?? {}),
      );
      expect(staleFindings(texts, roomCommands)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("orchestration, decomposition and memory templates", () => {
    const templates = [orchestration, decomposition, memoryTemplates].flatMap((module) =>
      Object.entries(module)
        .filter(([name, value]) => name.endsWith("_TEMPLATE") && Array.isArray(value))
        .flatMap(([, value]) => (value as { content: string }[]).map((note) => note.content)),
    );
    expect(templates.length).toBeGreaterThan(80);
    expect(staleFindings(templates, anyRoomCommands)).toEqual([]);
  });

  it.each(allRecipeNames())("use-case recipe %s", (name) => {
    const recipe = getRecipe(name)?.("example topic");
    expect(recipe).toBeDefined();
    if (!recipe) return;
    const texts = [
      recipe.description,
      ...recipe.tasks.flatMap((task) => [task.title, task.description]),
      ...recipe.poolNotes.map((note) => note.content),
      ...(recipe.team ?? []).map((member) => member.goal),
    ];
    expect(staleFindings(texts, anyRoomCommands)).toEqual([]);
  });
});
