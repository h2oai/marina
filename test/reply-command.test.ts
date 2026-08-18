// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { replyCommand, type TellDeps, tellCommand } from "../src/engine/commands/tell";
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
  return {
    id: entityId(id),
    name,
    short: name,
    long: name,
    properties: {},
  } as unknown as Entity;
}

interface Delivered {
  target: EntityId;
  message: string;
  senderId: EntityId;
}

describe("re (reply) command", () => {
  const alice = ent("e_alice", "alice");
  const bob = ent("e_bob", "bob");
  const carol = ent("e_carol", "carol");
  const entities: Record<string, Entity> = { alice, bob, carol };

  let delivered: Delivered[];
  let toCaller: string[];

  function makeDeps(): TellDeps {
    return {
      getEntity: (id) => Object.values(entities).find((e) => e.id === id),
      findEntityGlobal: (name) => {
        const e = entities[name.toLowerCase()];
        return e ? { id: e.id, name: e.name } : undefined;
      },
      sendGlobal: (target, message, senderId) => {
        delivered.push({ target, message: stripAnsi(message), senderId });
      },
    };
  }

  function ctx(): RoomContext {
    return {
      send: (_t: EntityId, msg: string) => toCaller.push(stripAnsi(msg)),
    } as unknown as RoomContext;
  }

  function input(caller: Entity, verb: string, args: string): CommandInput {
    return {
      raw: `${verb} ${args}`,
      verb,
      args,
      tokens: args.split(/\s+/).filter(Boolean),
      entity: caller.id,
      room: roomId("test/start"),
    };
  }

  beforeEach(() => {
    delivered = [];
    toCaller = [];
    for (const e of Object.values(entities)) e.properties.last_tell_from = undefined;
  });

  it("records the sender on the recipient when a tell is delivered", () => {
    tellCommand(makeDeps()).handler(ctx(), input(alice, "tell", "bob hello there"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.target).toBe(bob.id);
    expect(delivered[0]!.message).toContain("hello there");
    expect(bob.properties.last_tell_from).toBe("alice");
  });

  it("re replies to the last person who sent a tell", () => {
    const deps = makeDeps();
    tellCommand(deps).handler(ctx(), input(alice, "tell", "bob ping"));
    delivered = [];
    replyCommand(deps).handler(ctx(), input(bob, "re", "pong back"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.target).toBe(alice.id); // routed to alice, no name typed
    expect(delivered[0]!.message).toContain("pong back");
  });

  it("threads: replying makes the replier the other party's last sender", () => {
    const deps = makeDeps();
    tellCommand(deps).handler(ctx(), input(alice, "tell", "bob ping"));
    replyCommand(deps).handler(ctx(), input(bob, "re", "pong"));
    // Now alice can `re` straight back to bob.
    expect(alice.properties.last_tell_from).toBe("bob");
  });

  it("errors when there is nothing to reply to", () => {
    replyCommand(makeDeps()).handler(ctx(), input(carol, "re", "hello?"));
    expect(delivered).toHaveLength(0);
    expect(toCaller.join(" ")).toContain("No one has sent you a tell");
  });

  it("shows usage (naming the recipient) when re has no message", () => {
    const deps = makeDeps();
    tellCommand(deps).handler(ctx(), input(alice, "tell", "bob ping"));
    delivered = [];
    toCaller = [];
    replyCommand(deps).handler(ctx(), input(bob, "re", ""));
    expect(delivered).toHaveLength(0);
    expect(toCaller.join(" ")).toContain("alice");
  });
});
