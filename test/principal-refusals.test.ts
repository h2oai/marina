// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Refusals say why. A refusal that hinges on principal kind names the signal
 * that made the caller an agent and how a person acts instead; a second login
 * to a connected account names where the first connection is (and never
 * replaces it); `standing <name>` shows that name, never the caller's own.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentPrincipalReason, resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { checkUnattendedGate } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = `test_principal_refusals_${process.pid}.db`;

describe("refusals say why", () => {
  let db: MarinaDB;
  let engine: Engine;

  const run = (conn: MockConnection, text: string) => {
    conn.clear();
    engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const join = (name: string, opts: { agent?: boolean } = {}) => {
    const conn = new MockConnection(`c-${name}`);
    if (opts.agent) (conn as unknown as { agent: boolean }).agent = true;
    db.createUser({ id: `u_${name.toLowerCase()}`, name });
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    conn.clear();
    return conn;
  };
  const entity = (conn: MockConnection): Entity => engine.entities.get(conn.entity as EntityId)!;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("principal kind", () => {
    it("a person has no agent reason", () => {
      const alice = join("Alice");
      expect(agentPrincipalReason(entity(alice))).toBe("");
    });

    it("a declared agent client is told why and how a person acts", () => {
      const piped = join("Alice", { agent: true });
      const reason = agentPrincipalReason(entity(piped));
      expect(reason).toContain("declared itself an agent");
      expect(reason).toContain("interactive `marina connect`");
    });

    it("an agent account is told its owner or an operator decides", () => {
      db.saveAgentConfig({ name: "Kid", model: "m", spawnedBy: "Alice" });
      const kid = join("Kid");
      const reason = agentPrincipalReason(entity(kid));
      expect(reason).toContain("agent's");
      expect(reason).toContain("owner or an operator decides");
    });

    it("gate grant from a piped person says why it was refused", () => {
      const piped = join("Alice", { agent: true });
      const bob = join("Bob");
      entity(piped).properties.rank = 9;
      const text = run(piped, "gate grant Bob code.exec");
      expect(text).toContain("Agents don't grant gates");
      expect(text).toContain("declared itself an agent");
      expect(checkUnattendedGate(db, String(bob.entity), "code.exec").ok).toBe(false);
    });
  });

  describe("second login", () => {
    it("is refused, names the first connection and never replaces it", () => {
      const first = new MockConnection("c-1");
      engine.addConnection(first);
      const one = engine.login("c-1", "Alice");
      expect("entityId" in one).toBe(true);
      const second = new MockConnection("c-2");
      engine.addConnection(second);
      const two = engine.login("c-2", "Alice");
      expect("error" in two).toBe(true);
      if ("error" in two) {
        expect(two.error).toContain("already in use");
        expect(two.error).toContain("websocket connection");
        expect(two.error).toContain("never replaces the first");
      }
      if ("entityId" in one) expect(engine.connections.get("c-1")?.entity).toBe(one.entityId);
    });
  });

  describe("standing <name>", () => {
    it("shows the named account, not the caller's own", () => {
      const alice = join("Alice");
      join("Bob");
      expect(run(alice, "standing Bob")).toContain("Standing: Bob");
      expect(run(alice, "standing show Bob")).toContain("Standing: Bob");
      expect(run(alice, "standing")).toContain("Standing: Alice");
      expect(run(alice, "standing Nobody")).toContain("No one named Nobody");
    });
  });
});
