// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { EVIDENCE_REF_FORMS, resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";

describe("an unavailable evidence reference says why, as far as is safe", () => {
  it("names a malformed reference; never splits missing from not-readable", async () => {
    const world = createTestEngine();
    try {
      const me = world.login("ref-reader");
      const actor = { name: "ref-reader", id: String(me.entityId) };
      expect(resolveEvidenceSource(world.db, actor, "doc:x")).toEqual({
        ref: "doc:x",
        status: "unavailable",
        reason: "malformed",
      });
      expect(resolveEvidenceSource(world.db, actor, "note:60 ")).toMatchObject({
        reason: "malformed",
      });
      // A note that does not exist and a note another entity owns read the same.
      expect(resolveEvidenceSource(world.db, actor, "note:999999")).toEqual({
        ref: "note:999999",
        status: "unavailable",
        reason: "unavailable",
      });
      world.db.createUser({ id: "someone-else", name: "someone-else" });
      const theirs = world.db.createNote("someone-else", "a private receipt", undefined, {
        skipDedup: true,
      });
      expect(resolveEvidenceSource(world.db, actor, `note:${theirs}`)).toMatchObject({
        status: "unavailable",
        reason: "unavailable",
      });
      expect(EVIDENCE_REF_FORMS).toContain("note:N");
    } finally {
      await world.dispose();
    }
  });
});
