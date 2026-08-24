// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  applyInjection,
  buildInjectedContext,
  capturePassthruTranscript,
  DEFAULT_PASSTHRU_ENTITY,
  INJECTION_MARKER,
  resolvePassthruIdentity,
} from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_passthru_context.db";

function headers(rec: Record<string, string>): Headers {
  return new Headers(rec);
}

describe("passthru-context", () => {
  let db: MarinaDB;
  let engine: Engine;
  const prevKeys = process.env.MODEL_API_KEYS;
  const prevSharedPools = process.env.MARINA_PASSTHRU_SHARED_POOLS;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prevKeys === undefined) delete process.env.MODEL_API_KEYS;
    else process.env.MODEL_API_KEYS = prevKeys;
    if (prevSharedPools === undefined) delete process.env.MARINA_PASSTHRU_SHARED_POOLS;
    else process.env.MARINA_PASSTHRU_SHARED_POOLS = prevSharedPools;
  });

  // ─── Identity resolution ───────────────────────────────────────────────────

  describe("resolvePassthruIdentity", () => {
    it("binds a MODEL_API_KEYS 'secret:entity' key to that entity (distinct, lazily created)", () => {
      const id = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Alice" });
      expect(id.name).toBe("Alice");
      expect(id.shared).toBe(false);
      expect(engine.entities.findAgentByName("Alice")?.id).toBe(id.entityId);
      expect(id.contextOptIn).toBe(false); // default FALSE
    });

    it("a SCOPED bound key CANNOT impersonate another entity via X-Marina-Agent", () => {
      // Even with the header set, a scoped `secret:entity` key (canNameMap:false)
      // resolves ONLY to its bound entity — the header is ignored.
      const id = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Carol" }), {
        boundEntityName: "Ops",
        canNameMap: false,
      });
      expect(id.name).toBe("Ops");
      expect(id.shared).toBe(false);
      expect(engine.entities.findAgentByName("Carol")).toBeUndefined();
    });

    it("honors X-Marina-Agent for a name-map-authorized credential, but ONLY to an EXISTING entity", () => {
      // Pre-existing target → mapped.
      engine.entities.create({
        kind: "agent",
        name: "Dave",
        short: "Dave",
        long: "existing",
        room: engine.config.startRoom,
        properties: {},
      });
      const mapped = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Dave" }), {
        canNameMap: true,
      });
      expect(mapped.name).toBe("Dave");
      expect(mapped.shared).toBe(false);
    });

    it("REFUSES to auto-create an arbitrary entity from X-Marina-Agent (name-map to non-existent falls back to shared)", () => {
      const id = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Ghost" }), {
        canNameMap: true,
      });
      // Unknown target must NOT be conjured from a header → shared passthru fallback.
      expect(engine.entities.findAgentByName("Ghost")).toBeUndefined();
      expect(id.name).toBe(DEFAULT_PASSTHRU_ENTITY);
      expect(id.shared).toBe(true);
    });

    it("IGNORES X-Marina-Agent for an unbound plain key (no name-map authority)", () => {
      // Plain key is authenticated but canNameMap:false → shared entity.
      const id = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Mallory" }), {
        canNameMap: false,
      });
      expect(id.name).toBe(DEFAULT_PASSTHRU_ENTITY);
      expect(id.shared).toBe(true);
      expect(engine.entities.findAgentByName("Mallory")).toBeUndefined();
    });

    it("IGNORES X-Marina-Agent for an anonymous open-mode caller with no target entity", () => {
      const id = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Eve" }), {
        openMode: true,
        canNameMap: true,
      });
      // Eve does not exist → no auto-create → shared.
      expect(id.name).toBe(DEFAULT_PASSTHRU_ENTITY);
      expect(id.shared).toBe(true);
      expect(engine.entities.findAgentByName("Eve")).toBeUndefined();
    });

    it("defaults to the stable shared passthru entity", () => {
      const a = resolvePassthruIdentity(engine, headers({}), {});
      const b = resolvePassthruIdentity(engine, headers({}), {});
      expect(a.name).toBe(DEFAULT_PASSTHRU_ENTITY);
      expect(a.shared).toBe(true);
      expect(a.entityId).toBe(b.entityId); // reused, not duplicated
    });

    it("sets contextOptIn from the X-Marina-Context header for a DISTINCT identity", () => {
      const on = resolvePassthruIdentity(engine, headers({ "X-Marina-Context": "on" }), {
        boundEntityName: "Ctx",
      });
      expect(on.contextOptIn).toBe(true);
      const off = resolvePassthruIdentity(engine, headers({ "X-Marina-Context": "off" }), {
        boundEntityName: "Ctx",
      });
      expect(off.contextOptIn).toBe(false);
    });

    it("NEVER opts the shared/anonymous entity into context (no cross-caller injection)", () => {
      // Even X-Marina-Context: on cannot make the shared default entity opt in —
      // it is pure passthru, so it can never capture or receive injected context.
      const id = resolvePassthruIdentity(engine, headers({ "X-Marina-Context": "on" }), {});
      expect(id.shared).toBe(true);
      expect(id.contextOptIn).toBe(false);
    });

    it("sets contextOptIn from the resolved identity's config property", () => {
      const first = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Optin" });
      const ent = engine.entities.get(first.entityId)!;
      ent.properties.passthruContext = true;
      const again = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Optin" });
      expect(again.contextOptIn).toBe(true);
    });
  });

  // ─── Context building (shared-scope ONLY) ───────────────────────────────────

  describe("buildInjectedContext", () => {
    it("injects the entity's OWN notes (shared-scope) but NEVER a foreign private note", async () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      // My own note — should be eligible.
      db.createNote(me.name, "quantum widget calibration is my ongoing project", undefined, {
        importance: 6,
      });
      // A DIFFERENT entity's PRIVATE (pool-less) note with the SAME keywords.
      db.createNote("Bob", "quantum widget SECRETPASSWORD hidden by bob", undefined, {
        importance: 9,
      });

      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: "tell me about the quantum widget" },
      ]);

      expect(systemAddendum).not.toBeNull();
      expect(systemAddendum).toContain(INJECTION_MARKER);
      expect(systemAddendum).toContain("calibration");
      // The foreign private note must NEVER appear.
      expect(systemAddendum).not.toContain("SECRETPASSWORD");
    });

    it("injects world-shared pool notes but not foreign private notes", async () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      process.env.MARINA_PASSTHRU_SHARED_POOLS = "ideas";
      const poolId = "pool_ideas_1";
      db.createMemoryPool(poolId, "ideas", "Founder");
      db.createNote("Founder", "shared aurora protocol design in the pool", undefined, {
        poolId,
        importance: 7,
      });
      // Foreign private note, same keyword, NOT in a pool → must not leak.
      db.createNote("Trudy", "aurora protocol TRUDYSECRET private", undefined, { importance: 9 });

      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: "what about the aurora protocol?" },
      ]);

      expect(systemAddendum).toContain("aurora");
      expect(systemAddendum).not.toContain("TRUDYSECRET");
    });

    it("injects a MEMBER pool but NEVER a non-member pool (no pool harvesting)", async () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      // No env allowlist here — eligibility must come purely from membership.
      delete process.env.MARINA_PASSTHRU_SHARED_POOLS;

      // A pool whose group the entity IS a member of → eligible.
      db.createGroup({ id: "g_member", name: "member-crew", leaderId: me.entityId });
      db.addGroupMember("g_member", me.entityId);
      db.createMemoryPool("pool_member_1", "member-pool", "Founder", "g_member");
      db.createNote("Founder", "aurora protocol MEMBERVISIBLE design", undefined, {
        poolId: "pool_member_1",
        importance: 7,
      });

      // A pool whose group the entity is NOT a member of → must never leak.
      db.createGroup({ id: "g_other", name: "other-crew", leaderId: me.entityId });
      db.createMemoryPool("pool_other_1", "other-pool", "Stranger", "g_other");
      db.createNote("Stranger", "aurora protocol NONMEMBERSECRET design", undefined, {
        poolId: "pool_other_1",
        importance: 9,
      });

      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: "what about the aurora protocol?" },
      ]);

      expect(systemAddendum).toContain("MEMBERVISIBLE");
      expect(systemAddendum).not.toContain("NONMEMBERSECRET");
    });

    it("returns null when nothing relevant matches", async () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      db.createNote("Bob", "unrelated content about penguins", undefined, {});
      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: "zzz nonexistent topic qqq" },
      ]);
      expect(systemAddendum).toBeNull();
    });

    it("returns null on an empty query", async () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, []);
      expect(systemAddendum).toBeNull();
    });
  });

  // ─── applyInjection (format-preserving, idempotent, no-op-safe) ─────────────

  describe("applyInjection", () => {
    it("is a no-op when the addendum is null (byte-identical body)", () => {
      const body = { model: "x", messages: [{ role: "user", content: "hi" }] };
      const snapshot = JSON.stringify(body);
      const out = applyInjection(body, null, "openai");
      expect(JSON.stringify(out)).toBe(snapshot);
    });

    it("prepends to an existing openai system message", () => {
      const body = {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "hi" },
        ],
      };
      applyInjection(body, "ADDENDUM_TEXT", "openai");
      const sys = body.messages[0]!;
      expect(sys.role).toBe("system");
      expect(sys.content).toContain("ADDENDUM_TEXT");
      expect(sys.content).toContain("You are helpful.");
      expect(body.messages).toHaveLength(2); // additive to the system message, not a new one
    });

    it("unshifts a system message when none exists (openai)", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      applyInjection(body, "ADD2", "openai");
      expect(body.messages[0]!.role).toBe("system");
      expect(body.messages[0]!.content).toBe("ADD2");
      expect(body.messages[1]!.role).toBe("user");
    });

    it("extends an anthropic string system field", () => {
      const body = { system: "base system", messages: [] };
      applyInjection(body, `${INJECTION_MARKER} ctx`, "anthropic");
      expect(body.system).toContain(INJECTION_MARKER);
      expect(body.system).toContain("base system");
    });

    it("extends an anthropic block-array system field", () => {
      const body = { system: [{ type: "text", text: "base" }] as unknown[] };
      applyInjection(body, `${INJECTION_MARKER} ctx`, "anthropic");
      expect(Array.isArray(body.system)).toBe(true);
      expect((body.system[0] as { text: string }).text).toContain(INJECTION_MARKER);
      expect((body.system[1] as { text: string }).text).toBe("base");
    });

    it("sets anthropic system when absent", () => {
      const body: { system?: unknown } = {};
      applyInjection(body, "ONLY", "anthropic");
      expect(body.system).toBe("ONLY");
    });

    it("is idempotent (marker guard) across openai + anthropic", () => {
      const add = `${INJECTION_MARKER} once`;
      const oa = { messages: [{ role: "system", content: "s" }] };
      applyInjection(oa, add, "openai");
      applyInjection(oa, add, "openai");
      const occurrences = (oa.messages[0]!.content.match(/marina:shared-world-context/g) ?? [])
        .length;
      expect(occurrences).toBe(1);

      const an = { system: "s" };
      applyInjection(an, add, "anthropic");
      applyInjection(an, add, "anthropic");
      const anOcc = ((an.system as string).match(/marina:shared-world-context/g) ?? []).length;
      expect(anOcc).toBe(1);
    });
  });

  // ─── Transcript capture (OWNED memory only) ─────────────────────────────────

  describe("capturePassthruTranscript", () => {
    it("writes a note OWNED by the resolved entity", () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      capturePassthruTranscript(
        engine,
        me.entityId,
        [{ role: "user", content: "what is the capital of France?" }],
        "Paris.",
      );
      const notes = db.getNotesByEntity(me.name, 50);
      const captured = notes.find((n) => n.content.includes("[passthru]"));
      expect(captured).toBeDefined();
      expect(captured?.entity_name).toBe(me.name);
      expect(captured?.content).toContain("Paris");
    });

    it("skips capture on an empty response", () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      capturePassthruTranscript(engine, me.entityId, [{ role: "user", content: "hi" }], "   ");
      const notes = db.getNotesByEntity(me.name, 50);
      expect(notes.find((n) => n.content.includes("[passthru]"))).toBeUndefined();
    });

    it("never writes another entity's memory", () => {
      const me = resolvePassthruIdentity(engine, headers({}), {});
      capturePassthruTranscript(engine, me.entityId, [{ role: "user", content: "ping" }], "pong");
      // Bob has no passthru note.
      const bobNotes = db.getNotesByEntity("Bob", 50);
      expect(bobNotes.length).toBe(0);
    });
  });
});
