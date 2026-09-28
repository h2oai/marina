// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { z } from "zod";
import { commandManifest } from "../src/engine/command-manifest";
import { CommandRouter } from "../src/engine/command-router";
import { Engine } from "../src/engine/engine";
import { parseModifiers } from "../src/engine/parse-input";
import { commandFormFingerprint, mcpCommandSchema } from "../src/net/mcp-command-schema";
import { MarinaDB } from "../src/persistence/database";
import { compileCommandForms, composeCommand } from "../src/sdk/command-forms";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

// Reproducible generated cases: failures name the seed/case, never depend on Math.random.
function samples(count: number): string[] {
  let state = 0x4d415249;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return `item-${state.toString(36)}`;
  });
}

test("generated safe inputs preserve verb, arguments and modifier spelling equivalence", () => {
  const router = new CommandRouter();
  const spec = { kind: { type: "string" as const } };
  for (const word of samples(512)) {
    for (const separator of [" ", "\t", "\n", "\r\n", "\u2003"]) {
      const parsed = router.parse(`  LOOK${separator}${word}  `, entityId("a"), roomId("r"));
      expect(parsed.verb, word).toBe("look");
      expect(parsed.tokens, word).toEqual([word]);
    }
    for (const tokens of [[`kind:${word}`], [`kind=${word}`], ["--kind", word], [`--kind=${word}`]])
      expect(parseModifiers(tokens, spec).values, word).toEqual({ kind: word });
    const literal = ["--", `kind:${word}`, "https://example.test/a:b"];
    expect(parseModifiers(literal, spec).rest, word).toEqual(literal.slice(1));
  }
});

test("generated MCP schemas and human composition agree on bounded values and choices", () => {
  const form = compileCommandForms([
    {
      syntax: "sample <count> <higher|lower>",
      fields: { count: { kind: "number", min: 1, max: 10 } },
    },
  ])[0]!;
  const schema = z.object(mcpCommandSchema(form)).strict();
  for (let i = -128; i < 128; i++) {
    const count = i / 8;
    const accepted = count >= 1 && count <= 10;
    const values = { "field-0": count, "field-1": i % 2 ? "higher" : "lower" };
    expect(schema.safeParse({ values }).success, String(i)).toBe(accepted);
    const composed = composeCommand(
      form,
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
      {},
    );
    expect(Object.keys(composed.errors).length === 0, String(i)).toBe(accepted);
  }
  for (const hostile of ["1\nquit", "1\rlook", "Infinity", "NaN", "1 2", "\u0000"]) {
    expect(
      composeCommand(form, { "field-0": hostile, "field-1": "higher" }, {}).errors,
    ).not.toEqual({});
    expect(schema.safeParse({ values: { "field-0": hostile, "field-1": "higher" } }).success).toBe(
      false,
    );
  }
  expect(
    schema.safeParse({ values: { "field-0": 1, "field-1": "higher", extra: "quit" } }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ values: { "field-0": 1, "field-1": "higher" }, enabled: ["unknown"] })
      .success,
  ).toBe(false);
});

test("registered metadata is immutable and revisions invalidate identical replacement forms", () => {
  const router = new CommandRouter();
  router.registerOwned("fixture", {
    name: "inspect",
    help: "Inspect",
    usage: ["inspect <id>"],
    handler() {},
  });
  const def = router.getDef("inspect")!;
  const form = commandManifest(router)[0]!.forms![0]!;
  const fingerprint = commandFormFingerprint(form, router.revision, "fixture");
  expect(() => {
    def.minRank = 0;
  }).toThrow();
  expect(() => {
    def.usage!.push("inspect changed");
  }).toThrow();
  router.registerOwned("fixture", { ...def, handler() {} }, true);
  expect(commandFormFingerprint(form, router.revision, "fixture")).not.toBe(fingerprint);
  expect(new CommandRouter().allBuiltins()).toEqual([]);
});

test("hostile context JSON never changes identity, mutates memory or escapes structured errors", async () => {
  const path = `/tmp/marina-context-fuzz-${process.pid}.db`;
  const db = new MarinaDB(path);
  const engine = new Engine({ db, startRoom: roomId("fuzz/start") });
  engine.registerRoom(roomId("fuzz/start"), makeTestRoom());
  const conn = new MockConnection("fuzzer");
  engine.addConnection(conn);
  engine.login(conn.id, "Fuzzer");
  db.createNote("Fuzzer", "quartz own context", roomId("fuzz/start"));
  db.createNote("SomeoneElse", "quartz PRIVATE FOREIGN", roomId("fuzz/start"));
  const before = db.getNotesByEntity("Fuzzer", 100);
  try {
    const invalid = [
      JSON.stringify({ query: "x".repeat(32769) }),
      "null",
      "[]",
      "true",
      "17",
      "{}",
      "{",
      '"query"',
      '{"query":null}',
      '{"query":[]}',
      '{"query":"quartz","budgetBytes":1e400}',
      '{"query":"quartz","scope":"all; quit"}',
      ...samples(100).map((word) => `{"query":${word}}`),
    ];
    for (const json of invalid) {
      conn.clear();
      await engine.processCommand(conn.entity!, `context api ${json}`);
      expect(
        conn.messages.findLast((p) => p.data.context_preview)?.data.context_preview,
        json,
      ).toHaveProperty("error");
    }
    for (const budgetBytes of [256, 4096, 16384]) {
      conn.clear();
      await engine.processCommand(
        conn.entity!,
        `context api ${JSON.stringify({ query: "quartz", budgetBytes, entity: "SomeoneElse", request_id: "x".repeat(300), ["__proto__"]: { entity: "SomeoneElse" } })}`,
      );
      const result = conn.messages.findLast((p) => p.data.context_preview)?.data
        .context_preview as { request_id: string; context: { entity: string; usedBytes: number } };
      expect(result.request_id.length).toBe(100);
      expect(result.context.entity).toBe("Fuzzer");
      expect(result.context.usedBytes).toBeLessThanOrEqual(budgetBytes);
      expect(JSON.stringify(result)).not.toContain("PRIVATE FOREIGN");
    }
    expect(db.getNotesByEntity("Fuzzer", 100)).toEqual(before);
  } finally {
    await engine.shutdown();
    db.close();
    cleanupDb(path);
  }
});
