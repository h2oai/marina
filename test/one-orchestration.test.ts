// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The formation catalogue is the ONE orchestration surface: crews, projects,
 * `pattern run` and room formations take every name and description from it,
 * legacy names parse as aliases, help lists catalogue names only, and the
 * generated project templates carry each entry's protocol. No model provider
 * is needed for any of it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CREW_BRIEFS,
  CREW_FORMATION_HELP,
  resolveCrewFormation,
} from "../src/coordination/crew-formations";
import { ROOM_FORMATIONS, roomFormationName } from "../src/coordination/room-formations";
import { resolveTextPattern } from "../src/engine/commands/pattern";
import { Engine } from "../src/engine/engine";
import { listOrchestrationPatterns } from "../src/net/api/orchestration-api";
import {
  CREW_FORMATION_NAMES,
  canonicalFormationName,
  FORMATION_ALIASES,
  FORMATION_NAMES,
  FORMATIONS,
  ROOM_FORMATION_NAMES,
  TEXT_TEMPLATES,
} from "../src/orchestration/formations/catalogue";
import { protocolText, scoreStepsLine } from "../src/orchestration/formations/describe";
import { CREW_ONLY_PATTERNS, TEXT_PATTERNS } from "../src/orchestration/text-patterns";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import {
  normalizePatternName,
  ORCHESTRATION_HELP,
  ORCHESTRATION_PATTERNS,
  ORCHESTRATION_TEMPLATES,
  PATTERN_FIT,
} from "../src/world/templates/orchestration";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const ALIASES = Object.keys(FORMATION_ALIASES);
const catalogue = new Set<string>(FORMATION_NAMES);
const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];

describe("every surface's names resolve through the catalogue", () => {
  it("crews, projects, pattern run and rooms name catalogue entries only", () => {
    for (const name of [
      ...Object.keys(CREW_BRIEFS),
      ...ORCHESTRATION_PATTERNS,
      ...TEXT_PATTERNS,
      ...ROOM_FORMATIONS,
      ...Object.keys(CREW_ONLY_PATTERNS),
      ...Object.keys(PATTERN_FIT),
      ...Object.keys(ORCHESTRATION_TEMPLATES),
    ])
      expect(catalogue.has(name), name).toBe(true);
    expect([...Object.keys(CREW_BRIEFS)].sort()).toEqual([...CREW_FORMATION_NAMES].sort());
    expect([...ORCHESTRATION_PATTERNS]).toEqual(CREW_FORMATION_NAMES);
    expect<string[]>([...TEXT_PATTERNS]).toEqual(Object.keys(TEXT_TEMPLATES));
    expect([...ROOM_FORMATIONS]).toEqual(ROOM_FORMATION_NAMES);
    expect([...ROOM_FORMATIONS].sort()).toEqual(["chorus", "debate", "verification"]);
  });

  it("descriptions come from the catalogue entry", () => {
    for (const view of listOrchestrationPatterns()) {
      const entry = FORMATIONS[view.id as keyof typeof FORMATIONS];
      expect(view.name).toBe(entry.title);
      expect(view.description).toBe(entry.summary);
      if (view.fit) expect(view.fit).toBe(entry.fit.join(", "));
    }
    for (const [name, fit] of Object.entries(PATTERN_FIT)) {
      const entry = FORMATIONS[name as keyof typeof FORMATIONS];
      expect(fit).toEqual({ shapes: entry.fit, why: entry.summary });
    }
  });

  it("every entry has a title, a summary and a protocol", () => {
    for (const name of FORMATION_NAMES) {
      const entry = FORMATIONS[name];
      expect(entry.title.toLowerCase(), name).toBe(name);
      expect(entry.summary.length, name).toBeGreaterThan(0);
      expect(entry.protocol.length, name).toBeGreaterThan(0);
    }
  });
});

describe("legacy names parse as aliases", () => {
  it("nsed is deliberation and custom is freeform, on every surface", () => {
    expect(canonicalFormationName(" NSED ")).toBe("deliberation");
    expect(canonicalFormationName("Custom")).toBe("freeform");
    expect(normalizePatternName("nsed")).toBe("deliberation");
    expect(resolveCrewFormation("nsed")).toEqual({ formation: "deliberation" });
    expect(resolveCrewFormation("custom")).toEqual({ formation: "freeform" });
    expect(resolveTextPattern("NSED")).toEqual({ pattern: "deliberation" });
    expect(roomFormationName("Debate")).toBe("debate");
    for (const alias of ALIASES) expect(catalogue.has(FORMATION_ALIASES[alias]!)).toBe(true);
  });
});

describe("help advertises catalogue names only", () => {
  it("crew, project, pattern and build help list catalogue names and no alias", () => {
    expect(CREW_FORMATION_HELP).toBe(CREW_FORMATION_NAMES.join(", "));
    expect(ORCHESTRATION_HELP).toBe(CREW_FORMATION_NAMES.join("|"));
    for (const text of [CREW_FORMATION_HELP, ORCHESTRATION_HELP, TEXT_PATTERNS.join(" ")])
      for (const alias of ALIASES) expect(words(text)).not.toContain(alias);
  });

  describe("in the world", () => {
    let db: MarinaDB;
    let engine: Engine;
    const dbPath = `/tmp/marina-one-orchestration-${Date.now()}-${Math.random()}.db`;
    beforeEach(() => {
      db = new MarinaDB(dbPath);
      engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    });
    afterEach(() => {
      engine.stop();
      db.close();
      cleanupDb(dbPath);
    });

    it("the crew, project, pattern and build commands name no alias", () => {
      for (const name of ["crew", "project", "pattern", "build"]) {
        const def = engine.commands.allBuiltins().find((c) => c.name === name)!;
        // `project … decompose|memory custom` is a different (non-formation) `custom`.
        const forms = (def.usage ?? [])
          .map((u) => (typeof u === "string" ? u : u.syntax))
          .filter((s) => name !== "project" || s.includes("orchestrate"));
        const text = [def.help, ...forms].join("\n");
        for (const alias of ALIASES) expect(words(text), `${name}: ${alias}`).not.toContain(alias);
      }
      const crew = engine.commands.allBuiltins().find((c) => c.name === "crew")!;
      expect(crew.help).toContain(CREW_FORMATION_HELP);
    });
  });
});

