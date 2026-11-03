// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * `tell read <id>`: the whole stored direct message, to its sender or its
 * recipient only. A long tell reaches an agent as a prompt line clamped to
 * the perception budget; the clamped line names this command.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TellDeps, tellCommand } from "../src/engine/commands/tell";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  entityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { stripAnsi } from "./helpers";

function ent(id: string, name: string): Entity {
  return { id: entityId(id), name, short: name, long: name, properties: {} } as unknown as Entity;
}

describe("tell read", () => {
  const alice = ent("e_alice", "alice");
  const bob = ent("e_bob", "bob");
  const carol = ent("e_carol", "carol");
  const entities: Record<string, Entity> = { alice, bob, carol };
  let db: MarinaDB;
  let toCaller: Array<{ to: EntityId; text: string }>;
  const long = `Review verdict for #19: ${"evidence ".repeat(300)}END`;

  function deps(): TellDeps {
    return {
      db,
      getEntity: (id) => Object.values(entities).find((e) => e.id === id),
      findEntityGlobal: (name) => {
        const e = entities[name.toLowerCase()];
        return e ? { id: e.id, name: e.name } : undefined;
      },
      sendGlobal: () => {},
    };
  }
  const ctx = (): RoomContext =>
    ({
      send: (to: EntityId, msg: string) => toCaller.push({ to, text: stripAnsi(msg) }),
    }) as unknown as RoomContext;
  const input = (caller: Entity, args: string): CommandInput => ({
    raw: `tell ${args}`,
    verb: "tell",
    args,
    tokens: args.split(/\s+/).filter(Boolean),
    entity: caller.id,
    room: roomId("test/start"),
  });

  beforeEach(() => {
    db = new MarinaDB(":memory:");
    toCaller = [];
  });
  afterEach(() => db.close());

  it("returns the whole message to its recipient and its sender, and refuses anyone else", () => {
    tellCommand(deps()).handler(ctx(), input(alice, `bob ${long}`));
    const id = db.listDirectMessageInbox(bob.id)[0]!.id;
    toCaller = [];
    tellCommand(deps()).handler(ctx(), input(bob, `read ${id}`));
    expect(toCaller[0]!.text).toContain(`#${id} from alice to bob`);
    expect(toCaller[0]!.text).toContain("END");
    expect(toCaller[0]!.text.length).toBeGreaterThan(long.length);
    toCaller = [];
    tellCommand(deps()).handler(ctx(), input(alice, `read ${id}`));
    expect(toCaller[0]!.text).toContain("END");
    toCaller = [];
    tellCommand(deps()).handler(ctx(), input(carol, `read ${id}`));
    expect(toCaller[0]!.text).toContain("is private");
    expect(toCaller[0]!.text).not.toContain("END");
    toCaller = [];
    tellCommand(deps()).handler(ctx(), input(bob, "read 999"));
    expect(toCaller[0]!.text).toContain("not found");
    toCaller = [];
    tellCommand(deps()).handler(ctx(), input(bob, "read x"));
    expect(toCaller[0]!.text).toContain("Usage: tell read <id>");
  });

  it("is a declared read form", () => {
    const def = tellCommand(deps());
    expect(def.usage).toContainEqual({ syntax: "tell read <id>", effect: "read" });
    expect(def.help).toContain("tell read <id>");
  });
});
