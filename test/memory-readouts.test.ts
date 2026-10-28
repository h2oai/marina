// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Human readouts say what they show: `memory query` leads with each record's
 * own id, `memory kv history` includes the first set, and `brief`'s help
 * names the first-login welcome.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatMemoryOperation } from "../src/memory/human-interface";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

describe("memory and brief readouts", () => {
  let f: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    f = createTestEngine();
  });
  afterEach(async () => {
    await f.dispose();
  });

  const run = async (who: ReturnType<typeof f.login>, line: string) => {
    who.connection.clear();
    await f.engine.processCommand(who.entityId as EntityId, line);
    return stripAnsi(who.connection.allTextJoined());
  };

  it("memory query: the first id is the record's, and `memory show` takes it", async () => {
    const alice = f.login("Alice");
    await run(alice, "memory remember Amber deploys on port 7419");
    const text = await run(alice, "memory query {}");
    const first = text.match(/\b(rec_[\w-]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/)?.[1];
    expect(first).toBeDefined();
    expect(text).toContain(`id ${first} · memory show ${first}`);
    expect(text).toContain("Amber deploys on port 7419");
    const shown = await run(alice, `memory show ${first}`);
    expect(shown).not.toContain("memory_not_found");
    expect(shown).toContain("Amber deploys on port 7419");
  });

  it("formatMemoryOperation keeps the lossless dump after the record lines", () => {
    const record = {
      id: "rec_1",
      space_id: "space-1",
      content: "x".repeat(200),
      subject: "deploy",
    };
    const text = formatMemoryOperation({
      ok: true,
      space_id: "space-1",
      result: { results: [record] },
    } as never);
    const lines = text.split("\n");
    expect(lines[0]).toBe("1 record:");
    expect(lines[1]).toStartWith("id rec_1 · memory show rec_1 · subject deploy · ");
    expect(lines[1]!.length).toBeLessThan(160);
    expect(text).toContain("Memory service — space space-1");
    expect(text).toContain(`"content": "${"x".repeat(200)}"`);
  });

  it("memory kv history includes the first set, before and after an edit", async () => {
    const alice = f.login("Alice");
    await run(alice, "memory kv set goal map the grid");
    const once = await run(alice, "memory kv history goal");
    expect(once).not.toContain("No edit history");
    expect(once).toContain('set "map the grid" (first set)');

    await run(alice, "memory kv set goal chart the coast");
    const twice = await run(alice, "memory kv history goal");
    expect(twice).toContain('"map the grid" → "chart the coast"');
    expect(twice).toContain('set "map the grid" (first set)');
    expect(twice.indexOf("chart the coast")).toBeLessThan(twice.indexOf("(first set)"));

    expect(await run(alice, "memory kv history never-set")).toContain(
      'No memory entry for "never-set"',
    );
  });

  it("brief help says the first brief is the welcome, later ones show the world", async () => {
    const bob = f.login("Bob");
    const help = await run(bob, "help brief");
    expect(help).toContain("first brief after you arrive is the welcome");
    expect(help).toContain("every later one shows the current shape of the world");
  });
});
