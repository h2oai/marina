// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { arenaWorldDbPath, missingWorldDbRefusal } from "../src/arena/world-db";

describe("arena CLI world database", () => {
  test("DB_PATH wins, else marina.db in the working directory", () => {
    expect(arenaWorldDbPath({ DB_PATH: "/w/marina.db" })).toBe("/w/marina.db");
    expect(arenaWorldDbPath({ DB_PATH: "  " })).toBe("marina.db");
    expect(arenaWorldDbPath({})).toBe("marina.db");
  });

  test("a database that does not exist is refused, naming the fix", () => {
    const refusal = missingWorldDbRefusal("/nowhere/marina.db", { exists: () => false });
    expect(refusal).toContain("/nowhere/marina.db");
    expect(refusal).toContain("DB_PATH");
    expect(refusal).toContain("--new-db");
  });

  test("an existing database, --new-db and :memory: are opened", () => {
    expect(missingWorldDbRefusal("/w/marina.db", { exists: () => true })).toBeUndefined();
    expect(
      missingWorldDbRefusal("/nowhere/marina.db", { exists: () => false, allowNew: true }),
    ).toBeUndefined();
    expect(missingWorldDbRefusal(":memory:", { exists: () => false })).toBeUndefined();
  });
});
