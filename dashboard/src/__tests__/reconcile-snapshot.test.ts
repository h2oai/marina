// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  reconcileEntities,
  reconcileNumberRecord,
  type SnapshotEntity,
} from "../lib/reconcile-snapshot";

const ent = (id: string, over: Partial<SnapshotEntity> = {}): SnapshotEntity => ({
  id,
  name: id,
  kind: "agent",
  room: "void/center",
  ...over,
});

const agent = (over: Partial<NonNullable<SnapshotEntity["agentStatus"]>> = {}) => ({
  state: "autonomous",
  model: "openrouter/openai/gpt-4o",
  role: "",
  focus: null,
  uptime: 1000,
  toolCalls: 0,
  errors: 0,
  errorReason: null,
  supports: { text: true },
  ...over,
});

describe("reconcileEntities", () => {
  it("returns the same array reference when nothing changed", () => {
    const prev = [ent("a"), ent("b")];
    const next = [ent("a"), ent("b")];
    expect(reconcileEntities(prev, next)).toBe(prev);
  });

  it("ignores uptime churn — same ref even when only uptime advanced", () => {
    const prev = [ent("a", { agentStatus: agent({ uptime: 1000 }) })];
    const next = [ent("a", { agentStatus: agent({ uptime: 3000 }) })];
    expect(reconcileEntities(prev, next)).toBe(prev);
  });

  it("produces a new array but reuses unchanged item refs when one entity changes", () => {
    const a = ent("a");
    const b = ent("b");
    const prev = [a, b];
    const next = [ent("a"), ent("b", { room: "void/north" })];
    const out = reconcileEntities(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(a); // unchanged → reused
    expect(out[1]).not.toBe(b); // changed → new
    expect(out[1]?.room).toBe("void/north");
  });

  it("detects a meaningful agentStatus change (e.g. error state)", () => {
    const prev = [ent("a", { agentStatus: agent({ state: "autonomous", errorReason: null }) })];
    const next = [
      ent("a", { agentStatus: agent({ state: "error", errorReason: "LLM error [x]: 404" }) }),
    ];
    const out = reconcileEntities(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]?.agentStatus?.state).toBe("error");
  });

  it("detects active modal changes for prompt updates", () => {
    const prev = [ent("a", { properties: {} })];
    const next = [ent("a", { properties: { active_modal: "code" } })];
    const out = reconcileEntities(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]?.properties?.active_modal).toBe("code");
  });

  it("detects code profile changes for prompt updates", () => {
    const prev = [ent("a", { properties: { active_modal: "code", code_profile: "marina" } })];
    const next = [ent("a", { properties: { active_modal: "code", code_profile: "codex" } })];
    const out = reconcileEntities(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]?.properties?.code_profile).toBe("codex");
  });

  it("detects code context changes for prompt strip updates", () => {
    const prev = [
      ent("a", {
        properties: {
          active_modal: "code",
          code_context: { sessionId: "code_session_old", pendingPatches: 0 },
        },
      }),
    ];
    const next = [
      ent("a", {
        properties: {
          active_modal: "code",
          code_context: { sessionId: "code_session_new", pendingPatches: 1 },
        },
      }),
    ];
    const out = reconcileEntities(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]?.properties?.code_context).toMatchObject({
      sessionId: "code_session_new",
      pendingPatches: 1,
    });
  });

  it("handles additions and removals", () => {
    const prev = [ent("a")];
    const added = reconcileEntities(prev, [ent("a"), ent("b")]);
    expect(added).toHaveLength(2);
    expect(added).not.toBe(prev);

    const removed = reconcileEntities([ent("a"), ent("b")], [ent("a")]);
    expect(removed).toHaveLength(1);
  });

  it("reuses refs but returns a new array when order changes", () => {
    const a = ent("a");
    const b = ent("b");
    const out = reconcileEntities([a, b], [ent("b"), ent("a")]);
    expect(out).not.toBe(undefined);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });
});

describe("reconcileNumberRecord", () => {
  it("returns prev when equal", () => {
    const prev = { "void/center": 2 };
    expect(reconcileNumberRecord(prev, { "void/center": 2 })).toBe(prev);
  });
  it("returns next when a count changed", () => {
    const prev = { "void/center": 2 };
    const next = { "void/center": 3 };
    expect(reconcileNumberRecord(prev, next)).toBe(next);
  });
  it("returns next when a key was added", () => {
    const prev = { "void/center": 2 };
    const next = { "void/center": 2, "void/north": 1 };
    expect(reconcileNumberRecord(prev, next)).toBe(next);
  });
});
