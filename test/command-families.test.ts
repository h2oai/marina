// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every command family (src/engine/command-families.ts) holds together: its
 * head and members are registered builtins, no member shadows a subcommand
 * the head already declares, `<head> <member> …` runs the member, the bare
 * member is an announced alias, and help lists members under their head.
 * The `memory` family's own behaviour is in test/memory-family.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { COMMAND_FAMILIES, familyOf } from "../src/engine/command-families";
import { commandManifest } from "../src/engine/command-manifest";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

describe("command families (structure)", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  it("every head and member is a registered builtin, and each member has one head", () => {
    const builtins = new Map(world.engine.commands.allBuiltins().map((d) => [d.name, d]));
    const seen = new Set<string>();
    for (const [head, members] of Object.entries(COMMAND_FAMILIES)) {
      expect(builtins.has(head)).toBe(true);
      for (const member of members) {
        expect({ head, member, registered: builtins.has(member) }).toMatchObject({
          registered: true,
        });
        expect(seen.has(member)).toBe(false);
        seen.add(member);
        expect(familyOf(member)).toBe(head);
      }
    }
  });

  it("no member shadows a subcommand its head declares", () => {
    const builtins = new Map(world.engine.commands.allBuiltins().map((d) => [d.name, d]));
    for (const [head, members] of Object.entries(COMMAND_FAMILIES)) {
      // `memory`'s own usage lists its family forms on purpose.
      if (head === "memory") continue;
      const verbs = new Set(
        (builtins.get(head)?.usage ?? []).map((u) =>
          (typeof u === "string" ? u : u.syntax).split(/\s+/)[1]?.toLowerCase(),
        ),
      );
      for (const member of members)
        expect({ head, member, shadows: verbs.has(member) }).toMatchObject({ shadows: false });
    }
  });

  it("discovery lists members under their head, never as top-level commands", () => {
    const manifest = commandManifest(world.engine.commands);
    for (const members of Object.values(COMMAND_FAMILIES))
      for (const member of members) {
        const entry = manifest.find((e) => e.name === member);
        expect(entry?.familyOf).toBe(familyOf(member));
      }
  });
});

describe("command families (engine)", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  const run = async (
    session: ReturnType<ReturnType<typeof createTestEngine>["login"]>,
    raw: string,
  ) => {
    session.connection.clear();
    await world.engine.processCommand(session.entityId, raw);
    return session.connection.messages.map((m) => stripAnsi(String(m.data?.text ?? ""))).join("\n");
  };

  it("`<head> <member>` runs the member; the bare member runs too and is announced once", async () => {
    const ada = world.login("Ada");
    const viaHead = await run(ada, "readiness posture");
    expect(viaHead).not.toContain("(alias:");
    const bare = await run(ada, "posture");
    expect(bare).toContain("(alias: use `readiness posture …`)");
    expect(bare.replace(/\n?\(alias:[^)]*\)$/, "")).toBe(viaHead);
    expect(await run(ada, "posture")).not.toContain("(alias:");

    expect(await run(ada, "outcome judge stats")).not.toContain("Unknown");
    expect(await run(ada, "watch probe")).not.toContain("Unknown");
    expect(await run(ada, "role trait list")).not.toContain("Unknown");
  });

  it("help lists the new members under their head", async () => {
    const ada = world.login("Ada");
    const help = await run(ada, "help");
    for (const member of ["posture", "competence", "bankroll", "recruit", "genome"])
      expect(help).not.toMatch(new RegExp(`^\\s*${member}\\b`, "m"));
    const readiness = await run(ada, "help readiness");
    expect(readiness).toContain("readiness posture —");
    expect(readiness).toContain("readiness uptime —");
  });

  it("a project name cannot start with a word that starts a new project", async () => {
    const ada = world.login("Ada");
    world.engine.entities.get(ada.entityId)!.properties.rank = 9;
    const refused = await run(ada, "project create Plan Review | quarterly");
    expect(refused).toContain('A project name cannot start with "plan"');
    expect(world.db.getProjectByName("Plan Review")).toBeFalsy();
  });
});
