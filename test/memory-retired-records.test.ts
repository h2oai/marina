// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retired (validity-closed) records at the search layer: the durable `search`
 * excludes them before ranking so they never take a result slot; `valid_at`
 * serves a past instant; `include_ended` is the explicit history read; exact
 * `get` reads (with `version`) keep every version readable.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rec {
  id: string;
  version: number;
  content: string;
  metadata: Record<string, unknown>;
  valid_time: { from: number | null; until: number | null } | null;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "marina-retired-"));
  dirs.push(dir);
  const db = new MarinaDB(join(dir, "m.db"));
  db.createUser({ id: crypto.randomUUID(), name: "Keeper" });
  const run = (r: MemoryOperationRequest) =>
    residentMemoryOperation(db, "Keeper", r) as Promise<{ ok: true; result: unknown }>;
  const remember = async (content: string) =>
    ((await run({ operation: "remember", input: { content, subject: "lesson" } })).result as Rec)
      .id;
  const get = async (id: string, version?: number) =>
    (
      await run({
        operation: "get",
        id,
        ...(version === undefined ? {} : { input: { version } }),
      })
    ).result as Rec;
  /** The tombstone shape `note delete` and lesson retirement use: same content, validity closed. */
  const retire = async (id: string, until = Date.now() - 1) => {
    const cur = await get(id);
    await run({
      operation: "revise",
      id,
      input: {
        expected_version: cur.version,
        content: cur.content,
        metadata: { ...cur.metadata, retired_reason: "test" },
        valid_time: { from: cur.valid_time?.from ?? null, until },
      },
    });
  };
  const search = async (query: string, extra: Record<string, unknown> = {}) =>
    (
      (await run({ operation: "search", input: { query, mode: "lexical", ...extra } })).result as {
        results: Rec[];
      }
    ).results;
  return { db, run, remember, get, retire, search };
}

describe("durable search excludes ended records before ranking", () => {
  it("never returns a retired record and retired records never consume slots", async () => {
    const fx = fixture();
    try {
      // Retired records repeat the query terms, so they would outrank the live one.
      const retired: string[] = [];
      for (let i = 0; i < 12; i++)
        retired.push(
          await fx.remember(`glacier relay glacier relay glacier relay variant ${i} superseded`),
        );
      const live = await fx.remember(
        "the glacier relay runs on the north ridge, with a long and wordy description",
      );
      for (const id of retired) await fx.retire(id);

      const hits = await fx.search("glacier relay", { limit: 5 });
      expect(hits.map((r) => r.id)).toEqual([live]);

      // The explicit history read still finds them — and shows they would have crowded it out.
      const all = await fx.search("glacier relay", { limit: 5, include_ended: true });
      expect(all).toHaveLength(5);
      expect(all.map((r) => r.id)).not.toContain(live);
      expect(all.every((r) => retired.includes(r.id))).toBe(true);
    } finally {
      fx.db.close();
    }
  });

  it("valid_at serves the records valid at that instant; history stays readable", async () => {
    const fx = fixture();
    try {
      const id = await fx.remember("quartz beacon is lit at dusk");
      const before = Date.now() - 10;
      const created = await fx.get(id);
      await fx.retire(id);
      expect(await fx.search("quartz beacon")).toEqual([]);
      // A past instant at which the record was still valid serves it.
      const past = await fx.search("quartz beacon", { valid_at: before });
      // valid_from is null for this record, so the interval [-∞, until) holds `before`.
      expect(past.map((r) => r.id)).toEqual([id]);
      // Exact reads are never filtered: the current (retired) version and the original.
      const current = await fx.get(id);
      expect(current.version).toBe(created.version + 1);
      expect(current.metadata.retired_reason).toBe("test");
      expect(current.valid_time?.until).not.toBeNull();
      const original = await fx.get(id, created.version);
      expect(original.content).toBe("quartz beacon is lit at dusk");
      expect(original.metadata.retired_reason).toBeUndefined();
    } finally {
      fx.db.close();
    }
  });

  it("a record whose validity ends in the future is still served", async () => {
    const fx = fixture();
    try {
      const id = await fx.remember("amber lantern schedule");
      await fx.retire(id, Date.now() + 60 * 60_000);
      expect((await fx.search("amber lantern")).map((r) => r.id)).toEqual([id]);
    } finally {
      fx.db.close();
    }
  });

  it("rejects malformed or conflicting validity options", async () => {
    const fx = fixture();
    try {
      await fx.remember("cobalt anchor");
      await expect(fx.search("cobalt", { include_ended: "yes" })).rejects.toMatchObject({
        status: 400,
      });
      await expect(fx.search("cobalt", { valid_at: -1 })).rejects.toMatchObject({ status: 400 });
      await expect(
        fx.search("cobalt", { valid_at: Date.now(), include_ended: true }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      fx.db.close();
    }
  });
});
