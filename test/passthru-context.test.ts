// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { buildUnifiedContext, UNIFIED_TIER_LABELS } from "../src/memory/unified-context";
import {
  applyInjection,
  buildInjectedContext,
  CAPTURE_DEDUP_WINDOW_MS,
  capturePassthruTranscript,
  DEFAULT_PASSTHRU_ENTITY,
  DEFAULT_PASSTHRU_INJECT_BYTES,
  INJECTION_FRAMING,
  INJECTION_MARKER,
  resetPassthruCaptureDedupForTests,
  resolveInjectBudget,
  resolvePassthruIdentity,
} from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture, tierIds } from "./fixtures/unified-memory-fixture";
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
    resetPassthruCaptureDedupForTests();
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

    it("IGNORES X-Marina-Context for a NAME-MAPPED target that never opted in (no forced sharing)", () => {
      // A multi-tenant operator key (canNameMap) must NOT be able to force context
      // sharing/capture on a name-mapped target agent via the request header.
      engine.entities.create({
        kind: "agent",
        name: "Victim",
        short: "Victim",
        long: "never opted in",
        room: engine.config.startRoom,
        properties: {},
      });
      const mapped = resolvePassthruIdentity(
        engine,
        headers({ "X-Marina-Agent": "Victim", "X-Marina-Context": "on" }),
        { canNameMap: true },
      );
      expect(mapped.name).toBe("Victim");
      expect(mapped.shared).toBe(false);
      expect(mapped.contextOptIn).toBe(false); // header ignored — target never consented
    });

    it("opts a NAME-MAPPED target in ONLY via its own stored passthruContext property", () => {
      const target = engine.entities.create({
        kind: "agent",
        name: "Consenting",
        short: "Consenting",
        long: "opted in",
        room: engine.config.startRoom,
        properties: { passthruContext: true },
      });
      // No X-Marina-Context header — opt-in must come from the target's property.
      const mapped = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": "Consenting" }), {
        canNameMap: true,
      });
      expect(mapped.entityId).toBe(target.id);
      expect(mapped.contextOptIn).toBe(true);
    });

    it("still honors X-Marina-Context for a BOUND secret:entity key (unchanged)", () => {
      const bound = resolvePassthruIdentity(engine, headers({ "X-Marina-Context": "on" }), {
        boundEntityName: "BoundOps",
        canNameMap: false,
      });
      expect(bound.name).toBe("BoundOps");
      expect(bound.shared).toBe(false);
      expect(bound.contextOptIn).toBe(true); // operator-declared binding → header opt-in allowed
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

    it("injects the unified own-memory tiers with labels — same tiers/ids as buildUnifiedContext", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      // Name-map onto the EXISTING fixture entity (authorized credential).
      const me = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": fx.owner }), {
        canNameMap: true,
      });
      expect(me.name).toBe(fx.owner);
      expect(me.shared).toBe(false);

      const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: `what is the ${FIXTURE_QUERY}?` },
      ]);
      expect(systemAddendum).not.toBeNull();
      expect(systemAddendum).toContain(INJECTION_MARKER);
      expect(systemAddendum).toContain(
        "Untrusted, read-only Marina context; verify before acting:",
      );
      expect(systemAddendum!.length).toBeLessThanOrEqual(2048);

      // The passthru surface uses the same builder with its own caps; every
      // item it produced appears with its tier label and provenance.
      const direct = await buildUnifiedContext(db, fx.owner, `what is the ${FIXTURE_QUERY}?`, {
        budgetBytes: 1200,
        perTier: { skill: 1, trusted: 2, evidence: 2, proposal: 1, unverified: 1 },
      });
      const ids = tierIds(direct);
      expect(Object.keys(ids).sort()).toEqual([
        "evidence",
        "proposal",
        "skill",
        "trusted",
        "unverified",
      ]);
      for (const tier of direct.tiers)
        for (const item of tier.items)
          expect(systemAddendum).toContain(`Own memory ${tier.label} (${item.provenance})`);
      expect(systemAddendum).toContain(`${UNIFIED_TIER_LABELS.trusted} (#${fx.verifiedNoteId} `);
      expect(systemAddendum).toContain(
        `${UNIFIED_TIER_LABELS.evidence} (record ${fx.recordId} v1)`,
      );
      expect(systemAddendum).toContain(`${UNIFIED_TIER_LABELS.evidence} (source ${fx.sourceId} `);
      expect(systemAddendum).toContain(`${UNIFIED_TIER_LABELS.proposal} (proposal ${fx.jobId} `);
      expect(systemAddendum).toContain(`${UNIFIED_TIER_LABELS.unverified} (#${fx.plainNoteId} `);
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

    it("a client-supplied marker in the body NO LONGER suppresses injection", () => {
      // The literal marker used to be a client-controlled kill switch. Opt-out is
      // now the explicit `X-Marina-Context: off` header (bound keys only).
      const oa = { messages: [{ role: "system", content: `${INJECTION_MARKER} echoed` }] };
      applyInjection(oa, "FRESH", "openai");
      expect(oa.messages[0]!.content.startsWith("FRESH")).toBe(true);
      const an = { system: `${INJECTION_MARKER} echoed` };
      applyInjection(an, "FRESH", "anthropic");
      expect((an.system as string).startsWith("FRESH")).toBe(true);
    });

    it("prepends to the Ollama /api/generate `system` string", () => {
      const withBase: Record<string, unknown> = { prompt: "hi", system: "base" };
      applyInjection(withBase, "ADD", "ollama-generate");
      expect(withBase.system).toBe("ADD\n\nbase");
      const bare: Record<string, unknown> = { prompt: "hi" };
      applyInjection(bare, "ADD", "ollama-generate");
      expect(bare.system).toBe("ADD");
    });

    it("prepends to the Responses API `instructions` string", () => {
      const withBase: Record<string, unknown> = { input: "hi", instructions: "base" };
      applyInjection(withBase, "ADD", "responses");
      expect(withBase.instructions).toBe("ADD\n\nbase");
      const bare: Record<string, unknown> = { input: "hi" };
      applyInjection(bare, "ADD", "responses");
      expect(bare.instructions).toBe("ADD");
    });
  });

  // ─── Header opt-out, budget, ordering, receipt ─────────────────────────────

  describe("X-Marina-Context: off", () => {
    it("opts a BOUND key out even when its stored property opts in", () => {
      const first = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "OptOut" });
      engine.entities.get(first.entityId)!.properties.passthruContext = true;
      const on = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "OptOut" });
      expect(on.contextOptIn).toBe(true);
      expect(on.bound).toBe(true);
      const off = resolvePassthruIdentity(engine, headers({ "X-Marina-Context": "off" }), {
        boundEntityName: "OptOut",
      });
      expect(off.contextOptIn).toBe(false);
    });

    it("is IGNORED for a name-mapped target (a header can neither force nor strip consent)", () => {
      engine.entities.create({
        kind: "agent",
        name: "Mapped",
        short: "Mapped",
        long: "opted in by property",
        room: engine.config.startRoom,
        properties: { passthruContext: true },
      });
      const mapped = resolvePassthruIdentity(
        engine,
        headers({ "X-Marina-Agent": "Mapped", "X-Marina-Context": "off" }),
        { canNameMap: true },
      );
      expect(mapped.bound).toBe(false);
      expect(mapped.contextOptIn).toBe(true); // header ignored — stored consent stands
    });
  });

  describe("budget, ordering and receipt", () => {
    it("resolves the budget from the entity property, then the env, then the default", () => {
      const prev = process.env.MARINA_PASSTHRU_INJECT_BYTES;
      try {
        delete process.env.MARINA_PASSTHRU_INJECT_BYTES;
        const me = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Budget" });
        const entity = engine.entities.get(me.entityId)!;
        expect(resolveInjectBudget(entity)).toBe(DEFAULT_PASSTHRU_INJECT_BYTES);
        process.env.MARINA_PASSTHRU_INJECT_BYTES = "4096";
        expect(resolveInjectBudget(entity)).toBe(4096);
        entity.properties.passthruInjectBytes = 600;
        expect(resolveInjectBudget(entity)).toBe(600);
        entity.properties.passthruInjectBytes = "10"; // clamped to the floor
        expect(resolveInjectBudget(entity)).toBe(256);
      } finally {
        if (prev === undefined) delete process.env.MARINA_PASSTHRU_INJECT_BYTES;
        else process.env.MARINA_PASSTHRU_INJECT_BYTES = prev;
      }
    });

    it("renders stable tiers first, volatile last, byte-stable across calls, and reports a receipt", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      const me = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": fx.owner }), {
        canNameMap: true,
      });
      const messages = [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }];
      const first = await buildInjectedContext(engine, me.entityId, messages);
      const second = await buildInjectedContext(engine, me.entityId, messages);
      expect(first.systemAddendum).not.toBeNull();
      expect(second.systemAddendum).toBe(first.systemAddendum);

      const lines = first.systemAddendum!.split("\n");
      expect(lines[0]).toBe(INJECTION_MARKER);
      expect(lines[1]).toBe(INJECTION_FRAMING);
      expect(lines[2]).toBe(`Marina memory for ${fx.owner}.`);
      const order = (label: string) =>
        lines.findIndex((line) => line.startsWith(`Own memory ${label} (`));
      const skill = order(UNIFIED_TIER_LABELS.skill);
      const trusted = order(UNIFIED_TIER_LABELS.trusted);
      const evidence = order(UNIFIED_TIER_LABELS.evidence);
      const proposal = order(UNIFIED_TIER_LABELS.proposal);
      const unverified = order(UNIFIED_TIER_LABELS.unverified);
      expect(skill).toBeGreaterThan(2);
      expect(trusted).toBeGreaterThan(skill);
      expect(evidence).toBeGreaterThan(trusted);
      expect(proposal).toBeGreaterThan(evidence);
      expect(unverified).toBeGreaterThan(proposal);

      const receipt = first.receipt!;
      expect(receipt.schema).toBe("marina.memory.receipt.v1");
      expect(receipt.entity).toBe(fx.owner);
      expect(receipt.budgetBytes).toBe(DEFAULT_PASSTHRU_INJECT_BYTES);
      expect(receipt.usedBytes).toBe(new TextEncoder().encode(first.systemAddendum!).length);
      expect(receipt.usedBytes).toBeLessThanOrEqual(receipt.budgetBytes);
      const tiers = Object.fromEntries(receipt.tiers.map((t) => [t.tier, t.ids]));
      expect(tiers.trusted).toEqual([{ id: String(fx.verifiedNoteId) }]);
      expect(tiers.evidence).toContainEqual({ id: fx.recordId, version: 1 });
      expect(tiers.evidence!.some((ref) => ref.id === fx.sourceId && ref.hash)).toBe(true);
      expect(tiers.proposal).toEqual([{ id: fx.jobId }]);
      expect(tiers.unverified).toEqual([{ id: String(fx.plainNoteId) }]);
      for (const tier of receipt.tiers) expect(tier.bytes).toBeGreaterThan(0);
    });

    it("enforces the per-identity byte budget over the whole addendum and flags truncation", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      const me = resolvePassthruIdentity(engine, headers({ "X-Marina-Agent": fx.owner }), {
        canNameMap: true,
      });
      engine.entities.get(me.entityId)!.properties.passthruInjectBytes = 300;
      const built = await buildInjectedContext(engine, me.entityId, [
        { role: "user", content: `what is the ${FIXTURE_QUERY}?` },
      ]);
      expect(built.systemAddendum).not.toBeNull();
      const bytes = new TextEncoder().encode(built.systemAddendum!).length;
      expect(bytes).toBeLessThanOrEqual(300);
      expect(built.receipt!.budgetBytes).toBe(300);
      expect(built.receipt!.usedBytes).toBe(bytes);
      expect(built.receipt!.truncated).toBe(true);
      // An explicit option overrides the property.
      const wide = await buildInjectedContext(
        engine,
        me.entityId,
        [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }],
        { budgetBytes: 4096 },
      );
      expect(wide.receipt!.budgetBytes).toBe(4096);
      expect(wide.receipt!.usedBytes).toBeGreaterThan(bytes);
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

    it("captures an identical exchange once per entity per 24h window", () => {
      const me = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Dedup" });
      const other = resolvePassthruIdentity(engine, headers({}), { boundEntityName: "Other" });
      const msgs = [{ role: "user", content: "what is the capital of France?" }];
      const t0 = Date.now();
      expect(capturePassthruTranscript(engine, me.entityId, msgs, "Paris.", t0)).toBe(true);
      expect(capturePassthruTranscript(engine, me.entityId, msgs, "Paris.", t0 + 1000)).toBe(false);
      // A different answer is a different exchange.
      expect(capturePassthruTranscript(engine, me.entityId, msgs, "Paris, France.", t0)).toBe(true);
      // Dedup is per entity — another identity records its own copy.
      expect(capturePassthruTranscript(engine, other.entityId, msgs, "Paris.", t0)).toBe(true);
      // After the window the same exchange is captured again.
      expect(
        capturePassthruTranscript(
          engine,
          me.entityId,
          msgs,
          "Paris.",
          t0 + CAPTURE_DEDUP_WINDOW_MS + 1,
        ),
      ).toBe(true);
      const mine = db
        .getNotesByEntity(me.name, 50)
        .filter((n) => n.content.startsWith("[passthru]"));
      // DB-level exact dedup also collapses the post-window repeat onto the first note.
      expect(mine.length).toBe(2);
    });
  });
});
