// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { EntityKind, RoomId } from "../src/types";
import { EntityManager } from "../src/world/entity-manager";

const A = "zone/a" as RoomId;
const B = "zone/b" as RoomId;

function make(em: EntityManager, kind: EntityKind, name: string, room: RoomId) {
  return em.create({ kind, name, short: name, long: name, room });
}

describe("EntityManager lookup indexes", () => {
  it("move() keeps inRoom and findByName in sync", () => {
    const em = new EntityManager();
    const rock = make(em, "object", "rock", A);
    em.move(rock.id, B);
    expect(em.inRoom(A)).toHaveLength(0);
    expect(em.findByName("rock", A)).toBeUndefined();
    expect(em.inRoom(B).map((e) => e.id)).toEqual([rock.id]);
    expect(em.findByName("ro", B)?.id).toBe(rock.id);
  });

  it("removing one of two same-named agents keeps the other findable", () => {
    const em = new EntityManager();
    const first = make(em, "agent", "creator", A);
    const second = make(em, "agent", "creator", A);
    // First-wins, like the linear scan it replaced.
    expect(em.findAgentByName("CREATOR")?.id).toBe(first.id);
    em.remove(first.id);
    expect(em.findAgentByName("creator")?.id).toBe(second.id);
    expect(em.findByName("creator", A)?.id).toBe(second.id);
    // Removing a non-indexed duplicate leaves the indexed one alone.
    const third = make(em, "agent", "creator", A);
    em.remove(third.id);
    expect(em.findAgentByName("creator")?.id).toBe(second.id);
  });
});
