// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roomEntryRefusal } from "../src/engine/room-access";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

type Fixture = ReturnType<typeof createTestEngine>;

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

/** Log in at a given rank (rank lives on the entity; 9 = operator). */
function at(f: Fixture, name: string, rank: number) {
  const who = f.login(name);
  f.engine.entities.get(who.entityId)!.properties.rank = rank;
  return who;
}

async function run(f: Fixture, who: { entityId: EntityId }, input: string): Promise<void> {
  f.engine.processCommand(who.entityId, input);
  await f.engine.drainCommands();
}

function last(who: { connection: { lastText(): string } }): string {
  return stripAnsi(who.connection.lastText());
}

function roomOf(f: Fixture, who: { entityId: EntityId }): string {
  return f.engine.entities.get(who.entityId)!.room as string;
}

/** Ash builds `ash/den` north of the start room. */
async function den(f: Fixture) {
  const ash = at(f, "Ash", 4);
  await run(f, ash, "build room ash/den A quiet den");
  await run(f, ash, "build link test/start north ash/den");
  return ash;
}

describe("private rooms", () => {
  it("every room is public until its owner says otherwise", async () => {
    fixture = createTestEngine();
    const ash = await den(fixture);
    await run(fixture, ash, "build access ash/den");
    expect(last(ash)).toContain("ash/den: public");
    expect(fixture.db.getRoomAccess("ash/den")).toBeUndefined();
    expect(fixture.db.getRoomAccess("test/start")).toBeUndefined();
    const bea = at(fixture, "Bea", 0);
    await run(fixture, bea, "north");
    expect(roomOf(fixture, bea)).toBe("ash/den");
  });

  it("only `build access` writes room access: no seed, template or launch path does", () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && readFileSync(path, "utf8").includes("setRoomAccess("))
          writers.push(path);
      }
    };
    for (const dir of ["src", "worlds", "scripts"]) walk(join(import.meta.dir, "..", dir));
    expect(writers.sort()).toEqual(
      [
        "src/engine/commands/build.ts",
        "src/persistence/database.ts",
        "src/persistence/db-rooms.ts",
        "src/persistence/interfaces/rooms-store.ts",
      ]
        .map((p) => join(import.meta.dir, "..", p))
        .sort(),
    );
  });

  it("refuses uninvited entry on every path, and an invite opens it", async () => {
    fixture = createTestEngine();
    const ash = await den(fixture);
    const events: EngineEvent[] = [];
    fixture.engine.addEventListener((e) => events.push(e));
    await run(fixture, ash, "build access ash/den private");
    expect(last(ash)).toContain("ash/den is private (owner Ash)");
    const change = events.find((e) => e.type === "coordination_change");
    expect(change).toMatchObject({ resource: "room", name: "ash/den" });

    await run(fixture, ash, "goto ash/den");
    const bea = at(fixture, "Bea", 0);
    for (const input of ["north", "go north", "goto ash/den", "teleport ash/den", "goto Ash"]) {
      await run(fixture, bea, input);
      expect(roomOf(fixture, bea)).toBe("test/start");
      expect(last(bea)).toContain("ash/den is private");
    }

    await run(fixture, ash, "build invite ash/den Bea");
    expect(fixture.db.getRoomAccess("ash/den")?.invites).toEqual(["Bea"]);
    await run(fixture, bea, "north");
    expect(roomOf(fixture, bea)).toBe("ash/den");
    await run(fixture, bea, "look");
    expect(last(bea)).toContain("Private room (owner Ash)");

    await run(fixture, ash, "build uninvite ash/den Bea");
    expect(fixture.db.getRoomAccess("ash/den")?.invites).toEqual([]);
    // Already inside: stays, and is listed.
    expect(roomOf(fixture, bea)).toBe("ash/den");
    await run(fixture, ash, "build access ash/den");
    expect(last(ash)).toContain("inside, not invited: Bea");

    await run(fixture, ash, "build access ash/den public");
    await run(fixture, bea, "goto test/start");
    await run(fixture, bea, "north");
    expect(roomOf(fixture, bea)).toBe("ash/den");
  });

  it("a person's agents share its invite; others' agents do not", async () => {
    fixture = createTestEngine();
    const ash = await den(fixture);
    await run(fixture, ash, "build access ash/den private");
    await run(fixture, ash, "build invite ash/den Bea");
    fixture.db.saveAgentConfig({ name: "Beabot", model: "m", spawnedBy: "Bea" });
    fixture.db.saveAgentConfig({ name: "Otherbot", model: "m", spawnedBy: "Cy" });
    const beabot = at(fixture, "Beabot", 0);
    const otherbot = at(fixture, "Otherbot", 0);
    await run(fixture, beabot, "goto ash/den");
    expect(roomOf(fixture, beabot)).toBe("ash/den");
    await run(fixture, otherbot, "goto ash/den");
    expect(roomOf(fixture, otherbot)).toBe("test/start");
    // The owner's own agents enter too.
    fixture.db.saveAgentConfig({ name: "Ashbot", model: "m", spawnedBy: "Ash" });
    const ashbot = fixture.engine.entities.get(at(fixture, "Ashbot", 0).entityId)!;
    expect(roomEntryRefusal(fixture.db, ashbot, "ash/den")).toBeNull();
  });

  it("only the owner or an operator changes access; operators may enter", async () => {
    fixture = createTestEngine();
    const ash = await den(fixture);
    const cy = at(fixture, "Cy", 4);
    await run(fixture, cy, "build access ash/den private");
    expect(last(cy)).toContain("Only ash/den's owner or an operator");
    await run(fixture, cy, "build invite ash/den Cy");
    expect(last(cy)).toContain("Only ash/den's owner or an operator");
    expect(fixture.db.getRoomAccess("ash/den")).toBeUndefined();

    await run(fixture, ash, "build access ash/den private");
    const op = at(fixture, "Op", 9);
    await run(fixture, op, "north");
    expect(roomOf(fixture, op)).toBe("ash/den");
    await run(fixture, op, "build access ash/den public");
    expect(fixture.db.getRoomAccess("ash/den")).toMatchObject({ mode: "public", owner: "Ash" });
  });

  it("the start room stays public", async () => {
    fixture = createTestEngine();
    const op = at(fixture, "Op", 9);
    await run(fixture, op, "build access test/start private");
    expect(last(op)).toContain("stays public");
    expect(fixture.db.getRoomAccess("test/start")).toBeUndefined();
  });

  it("changing access needs build's rank like every other build form", async () => {
    fixture = createTestEngine();
    await den(fixture);
    const bea = at(fixture, "Bea", 0);
    await run(fixture, bea, "build access ash/den private");
    expect(fixture.db.getRoomAccess("ash/den")).toBeUndefined();
  });
});

describe("room access storage", () => {
  it("reads a malformed invite list as no invites", () => {
    fixture = createTestEngine();
    fixture.db.setRoomAccess({ room: "r", owner: "Ash", mode: "private" });
    (fixture.db as unknown as { db: { run(sql: string): void } }).db.run(
      "UPDATE room_access SET invites = 'not json' WHERE room = 'r'",
    );
    expect(fixture.db.getRoomAccess("r")?.invites).toEqual([]);
  });
});
