// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import fc from "fast-check";
import { createTestEngine } from "./engine-fixture";
import { propertyOptions } from "./property-options";

test("security fuzz: context JSON cannot change identity, write memory or leak another resident", async () => {
  const world = createTestEngine();
  const { connection, entityId } = world.login("Fuzzer");
  world.login("SomeoneElse");
  world.db.createNote("Fuzzer", "quartz OWN");
  world.db.createNote("SomeoneElse", "quartz FOREIGN_SECRET");
  const before = world.db.getNotesByEntity("Fuzzer");
  const payload = fc.oneof(
    fc.jsonValue().map((value) => JSON.stringify(value)),
    fc.string({ maxLength: 500 }),
    fc
      .record({
        query: fc.oneof(fc.constant("quartz"), fc.string({ maxLength: 4010 })),
        budgetBytes: fc.oneof(fc.integer({ min: -100, max: 20000 }), fc.double(), fc.string()),
        scope: fc.oneof(fc.constantFrom("all", "evidence"), fc.jsonValue()),
        request_id: fc.string({ maxLength: 150 }),
        entity: fc.constant("SomeoneElse"),
        principal: fc.constant("SomeoneElse"),
      })
      .map((value) => JSON.stringify({ ...value, ["__proto__"]: { entity: "SomeoneElse" } })),
  );
  try {
    await fc.assert(
      fc.asyncProperty(payload, async (json) => {
        connection.clear();
        await world.engine.processCommand(entityId, `context api ${json}`);
        const result = connection.messages.findLast((message) => message.data.context_preview)?.data
          .context_preview as {
          error?: string;
          request_id?: string;
          context?: { entity: string; usedBytes: number; budgetBytes: number };
        };
        expect(result).toBeDefined();
        expect(JSON.stringify(result)).not.toContain("FOREIGN_SECRET");
        if (result.context) {
          expect(result.context.entity).toBe("Fuzzer");
          expect(result.context.usedBytes).toBeLessThanOrEqual(result.context.budgetBytes);
        } else expect(typeof result.error).toBe("string");
        expect((result.request_id ?? "").length).toBeLessThanOrEqual(100);
        expect(world.engine.getConnectionEntity(connection.id)).toBe(entityId);
        expect(world.db.getNotesByEntity("Fuzzer")).toEqual(before);
        expect(Object.prototype).not.toHaveProperty("entity");
      }),
      propertyOptions(300),
    );
  } finally {
    await world.dispose();
  }
});
