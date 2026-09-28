// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import fc from "fast-check";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { createTestEngine } from "./engine-fixture";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { propertyOptions } from "./property-options";

test("generated authority and memory histories never return withdrawn cached evidence", async () => {
  const action = fc.record({
    kind: fc.constantFrom(
      "forgotten",
      "suspended",
      "revoked",
      "owner",
      "rollback",
      "read",
      "mutate",
    ),
    value: fc.boolean(),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 20 }), async (actions) => {
      const world = createTestEngine();
      try {
        const fixture = await seedUnifiedFixture(world.engine, world.db);
        const raw = world.db.memoryRepository().raw;
        const owner = world.db.getUserByName(fixture.owner)!.id;
        const worker = world.db.getUserByName(fixture.worker)!.id;
        const model = { forgotten: false, suspended: false, revoked: false, owner: true };
        const read = () =>
          buildUnifiedContext(world.db, fixture.owner, FIXTURE_QUERY, {
            scope: "evidence",
            creditReflections: false,
          });
        await read();
        for (const { kind, value } of actions) {
          if (kind === "forgotten") {
            raw.run("UPDATE memory_records SET status=? WHERE id=?", [
              value ? "forgotten" : "active",
              fixture.recordId,
            ]);
            model.forgotten = value;
          } else if (kind === "suspended") {
            raw.run("UPDATE principals SET status=? WHERE principal_id=?", [
              value ? "suspended" : "active",
              owner,
            ]);
            model.suspended = value;
          } else if (kind === "revoked") {
            raw.run("UPDATE principal_credentials SET revoked_at=? WHERE principal_id=?", [
              value ? Date.now() : null,
              owner,
            ]);
            model.revoked = value;
          } else if (kind === "owner") {
            raw.run("UPDATE memory_spaces SET owner_id=? WHERE id=?", [
              value ? owner : worker,
              fixture.spaceId,
            ]);
            model.owner = value;
          } else if (kind === "rollback") {
            raw.exec("BEGIN");
            try {
              raw.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [
                fixture.recordId,
              ]);
              expect((await read()).tiers.flatMap((t) => t.items.map((i) => i.id))).not.toContain(
                fixture.recordId,
              );
            } finally {
              raw.exec("ROLLBACK");
            }
          } else if (kind === "mutate") {
            const result = await read();
            result.tiers.length = 0;
            result.entity = "SomeoneElse";
          }
          const expected = !model.forgotten && !model.suspended && !model.revoked && model.owner;
          // Consecutive reads exercise both invalidation and reuse, against the access model.
          for (let i = 0; i < 2; i++) {
            const result = await read();
            expect(result.entity).toBe(fixture.owner);
            expect(
              result.tiers.some((t) => t.items.some((item) => item.id === fixture.recordId)),
            ).toBe(expected);
          }
        }
      } finally {
        await world.dispose();
      }
    }),
    propertyOptions(20),
  );
});
