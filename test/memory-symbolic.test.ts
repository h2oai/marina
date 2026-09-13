// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPlan, executeMemoryPlan } from "../src/memory/planning";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryRule, MemoryVariable } from "../src/sdk/memory-symbolic";

let directory: string,
  db: MarinaDB,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string;
let actor: NonNullable<ReturnType<MarinaDB["verifyMemoryCredential"]>>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-symbolic-"));
  db = new MarinaDB(join(directory, "memory.db"));
  service = new MemoryService(db);
  const credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "owner" }).principal_id,
  );
  actor = db.verifyMemoryCredential(credential.token)!;
  client = new MarinaMemoryClient("http://memory.test", credential.token, 30000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  space = (await client.createSpace("symbolic")).id;
});
afterEach(async () => {
  await service.close();
  db.close();
  rmSync(directory, { recursive: true });
});
const variable = (variable: string, type: MemoryVariable["type"] = "entity"): MemoryVariable => ({
  variable,
  type,
});
const rule: MemoryRule = {
  schema: "marina.memory.rule.v1",
  name: "reviewers for active projects",
  query: {
    patterns: [
      { subject: variable("person"), predicate: "reviews", object: variable("project") },
      {
        subject: variable("project"),
        predicate: "status",
        object: { kind: "literal", value: "active" },
      },
    ],
  },
  conclusion: {
    subject: variable("person"),
    predicate: "activeReviewer",
    object: variable("project"),
  },
};
async function seed() {
  const source = await client.capture(
    space,
    "Ada reviews Marina. Marina is active during [10, 30).",
  );
  const reviewer = await client.remember(space, {
    content: "Ada reviews Marina",
    source_ids: [source.id],
    claim: {
      subject: "person:ada",
      predicate: "reviews",
      object: { kind: "entity", id: "project:marina" },
    },
  });
  const status = await client.remember(space, {
    content: "Marina active",
    source_ids: [source.id],
    valid_time: { from: 10, until: 30 },
    claim: {
      subject: "project:marina",
      predicate: "status",
      object: { kind: "literal", value: "active" },
    },
  });
  return { source, reviewer, status };
}
it("joins typed entities across claims with inspectable witnesses, valid ranges and plan traces", async () => {
  const { reviewer, status } = await seed();
  await client.remember(space, {
    content: "literal lookalike",
    claim: {
      subject: "person:wrong",
      predicate: "reviews",
      object: { kind: "literal", value: "project:marina" },
    },
  });
  const result = await client.join(space, rule.query);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toEqual({
    bindings: {
      person: { kind: "entity", id: "person:ada" },
      project: { kind: "entity", id: "project:marina" },
    },
    witnesses: [
      { id: reviewer.id, version: 1 },
      { id: status.id, version: 1 },
    ],
    valid_time: { from: 10, until: 30 },
  });
  expect(result.trace.map((t) => t.matches)).toEqual([1, 1]);
  expect((await client.join(space, { ...rule.query, valid_at: 30 })).results).toEqual([]);
  expect((await client.join(space, { ...rule.query, valid_at: 10 })).results).toHaveLength(1);
  const plan = await createMemoryPlan(service, actor, space, {
    task: "find reviewers",
    steps: [{ operation: "join", input: rule.query }],
  });
  expect((await executeMemoryPlan(service, actor, space, plan)).trace[0]?.evidence).toEqual(
    result.results,
  );
  await expect(
    client.join(space, {
      patterns: [{ subject: variable("x"), predicate: "reviews", object: variable("x", "string") }],
    }),
  ).rejects.toMatchObject({ code: "invalid_symbolic" });
});
it("versions authored rules, materializes explicitly and invalidates conclusions on premise and rule changes", async () => {
  const { source, status } = await seed();
  const saved = await client.saveRule(space, rule, { source_ids: [source.id] });
  const run = await client.runRule(space, saved.id, 1);
  expect(run.results[0]?.claim).toEqual({
    subject: "person:ada",
    predicate: "activeReviewer",
    object: { kind: "entity", id: "project:marina" },
  });
  expect((await client.query(space, { predicate: "activeReviewer" })).results).toEqual([]);
  const receipt = await client.materializeRule(space, saved.id, 1, undefined, "materialize");
  expect(await client.materializeRule(space, saved.id, 1, undefined, "materialize")).toEqual(
    receipt,
  );
  const derived = await client.get(space, receipt.records[0]!.id);
  expect(derived.type).toBe("inference");
  expect(derived.dependency_versions?.[saved.id]).toBe(1);
  expect(derived.valid_time).toEqual({ from: 10, until: 30 });
  await client.revise(space, status.id, 1, {
    content: "Project paused",
    claim: {
      subject: "project:marina",
      predicate: "status",
      object: { kind: "literal", value: "paused" },
    },
  });
  expect((await client.get(space, derived.id)).freshness).toBe("stale");
  expect((await client.runRule(space, saved.id, 1)).results).toEqual([]);
  await client.saveRule(
    space,
    { ...rule, name: "revised definition" },
    { id: saved.id, expected_version: 1 },
  );
  await expect(client.runRule(space, saved.id, 1)).rejects.toMatchObject({ code: "rule_changed" });
  expect((await client.get(space, saved.id, 1)).content).toContain("reviewers for active projects");
});
it("enforces live grants and rejects unsafe or unbound rule heads", async () => {
  await seed();
  const saved = await client.saveRule(space, rule);
  const principal = db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id;
  const credential = db.issueMemoryCredential(principal);
  const reader = new MarinaMemoryClient("http://memory.test", credential.token, 30000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  await client.grant(space, principal, "reader");
  expect((await reader.runRule(space, saved.id, 1)).results).toHaveLength(1);
  await expect(reader.materializeRule(space, saved.id, 1)).rejects.toMatchObject({ status: 404 });
  await client.grant(space, principal, null);
  await expect(reader.join(space, rule.query)).rejects.toMatchObject({ status: 404 });
  await expect(
    client.saveRule(space, {
      ...rule,
      conclusion: { ...rule.conclusion, subject: variable("unbound") },
    }),
  ).rejects.toMatchObject({ code: "invalid_symbolic" });
  await expect(
    client.request(`/spaces/${space}/join`, "POST", { ...rule.query, code: "host()" }),
  ).rejects.toMatchObject({ code: "invalid_symbolic" });
});
it("refuses overflowing intermediate joins instead of treating partial evidence as complete", async () => {
  const repo = service.repository;
  for (let i = 0; i < 46; i++)
    repo.remember(
      actor,
      space,
      {
        content: `value ${i}`,
        claim: { subject: `item:${i}`, predicate: "value", object: { kind: "literal", value: i } },
      },
      `v${i}`,
    );
  await expect(
    client.join(space, {
      patterns: [
        { subject: variable("a"), predicate: "value", object: variable("av", "number") },
        { subject: variable("b"), predicate: "value", object: variable("bv", "number") },
      ],
    }),
  ).rejects.toMatchObject({ code: "symbolic_budget_exceeded" });
  const narrow = await client.join(space, {
    patterns: [{ subject: variable("a"), predicate: "value", object: variable("av", "number") }],
    limit: 2,
  });
  expect(narrow.results).toHaveLength(2);
  expect(narrow.truncated).toBe(true);
});
