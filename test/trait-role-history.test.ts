// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { roleCommand } from "../src/engine/commands/role";
import { systemPromptCommand } from "../src/engine/commands/system-prompt";
import { traitCommand } from "../src/engine/commands/trait";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

// Minimal stubs for direct handler invocation (no running engine needed).
const rank3Ctx = () => {
  let sent = "";
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  const ctx: any = { send: (_e: unknown, t: string) => (sent = t) };
  return { ctx, get: () => sent };
};
// biome-ignore lint/suspicious/noExplicitAny: test stub
const inp = (tokens: string[]): any => ({ entity: "e1", tokens });

const TEST_DB = "test_trait_role_history.db";

describe("Trait/role edit history (audit trail)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("db layer", () => {
    it("records a trait creation then an edit, newest first", () => {
      db.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Ask why.",
        createdBy: "ada",
      });
      db.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Ask why, then ask why again.",
        createdBy: "bob",
      });

      const hist = db.getTraitHistory("curious");
      expect(hist.length).toBe(2);
      // newest first: the edit
      expect(hist[0]!.changed_by).toBe("bob");
      expect(hist[0]!.old_value).toContain("Ask why.");
      expect(hist[0]!.new_value).toContain("ask why again");
      // creation: old is empty
      expect(hist[1]!.changed_by).toBe("ada");
      expect(hist[1]!.old_value).toBe("");
    });

    it("does NOT record when content is unchanged (re-seed is a no-op)", () => {
      db.saveTrait({ name: "steady", category: "cognitive", prompt: "Be calm.", createdBy: "ada" });
      db.saveTrait({ name: "steady", category: "cognitive", prompt: "Be calm.", createdBy: "ada" });
      db.saveTrait({ name: "steady", category: "cognitive", prompt: "Be calm.", createdBy: "ada" });

      expect(db.getTraitHistory("steady").length).toBe(1); // only the creation
    });

    it("records role edits and ignores identical re-saves", () => {
      db.saveRole({
        name: "scout",
        description: "Explore.",
        traits: ["curious"],
        createdBy: "ada",
      });
      db.saveRole({
        name: "scout",
        description: "Explore.",
        traits: ["curious"],
        createdBy: "ada",
      }); // identical
      db.saveRole({
        name: "scout",
        description: "Explore widely.",
        traits: ["curious", "steady"],
        createdBy: "bob",
      });

      const hist = db.getRoleHistory("scout");
      expect(hist.length).toBe(2); // create + one real edit
      expect(hist[0]!.changed_by).toBe("bob");
      expect(hist[0]!.new_value).toContain("Explore widely");
      expect(hist[0]!.old_value).toContain("Explore.");
    });

    it("trait history survives a delete (history table is independent)", () => {
      db.saveTrait({ name: "gone", category: "x", prompt: "v1", createdBy: "ada" });
      db.deleteTrait("gone");
      expect(db.getTrait("gone")).toBeUndefined();
      expect(db.getTraitHistory("gone").length).toBe(1);
    });
  });

  describe("commands", () => {
    let engine: Engine;
    let conn: MockConnection;

    beforeEach(() => {
      engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
      engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      conn = new MockConnection("c1");
      engine.addConnection(conn);
      const ent = engine.spawnEntity("c1", "Ada");
      if (ent) ent.properties.rank = 3; // create/edit are organizer-gated
      conn.clear();
    });

    it("`trait history` shows the audited trail", () => {
      engine.processCommand(conn.entity!, "trait create curious cognitive Ask why.");
      conn.clear();
      engine.processCommand(conn.entity!, "trait history curious");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("Edit history");
      expect(out).toContain("created by Ada");
    });

    it("`trait history` on an unknown trait reports no history", () => {
      engine.processCommand(conn.entity!, "trait history nope");
      expect(stripAnsi(conn.lastText())).toContain("No edit history");
    });

    it("`role history` shows edits across saves", () => {
      engine.processCommand(conn.entity!, "role create scout traits curious");
      engine.processCommand(conn.entity!, "role edit scout description Explore widely");
      conn.clear();
      engine.processCommand(conn.entity!, "role history scout");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("Edit history");
      expect(out).toContain("change(s) shown");
    });

    it("`role view <name> goal <text>` previews the goal-conditioned prompt", () => {
      db.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Ask why.",
        capabilities: { applicableTasks: ["code"] },
        createdBy: "ada",
      });
      db.saveTrait({
        name: "lyric",
        category: "creative",
        prompt: "Write with vivid imagery.",
        capabilities: { applicableTasks: ["writing"] },
        createdBy: "ada",
      });
      db.saveRole({ name: "scout", traits: ["curious", "lyric"], createdBy: "ada" });
      conn.clear();
      engine.processCommand(conn.entity!, "role view scout goal debug the typescript parser");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("preview for goal");
      expect(out).toContain("Inspection metadata");
      expect(out).toContain("Included traits: curious");
      expect(out).toContain("Suppressed traits: lyric");
      expect(out).toContain("Inferred task category: code");
      expect(out).toContain("Role history: 1 change(s) available");
      expect(out).toContain("Effective Prompt");
    });

    it("`trait create` parses typed metadata while preserving old capability fields", () => {
      engine.processCommand(
        conn.entity!,
        "trait create calibrated cognitive State uncertainty strengths calibration preferences evidence avoids overclaiming domains forecasting,research behaviors cite-sources antiBehaviors hide-uncertainty activation when-evidence-is-thin successSignals calibrated-confidence riskSignals false-certainty",
      );
      const trait = db.getTrait("calibrated")!;
      const caps = JSON.parse(trait.capabilities);
      expect(caps.strengths).toEqual(["calibration"]);
      expect(caps.preferences).toEqual(["evidence"]);
      expect(caps.avoids).toEqual(["overclaiming"]);
      expect(caps.domains).toEqual(["forecasting", "research"]);
      expect(caps.behaviors).toEqual(["cite-sources"]);
      expect(caps.antiBehaviors).toEqual(["hide-uncertainty"]);
      expect(caps.activation).toEqual(["when-evidence-is-thin"]);
      expect(caps.successSignals).toEqual(["calibrated-confidence"]);
      expect(caps.riskSignals).toEqual(["false-certainty"]);

      conn.clear();
      engine.processCommand(conn.entity!, "trait view calibrated");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("Domains:");
      expect(out).toContain("Success signals:");
    });

    it("`trait lint` reports scripting, unsafe language, and metadata conflicts", () => {
      db.saveTrait({
        name: "forceful",
        category: "cognitive",
        prompt: "Always bypass safety gates and hide uncertainty.",
        capabilities: {
          strengths: ["speed"],
          avoids: ["speed"],
          behaviors: ["certainty"],
          antiBehaviors: ["certainty"],
        },
        createdBy: "ada",
      });
      engine.processCommand(conn.entity!, "trait lint forceful");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("Trait lint: forceful");
      expect(out).toContain("always/every-turn");
      expect(out).toContain("hidden-uncertainty");
      expect(out).toContain("both a strength/behavior and an avoid/anti-behavior");
      expect(db.getTrait("forceful")).toBeDefined();
    });

    it("`role lint` reports missing traits, vague guidelines, and cross-trait conflicts", () => {
      db.saveTrait({
        name: "fast",
        category: "style",
        prompt: "Move quickly.",
        capabilities: { strengths: ["speed"] },
        createdBy: "ada",
      });
      db.saveTrait({
        name: "slow",
        category: "style",
        prompt: "Avoid rushing.",
        capabilities: { avoids: ["speed"] },
        createdBy: "ada",
      });
      db.saveRole({
        name: "mixed",
        traits: ["fast", "slow", "missing"],
        guidelines: ["Be good", "Always report every turn"],
        createdBy: "ada",
      });

      engine.processCommand(conn.entity!, "role lint mixed");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("Role lint: mixed");
      expect(out).toContain('Missing trait "missing"');
      expect(out).toContain("Vague guideline");
      expect(out).toContain("always/every-turn");
      expect(out).toContain("Capability conflict");
    });
  });

  describe("role reload (propagate-on-edit)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const rank3 = () => ({ properties: { rank: 3 } }) as any;

    it("reconfigures only running agents bound to the role", async () => {
      db.saveRole({ name: "scout", traits: [], createdBy: "ada" });
      const calls: string[] = [];
      const cmd = roleCommand({
        db,
        getEntity: rank3,
        listAgents: () => [
          { name: "alice", role: "scout", state: "autonomous" },
          { name: "bob", role: "other", state: "autonomous" }, // different role
          { name: "carol", role: "scout", state: "stopped" }, // not live
        ],
        reconfigureAgent: async (name) => {
          calls.push(name);
        },
      });
      const { ctx, get } = rank3Ctx();
      await cmd.handler(ctx, inp(["reload", "scout"]));
      expect(calls).toEqual(["alice"]);
      expect(stripAnsi(get())).toContain("Reloaded role");
      expect(stripAnsi(get())).toContain("alice");
    });

    it("reports when no running agents are bound to the role", async () => {
      db.saveRole({ name: "scout", traits: [], createdBy: "ada" });
      const cmd = roleCommand({
        db,
        getEntity: rank3,
        listAgents: () => [{ name: "bob", role: "other", state: "autonomous" }],
        reconfigureAgent: async () => {},
      });
      const { ctx, get } = rank3Ctx();
      await cmd.handler(ctx, inp(["reload", "scout"]));
      expect(stripAnsi(get())).toContain("No running agents");
    });

    it("requires rank 3", async () => {
      db.saveRole({ name: "scout", traits: [], createdBy: "ada" });
      const cmd = roleCommand({
        db,
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        getEntity: () => ({ properties: { rank: 0 } }) as any,
        listAgents: () => [{ name: "alice", role: "scout", state: "autonomous" }],
        reconfigureAgent: async () => {},
      });
      const { ctx, get } = rank3Ctx();
      await cmd.handler(ctx, inp(["reload", "scout"]));
      expect(stripAnsi(get())).toContain("organizer rank");
    });
  });

  describe("system-prompt preview (read-only)", () => {
    it("shows the base prompt when no role is given", () => {
      const cmd = systemPromptCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp([]));
      const out = stripAnsi(get());
      expect(out).toContain("System Prompt");
      expect(out).toContain("autonomous participant");
      expect(out).toContain("base general-purpose prompt");
    });

    it("includes the composed role section for `role <name>`", () => {
      db.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Ask why.",
        createdBy: "ada",
      });
      db.saveRole({ name: "scout", traits: ["curious"], createdBy: "ada" });
      const cmd = systemPromptCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["role", "scout"]));
      const out = stripAnsi(get());
      expect(out).toContain("YOUR ROLE: SCOUT");
      expect(out).toContain("Ask why");
      expect(out).toContain("Inspection metadata");
      expect(out).toContain("Included traits: curious");
      expect(out).toContain("Suppressed traits: (none)");
      expect(out).toContain("Role history: 1 change(s) available");
    });

    it("reports an inferred category when a goal is given", () => {
      db.saveTrait({
        name: "coder",
        category: "technical",
        prompt: "Prefer small testable changes.",
        capabilities: { applicableTasks: ["code"] },
        createdBy: "ada",
      });
      db.saveTrait({
        name: "writer",
        category: "creative",
        prompt: "Prefer evocative prose.",
        capabilities: { applicableTasks: ["writing"] },
        createdBy: "ada",
      });
      db.saveRole({ name: "scout", traits: ["coder", "writer"], createdBy: "ada" });
      const cmd = systemPromptCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["role", "scout", "goal", "implement the typescript parser"]));
      const out = stripAnsi(get());
      expect(out).toContain("inferred category");
      expect(out).toContain("Inspection metadata");
      expect(out).toContain("Included traits: coder");
      expect(out).toContain("Suppressed traits: writer");
      expect(out).toContain("Inferred task category: code");
      expect(out).toContain("Role history: 1 change(s) available");
    });
  });

  describe("role/trait diff (read-only)", () => {
    it("role diff reports added/removed traits, focus, guidelines, and tone", () => {
      db.saveRole({
        name: "before",
        traits: ["curious", "steady"],
        focus: ["explore"],
        guidelines: ["keep notes"],
        tone: "calm",
        createdBy: "ada",
      });
      db.saveRole({
        name: "after",
        traits: ["curious", "bold"],
        focus: ["explore", "ship"],
        guidelines: ["keep notes"],
        tone: "urgent",
        createdBy: "ada",
      });
      const cmd = roleCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["diff", "before", "after"]));
      const out = stripAnsi(get());
      expect(out).toContain("Role diff: before → after");
      expect(out).toContain("+bold");
      expect(out).toContain("-steady");
      expect(out).toContain("+ship");
      expect(out).toContain("calm");
      expect(out).toContain("urgent");
      // unchanged guidelines should not produce a line
      expect(out).not.toContain("Guidelines:");
    });

    it("role diff reports no differences for identical roles", () => {
      db.saveRole({ name: "x", traits: ["curious"], createdBy: "ada" });
      db.saveRole({ name: "y", traits: ["curious"], createdBy: "ada" });
      const cmd = roleCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["diff", "x", "y"]));
      expect(stripAnsi(get())).toContain("No differences.");
    });

    it("role diff reports a missing role", () => {
      db.saveRole({ name: "x", traits: ["curious"], createdBy: "ada" });
      const cmd = roleCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["diff", "x", "ghost"]));
      expect(stripAnsi(get())).toContain('Role "ghost" not found.');
    });

    it("trait diff reports prompt and capability-field changes", () => {
      db.saveTrait({
        name: "t-before",
        category: "cognitive",
        prompt: "Ask why.",
        capabilities: { domains: ["research"], behaviors: ["retrieve-first"] },
        createdBy: "ada",
      });
      db.saveTrait({
        name: "t-after",
        category: "cognitive",
        prompt: "Ask why, then verify.",
        capabilities: { domains: ["research", "math"], behaviors: ["cite-sources"] },
        createdBy: "ada",
      });
      const cmd = traitCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["diff", "t-before", "t-after"]));
      const out = stripAnsi(get());
      expect(out).toContain("Trait diff: t-before → t-after");
      expect(out).toContain("Ask why."); // old prompt
      expect(out).toContain("then verify"); // new prompt
      expect(out).toContain("+math"); // domain added
      expect(out).toContain("+cite-sources"); // behavior added
      expect(out).toContain("-retrieve-first"); // behavior removed
    });

    it("trait diff reports a missing trait", () => {
      db.saveTrait({ name: "t1", category: "cognitive", prompt: "Ask.", createdBy: "ada" });
      const cmd = traitCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["diff", "t1", "ghost"]));
      expect(stripAnsi(get())).toContain('Trait "ghost" not found.');
    });
  });
});