describe("crew validation against the catalogue", () => {
  it("accepts crew formations, refuses entries with no crew protocol and unknown names", () => {
    for (const name of CREW_FORMATION_NAMES)
      expect(resolveCrewFormation(name)).toEqual({ formation: name });
    for (const name of ["ensemble", "skeptic"]) {
      const r = resolveCrewFormation(name);
      expect("error" in r && r.error).toContain("no crew protocol");
    }
    const unknown = resolveCrewFormation("bogus");
    expect("error" in unknown && unknown.error).toContain(
      `Crew formations: ${CREW_FORMATION_HELP}`,
    );
  });

  describe("commands", () => {
    let db: MarinaDB;
    let engine: Engine;
    let alice: MockConnection;
    let bob: MockConnection;
    const dbPath = `/tmp/marina-one-orchestration-crew-${Date.now()}-${Math.random()}.db`;
    beforeEach(() => {
      db = new MarinaDB(dbPath);
      engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      alice = new MockConnection("c-alice");
      bob = new MockConnection("c-bob");
      engine.addConnection(alice);
      engine.addConnection(bob);
      engine.spawnEntity("c-alice", "alice");
      engine.spawnEntity("c-bob", "bob");
    });
    afterEach(() => {
      engine.stop();
      db.close();
      cleanupDb(dbPath);
    });
    const out = (c: MockConnection) => stripAnsi(c.allTextJoined());

    it("crew create validates formation:<f>, resolving aliases, with no model provider", () => {
      engine.processCommand(alice.entity!, "crew create a1 bob formation:skeptic -- goal");
      expect(out(alice)).toContain("no crew protocol");
      expect(engine.crewManager?.getByName("a1")).toBeUndefined();
      engine.processCommand(alice.entity!, "crew create a2 bob formation:nsed -- goal");
      expect(engine.crewManager?.getByName("a2")?.formation).toBe("deliberation");
      alice.clear();
      engine.processCommand(alice.entity!, "crew formation a2 ensemble");
      expect(out(alice)).toContain("no crew protocol");
      expect(engine.crewManager?.getByName("a2")?.formation).toBe("deliberation");
    });

    it("crew info shows the catalogue description and protocol", () => {
      engine.processCommand(alice.entity!, "crew create d1 bob formation:debate -- settle it");
      alice.clear();
      engine.processCommand(alice.entity!, "crew info d1");
      const info = out(alice);
      expect(info).toContain(`debate — ${FORMATIONS.debate.summary}`);
      expect(info).toContain(protocolText(FORMATIONS.debate));
      expect(info).toContain(scoreStepsLine("debate")!);
    });

    it("crew dispatch offers the catalogue Score steps where the formation has a template", () => {
      engine.processCommand(alice.entity!, "crew create d2 bob formation:debate -- settle it");
      engine.processCommand(bob.entity!, "crew join d2");
      engine.processCommand(alice.entity!, "crew dispatch d2 which is better?");
      const crew = engine.crewManager!.getByName("d2")!;
      const posts = engine.channelManager!.getHistory(crew.channelId!, 20).map((m) => m.content);
      const task = posts.find((p) => p.startsWith("[crew-task]"))!;
      expect(task).toContain(
        "Score (debate): opening (each member) → rebuttal (each member) → judge (one checker).",
      );
      // A crew-only formation has no Score template, so its dispatch names no steps.
      engine.processCommand(alice.entity!, "crew create m1 bob formation:mapreduce -- split it");
      engine.processCommand(bob.entity!, "crew join m1");
      engine.processCommand(alice.entity!, "crew dispatch m1 go");
      const m1 = engine.crewManager!.getByName("m1")!;
      const m1Posts = engine.channelManager!.getHistory(m1.channelId!, 20).map((m) => m.content);
      expect(m1Posts.find((p) => p.startsWith("[crew-task]"))).not.toContain("Score (");
      // Mediator lines name the formation by its catalogue name.
      expect(m1Posts.some((p) => p.startsWith("[formation-mediator] mapreduce: "))).toBe(true);
    });
  });
});

describe("generated project templates", () => {
  it("open with the catalogue entry and contain its protocol phrases", () => {
    for (const [pattern, notes] of Object.entries(ORCHESTRATION_TEMPLATES)) {
      const entry = FORMATIONS[pattern as keyof typeof FORMATIONS];
      const opening = notes[0]!.content;
      expect(opening).toContain(`This project uses ${entry.title} orchestration`);
      expect(opening).toContain(entry.summary);
      expect(opening).toContain(protocolText(entry));
      for (const role of entry.roles) expect(opening).toContain(role);
      const all = notes
        .map((n) => n.content)
        .join(" ")
        .toLowerCase();
      for (const marker of [...(entry.markers ?? []), ...(entry.templateMarkers ?? [])])
        expect(all, `${pattern}: ${marker}`).toContain(marker.toLowerCase());
    }
    expect(Object.keys(ORCHESTRATION_TEMPLATES)).not.toContain("freeform");
  });
});
