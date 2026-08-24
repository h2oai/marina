// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_principals.db";

afterEach(() => cleanupDb(TEST_DB));

describe("principal identity registry", () => {
  test("uses a human's durable user id as their principal id", () => {
    const db = new MarinaDB(TEST_DB);
    db.createUser({ id: "user-1", name: "Operator" });
    expect(db.getPrincipal("human", "operator")).toMatchObject({
      principal_id: "user-1",
      principal_type: "human",
      display_name: "Operator",
      status: "active",
    });
    db.close();
  });

  test("gives each agent a durable principal and records agent lineage", () => {
    const db = new MarinaDB(TEST_DB);
    db.saveAgentConfig({ name: "Parent", model: "test", spawnedBy: "system" });
    db.saveAgentConfig({ name: "Child", model: "test", spawnedBy: "Parent" });
    const parent = db.getPrincipal("agent", "Parent");
    const child = db.getPrincipal("agent", "Child");
    expect(parent?.principal_id).toBeDefined();
    expect(child).toMatchObject({
      principal_type: "agent",
      owner_principal_id: parent?.principal_id,
      lineage_parent_id: parent?.principal_id,
      status: "active",
    });

    db.saveAgentConfig({ name: "Child", model: "test-2", spawnedBy: "Parent" });
    expect(db.getPrincipal("agent", "Child")?.principal_id).toBe(child?.principal_id);
    db.close();
  });

  test("supports suspension without deleting identity history", () => {
    const db = new MarinaDB(TEST_DB);
    const principal = db.ensurePrincipal({ type: "service", displayName: "Indexer" });
    expect(db.setPrincipalStatus(principal.principal_id, "suspended")).toBe(true);
    expect(db.getPrincipal("service", "Indexer")).toMatchObject({
      principal_id: principal.principal_id,
      status: "suspended",
    });
    db.close();
  });

  test("issues hashed, audience-bound agent credentials and authenticates the matching agent", () => {
    const db = new MarinaDB(TEST_DB);
    const principal = db.ensurePrincipal({ type: "agent", displayName: "Builder" });
    const issued = db.issueWorkloadCredential(principal.principal_id, 60_000);
    const stored = (db as unknown as { db: Database }).db
      .query("SELECT token_hash,audience,scopes FROM principal_credentials WHERE credential_id=?")
      .get(issued.credentialId) as { token_hash: string; audience: string; scopes: string };
    expect(stored.token_hash).not.toContain(issued.token);
    expect(stored.token_hash).toHaveLength(64);
    expect(stored).toMatchObject({ audience: "marina:world", scopes: '["world:connect"]' });

    const engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const connection = new MockConnection("agent-login");
    engine.addConnection(connection);
    expect(engine.login(connection.id, "Other", issued.token)).toHaveProperty("error");
    expect(engine.login(connection.id, "Builder", issued.token)).toHaveProperty("entityId");
    engine.shutdown();
    db.close();
  });

  test("enforces a suspended human principal at the shared login choke point", () => {
    const db = new MarinaDB(TEST_DB);
    db.createUser({ id: "user-1", name: "Operator" });
    db.setPrincipalStatus("user-1", "suspended");
    const engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const connection = new MockConnection("principal-login");
    engine.addConnection(connection);
    expect(engine.login(connection.id, "Operator")).toEqual({
      error: "This identity is suspended. Contact the Marina operator.",
    });
    engine.shutdown();
    db.close();
  });
});
