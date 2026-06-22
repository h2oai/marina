import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { roleCommand } from "../src/engine/commands/role";
import { systemPromptCommand } from "../src/engine/commands/system-prompt";
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
      engine.processCommand(conn.entity!, "role create scout traits curious");
      conn.clear();
      engine.processCommand(conn.entity!, "role view scout goal fix the parser bug");
      const out = stripAnsi(conn.lastText());
      expect(out).toContain("preview for goal");
      expect(out).toContain("Inferred task category");
      expect(out).toContain("Effective Prompt");
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
      expect(out).toContain("autonomous agent");
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
    });

    it("reports an inferred category when a goal is given", () => {
      db.saveRole({ name: "scout", traits: [], createdBy: "ada" });
      const cmd = systemPromptCommand({ db });
      const { ctx, get } = rank3Ctx();
      cmd.handler(ctx, inp(["role", "scout", "goal", "fix the parser bug"]));
      expect(stripAnsi(get())).toContain("inferred category");
    });
  });
});
