// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { MEMORY_TOOL_INPUTS } from "../src/memory/tool-contracts";
import { mcpJsonSchema } from "../src/net/mcp-json-schema";
import { createMemoryMcpServer } from "../src/net/mcp-memory-tools";
import type { MarinaMemoryClient } from "../src/sdk/memory-client";
import previous from "./fixtures/memory-mcp-contracts.json";

test("all native and graph memory tool wire schemas retain their previous contracts", async () => {
  const actual: Record<string, unknown> = {};
  for (const profile of ["native", "knowledge-graph"] as const) {
    const server = createMemoryMcpServer({} as MarinaMemoryClient, "fixture", profile);
    const client = new Client({ name: "contracts", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      for (const tool of (await client.listTools()).tools) actual[tool.name] = tool.inputSchema;
    } finally {
      await client.close();
      await server.close();
    }
  }
  expect(actual).toEqual(previous);
});

test("nested claims keep stripping unknown object keys while preserving metadata", () => {
  const schema = z.object(mcpJsonSchema(MEMORY_TOOL_INPUTS.memory_remember));
  const result = schema.parse({
    content: "a claim",
    claim: {
      subject: "a",
      predicate: "p",
      object: { kind: "literal", value: 0, extra: "strip" },
      extra: "strip",
    },
    metadata: { arbitrary: { nested: [true, null, 3] } },
  });
  expect(result.claim).toEqual({
    subject: "a",
    predicate: "p",
    object: { kind: "literal", value: 0 },
  });
  expect(result.metadata).toEqual({ arbitrary: { nested: [true, null, 3] } });
  expect(schema.safeParse({ content: "x", dependency_versions: { a: 0 } }).success).toBe(false);
  expect(
    schema.safeParse({
      content: "x",
      claim: { subject: "a", predicate: "p", object: { kind: "literal", value: [] } },
    }).success,
  ).toBe(false);
  const retrieve = z.object(mcpJsonSchema(MEMORY_TOOL_INPUTS.memory_retrieve));
  expect(retrieve.safeParse({ task: "x", requirements: Array(9).fill({}) }).success).toBe(false);
});

test("unsupported contract constraints fail instead of being silently ignored", () => {
  expect(() => mcpJsonSchema(Type.Object({ name: Type.String({ minLength: 1 }) }))).toThrow(
    /minLength/,
  );
  expect(() => mcpJsonSchema(Type.Object({}, { minProperties: 1 }))).toThrow(/minProperties/);
});
