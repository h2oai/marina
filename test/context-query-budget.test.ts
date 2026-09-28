// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, spyOn, test } from "bun:test";
import { distinctiveTerms } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

test("context term statistics share bounded scans, escape LIKE patterns and reflect edits immediately", () => {
  const path = `/tmp/marina-term-budget-${process.pid}.db`;
  const db = new MarinaDB(path);
  try {
    const ids: number[] = [];
    db.transaction(() => {
      for (let i = 0; i < 20; i++)
        ids.push(
          db.createNote(
            "Owner",
            `common ${i < 4 ? "scarce" : "ordinary"} item ${i}`,
            roomId("test/stats"),
          ),
        );
      db.createNote("Other", "common scarce FOREIGN", roomId("test/stats"));
    });
    const terms = ["common", "scarce", "ordinary", "%", "_", "\\", "absent"];
    const query = spyOn(db.memoryRepository().raw, "query");
    try {
      expect([...distinctiveTerms(db, "Owner", terms)]).toEqual([
        "scarce",
        "%",
        "_",
        "\\",
        "absent",
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      query.mockClear();
      expect(
        distinctiveTerms(
          db,
          "Owner",
          Array.from({ length: 80 }, (_, i) => `absent-${i}`),
        ).size,
      ).toBe(80);
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
    db.createNote("Owner", "scarce fifth observation", roomId("test/stats"));
    expect(distinctiveTerms(db, "Owner", ["scarce"]).has("scarce")).toBe(false);
    db.deleteNote(ids[0]!, "Owner");
    expect(distinctiveTerms(db, "Owner", ["scarce"]).has("scarce")).toBe(true);
  } finally {
    db.close();
    cleanupDb(path);
  }
});
