// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { WorldCollectiveManager } from "../src/world/world-collective-manager";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_world_variants.db";

afterEach(() => cleanupDb(TEST_DB));

function createVariant(db: MarinaDB, name: string, port: number, parentVariantId?: string) {
  return db.createWorldVariant({
    name,
    worldTemplate: "default",
    hypothesis: `Test ${name}`,
    parentVariantId,
    sourceRoot: "/source",
    dbPath: `/data/${name}.db`,
    wsPort: port,
    createdBy: "Operator",
  });
}

describe("World Collective variants", () => {
  test("preserves explicit ancestry and isolated runtime coordinates", () => {
    const db = new MarinaDB(TEST_DB);
    const baseline = createVariant(db, "baseline", 34_000);
    const candidate = createVariant(db, "candidate", 34_010, baseline.id);
    expect(candidate).toMatchObject({
      parent_variant_id: baseline.id,
      source_root: "/source",
      db_path: "/data/candidate.db",
      ws_port: 34_010,
      status: "draft",
    });
    db.close();
  });

  test("promotion is explicit and leaves one promoted default", () => {
    const db = new MarinaDB(TEST_DB);
    const first = createVariant(db, "first", 34_000);
    const second = createVariant(db, "second", 34_010);
    db.updateWorldVariant(first.id, { status: "stopped" });
    db.updateWorldVariant(second.id, { status: "running", pid: 123 });
    const decision = {
      rationale: "The candidate passed the repeated release scenario.",
      evidenceRefs: ["trace:release-1"],
      promotedBy: "Operator",
    };
    expect(db.promoteWorldVariant(first.id, decision)?.promoted_at).toBeNumber();
    expect(db.promoteWorldVariant(second.id, decision)?.promoted_at).toBeNumber();
    expect(db.getWorldVariant(first.id)?.status).toBe("stopped");
    expect(db.listWorldVariants().filter((variant) => variant.promoted_at !== null)).toHaveLength(
      1,
    );
    expect(db.getWorldVariant(second.id)?.status).toBe("running");
    expect(db.getWorldVariant(second.id)).toMatchObject({
      promotion_rationale: decision.rationale,
      promotion_evidence: JSON.stringify(decision.evidenceRefs),
      promoted_by: "Operator",
    });
    db.close();
  });

  test("manager promotion adds a tamper-evident decision receipt", () => {
    const db = new MarinaDB(TEST_DB);
    const variant = createVariant(db, "candidate", 34_000);
    db.updateWorldVariant(variant.id, { status: "stopped" });
    const manager = new WorldCollectiveManager(db);
    manager.promote(variant.id, {
      rationale: "Repeated trace evidence shows a better successful outcome.",
      evidenceRefs: ["trace:a", "checkpoint:b"],
      promotedBy: "Operator",
    });
    expect(db.listEvidenceReceipts()).toEqual([
      expect.objectContaining({
        event_type: "world_variant_promoted",
        ref: `world-variant:${variant.id}`,
      }),
    ]);
    db.close();
  });
});
