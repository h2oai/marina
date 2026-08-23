// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import type { TaskManager } from "../src/coordination/task-manager";
import { demoCommand } from "../src/engine/commands/demo";
import type { ReadinessReport } from "../src/engine/readiness";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

function makeEntity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: "",
    inventory: [],
    properties: {},
  };
}

describe("agent.spawn gate sites refuse supervised-only (no self-certification)", () => {
  it("`demo warm` refuses a standing-only spawner and never self-mints competence", async () => {
    const dbPath = `/tmp/marina-demo-warm-${Date.now()}.db`;
    const db = new MarinaDB(dbPath);
    try {
      const acting = makeEntity("u_farmer", "Farmer");
      db.saveEntity(acting);
      // Standing >= agent.spawn.minStanding (40) but NO unsupervised competence —
      // checkGate would return supervisedOnly; checkUnattendedGate refuses.
      const taskId = db.createTask({ title: "t", creatorId: acting.id, creatorName: "Farmer" });
      db.recordStandingEarned(acting.id, "Farmer", taskId, 80);
      expect(db.getCompetence(acting.id, "agent.spawn")).toBeUndefined();

      let spawned = 0;
      const runtime = {
        isAvailable: () => true,
        list: () => [],
        spawn: async () => {
          spawned++;
          return {} as never;
        },
      } as unknown as AgentRuntime;

      const sent: string[] = [];
      const ctx = { send: (_t: EntityId, m: string) => sent.push(m) } as unknown as RoomContext;
      const command = demoCommand({
        db,
        tasks: {} as TaskManager,
        runtime,
        readiness: () => ({}) as ReadinessReport,
        getEntity: (id) => (id === acting.id ? acting : undefined),
      });

      await command.handler(ctx, {
        raw: "demo warm",
        verb: "demo",
        args: "warm",
        tokens: ["warm"],
        entity: acting.id,
        room: roomId("test/start"),
      });

      // Refused as supervised-only; nothing was spawned; no demonstration minted.
      expect(sent.join("\n").toLowerCase()).toContain("supervised-only");
      expect(spawned).toBe(0);
      expect(db.getCompetence(acting.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);
    } finally {
      db.close();
      cleanupDb(dbPath);
    }
  });
});

describe("checkGate call-site audit (structural close of self-certification)", () => {
  const srcRoot = join(import.meta.dir, "..", "src");

  // Detects a `checkGate` reference in ANY consuming form — a DIRECT call
  // `checkGate(`, plus the INDIRECT forms that the old `\bcheckGate\(`-only regex
  // silently missed: `?? checkGate` (dependency-injection fallback default),
  // `= checkGate` (assigned/aliased), and `checkGate?:` (injectable field). A bare
  // `import { checkGate }` is intentionally NOT matched — importing the symbol
  // can't self-certify anything; only a consuming reference can.
  const CHECK_GATE_REF = /\bcheckGate\(|\?\?\s*checkGate\b|=\s*checkGate\b|\bcheckGate\?:/;

  // Files permitted to hold an indirect `checkGate` reference. Each MUST prove
  // (in its own test below) that the gate result is consumed ONLY as a refusal,
  // never as a positive grant. `code.exec.unrestricted` exec approval is the one
  // legitimate injectable-checkGate seam today.
  const ALLOWLIST = new Set(["coding/exec-approver.ts"]);

  const findRefs = (): Array<{ rel: string; line: string }> => {
    const refs: Array<{ rel: string; line: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = full.slice(srcRoot.length + 1);
        if (rel === "engine/safety-gates.ts") continue; // definition + internal use
        const lines = readFileSync(full, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            continue; // skip doc comments
          }
          if (trimmed.includes("checkUnattendedGate")) continue;
          if (CHECK_GATE_REF.test(trimmed)) refs.push({ rel, line: trimmed });
        }
      }
    };
    walk(srcRoot);
    return refs;
  };

  // Walk src/ and find every file with a `checkGate` reference (direct OR
  // indirect, not a comment, not `checkUnattendedGate`). Only safety-gates.ts
  // (the definition) and explicitly-allowlisted seams may hold one. Every
  // unattended dangerous-op enforcement site must use checkUnattendedGate. If a
  // future change reintroduces a self-certifying checkGate — including via the
  // `?? checkGate` / `= checkGate` / `checkGate?:` indirection the re-attack used
  // to slip past the old regex — at a non-allowlisted site, this test fails.
  it("no enforcement site outside safety-gates.ts references checkGate (direct or indirect)", () => {
    const offenders = findRefs()
      .filter((r) => !ALLOWLIST.has(r.rel))
      .map((r) => `${r.rel}: ${r.line}`);
    expect(offenders).toEqual([]);
  });

  // Proves the broadened regex actually catches indirection: exec-approver.ts
  // holds `(this.deps.checkGate ?? checkGate)(` + a `checkGate?:` field, which the
  // old `\bcheckGate\(`-only regex missed entirely. This is the guardrail's
  // fixture — if the regex ever narrows back, this fails.
  it("broadened detection flags exec-approver.ts's indirect checkGate reference", () => {
    const refs = findRefs().filter((r) => r.rel === "coding/exec-approver.ts");
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => /\?\?\s*checkGate\b/.test(r.line))).toBe(true);
  });

  // The one allowlisted indirect user must consume the gate ONLY as a refusal
  // (`!gate.ok || gate.supervisedOnly`), never as a positive self-grant. This is
  // the safety condition that justifies the allowlist entry.
  it("exec-approver.ts consumes its checkGate result only as a refusal", () => {
    const src = readFileSync(join(srcRoot, "coding/exec-approver.ts"), "utf8");
    expect(src).toContain("!gate.ok || gate.supervisedOnly");
    // No positive branch that treats a raw checkGate result as an approval:
    // the only `approved: true` must NOT be gated on `gate.ok &&`.
    expect(/if\s*\(\s*gate\.ok\s*\)\s*return\s*\{\s*approved:\s*true/.test(src)).toBe(false);
  });
});
