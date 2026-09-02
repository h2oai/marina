// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Docs-vs-reality executor for docs/guides/getting-started.md.
 *
 * Extracts every fenced ```text block from the guide and runs each literal
 * command line against a freshly seeded default world. A 2026-09 usability
 * spot-check found ~2 of 11 documented commands rotten; this keeps the
 * remaining surface mechanically honest — a guide edit that documents a
 * command Marina no longer recognizes fails CI here.
 *
 * Skipped lines (with reasons, so skips stay visible and auditable):
 *  - lines containing <placeholders> — they aren't literal commands
 *  - `tell …` — needs live seeded agents (an LLM provider), out of scope
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { seedGuidePool } from "../src/world/seed-guide";
import defaultWorld from "../worlds/default";
import { cleanupDb, MockConnection, stripAnsi } from "./helpers";

const GUIDE_PATH = join(import.meta.dir, "../docs/guides/getting-started.md");

function extractTextBlockCommands(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const commands: string[] = [];
  for (const block of blocks) {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.includes("<") || line.includes(">")) continue; // placeholder, not literal
      if (line.startsWith("tell ")) continue; // needs live seeded agents
      commands.push(line);
    }
  }
  return commands;
}

describe("getting-started.md examples run against the real default world", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let eid: EntityId;
  const dbPath = `/tmp/marina-docs-examples-test-${Date.now()}.db`;

  beforeAll(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: defaultWorld.startRoom,
      tickInterval: 60_000,
      db,
      world: defaultWorld,
    });
    engine.registerWorldRooms(defaultWorld);
    seedGuidePool(db, defaultWorld.guideNotes);
    defaultWorld.seed?.(db);
    conn = new MockConnection("docs_conn");
    engine.addConnection(conn);
    const result = engine.login("docs_conn", "DocsReader");
    if (!("entityId" in result)) throw new Error("login failed");
    eid = result.entityId;
  });

  afterAll(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const commands = extractTextBlockCommands(readFileSync(GUIDE_PATH, "utf8"));

  it("finds a meaningful number of literal example commands", () => {
    expect(commands.length).toBeGreaterThanOrEqual(8);
  });

  for (const cmd of commands) {
    it(`documented command works verbatim: \`${cmd}\``, () => {
      conn.clear();
      engine.processCommand(eid, cmd);
      const out = stripAnsi(conn.allText().join("\n"));
      expect(out, `"${cmd}" should be a recognized command`).not.toContain("Unknown command");
      expect(out, `"${cmd}" should produce output`).not.toBe("");
    });
  }
});
