// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { classifyCommandRisk } from "../src/agent/tool-policy";
import {
  aliasNotice,
  COMMAND_FAMILIES,
  familyOf,
  unfoldFamily,
} from "../src/engine/command-families";
import { commandManifest, describeCommand } from "../src/engine/command-manifest";
import { renderCapabilityRoster } from "../src/sdk/capabilities";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

const MEMBERS = COMMAND_FAMILIES.memory ?? [];

describe("command families (pure)", () => {
  it("names the memory members and unfolds only them", () => {
    expect([...MEMBERS]).toEqual(["note", "recall", "reflect", "recap", "debrief", "context"]);
    for (const member of MEMBERS) expect(familyOf(member)).toBe("memory");
    expect(familyOf("pool")).toBeUndefined();
    expect(familyOf("skill")).toBeUndefined();
    expect(unfoldFamily("memory recall cats all")).toBe("recall cats all");
    expect(unfoldFamily("memory debrief")).toBe("debrief");
    expect(unfoldFamily("memory kv set goal x")).toBe("memory kv set goal x");
    expect(unfoldFamily("memory remember x")).toBe("memory remember x");
    expect(aliasNotice("recall")).toBe("(alias: use `memory recall …`)");
    expect(aliasNotice("pool")).toBeUndefined();
  });

  it("a family form carries its member's tool risk", () => {
    for (const raw of [
      "note hello importance 5",
      "note list",
      "recall cats evidence",
      "reflect",
      "recap cats",
      "debrief",
      "context cats",
    ])
      expect(classifyCommandRisk(`memory ${raw}`)).toBe(classifyCommandRisk(raw));
    expect(classifyCommandRisk("memory recall cats")).toBe("read");
  });
});

describe("memory family (engine)", () => {
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
    return session.connection.messages.map((m) => stripAnsi(String(m.data?.text ?? "")));
  };

  it("`memory <member>` runs the member with the same output and no notice", async () => {
    const alice = world.login("Alice");
    const viaFamily = await run(alice, "memory note the decode room answers binary importance 7");
    expect(viaFamily.join("\n")).toMatch(/Note #\d+/);
    expect(viaFamily.join("\n")).not.toContain("(alias:");

    const familyRecall = await run(alice, "memory recall decode");
    const bareRecall = await run(alice, "recall decode");
    expect(bareRecall.slice(0, familyRecall.length)).toEqual(familyRecall);
    expect(familyRecall.join("\n")).toContain("decode room");

    for (const raw of ["memory debrief", "memory recap decode", "memory context decode"]) {
      const out = (await run(alice, raw)).join("\n");
      expect(out).not.toContain("Unknown");
      expect(out).not.toContain("(alias:");
    }
  });

  it("a bare alias runs identically and is announced once per session", async () => {
    const bob = world.login("Bob");
    const first = await run(bob, "note first observation");
    expect(first.at(-1)).toBe("(alias: use `memory note …`)");
    expect(first.slice(0, -1).join("\n")).toMatch(/Note #\d+/);
    const second = await run(bob, "note second observation");
    expect(second.join("\n")).not.toContain("(alias:");
    // Another alias gets its own single notice.
    const recall = await run(bob, "recall observation");
    expect(recall.at(-1)).toBe("(alias: use `memory recall …`)");
    // A new session hears it again.
    const carol = world.login("Carol");
    expect((await run(carol, "note hello")).at(-1)).toBe("(alias: use `memory note …`)");
  });

  it("legacy spellings still parse through both doors", async () => {
    const dave = world.login("Dave");
    await run(dave, "memory note claim the sky is blue confidence 0.9 source https://example.org");
    const listed = (await run(dave, "memory note list")).join("\n");
    expect(listed).toContain("the sky is blue");
    const id = /#(\d+)/.exec(listed)?.[1];
    expect(id).toBeDefined();
    const corrected = (await run(dave, `note correct ${id} the sky is often blue`)).join("\n");
    expect(corrected).not.toContain("Unknown");
  });

  it("discovery lists members under `memory`, never as roster lines", () => {
    const router = (
      world.engine as unknown as {
        commands: import("../src/engine/command-router").CommandRouter;
      }
    ).commands;
    const memory = router.getDef("memory")!;
    const forms = describeCommand(memory).forms ?? [];
    const syntax = forms.map((f) => f.syntax);
    expect(syntax).toContain("memory note <text>");
    expect(syntax.some((s) => s.startsWith("memory recall <query>"))).toBe(true);
    expect(forms.find((f) => f.syntax === "memory debrief")?.effect).toBe("read");
    expect(forms.find((f) => f.syntax === "memory note <text>")?.effect).toBe("write");

    const manifest = commandManifest(router);
    for (const member of MEMBERS)
      expect(manifest.find((e) => e.name === member)?.familyOf).toBe("memory");
    const roster = renderCapabilityRoster(manifest, 10_000, { includeRankLimited: true });
    expect(roster).toContain("\nmemory:");
    for (const member of MEMBERS) expect(roster).not.toContain(`\n${member}:`);
  });

  it("help lists members under their head", async () => {
    const erin = world.login("Erin");
    const all = (await run(erin, "help all")).join("\n");
    expect(all).not.toMatch(/^ {2}note — /m);
    expect(all).toContain("memory note, memory recall");
    const memory = (await run(erin, "help memory")).join("\n");
    expect(memory).toContain("Family: memory note <text>");
    const note = (await run(erin, "help note")).join("\n");
    expect(note).toContain("(alias: use `memory note …`)");
  });
});
