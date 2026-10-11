// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { assessDeliverable, reviewCrewDeliverable } from "../src/decisions/deliverable";
import type { DecisionProvider } from "../src/decisions/types";
import { crewCommand } from "../src/engine/commands/crew";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

function judge(): DecisionProvider & { calls: number; state?: unknown } {
  return {
    kind: "test",
    model: "test/reviewer",
    calibrated: false,
    calls: 0,
    async ask(request) {
      this.calls++;
      this.state = request.state;
      return {
        provider: "test",
        model: "test/reviewer",
        latencyMs: 1,
        answers: {
          coverage: { type: "choice", choice: "complete" },
          delivered: { type: "choice", choice: "demonstrated" },
          grounded: { type: "choice", choice: "supported" },
        },
      };
    },
  };
}

describe("crew deliverable assessment", () => {
  it("does not judge inaccessible artifact references or turn them into passes", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const privateNote = db.createNote("Bea", "Private findings not accessible to Ada");
      const backend = judge();
      const r = await reviewCrewDeliverable(
        db,
        { name: "Ada", id: "e_ada" },
        {
          subject: "crew:1",
          goal: "Produce findings",
          kind: "draft",
          submission: `note:${privateNote}`,
          referenceOnly: true,
        },
        { env: { MARINA_CREW_DELIVERABLE_REVIEW: "on" }, providers: [backend] },
      );
      expect(backend.calls).toBe(0);
      expect(r?.receipt).toMatchObject({
        status: "unavailable",
        reason: "no_evidence",
        action: "inspect_artifact",
      });
      expect(JSON.stringify(db.listDecisionReceipts("Ada"))).not.toContain("Private findings");
      expect(db.listDecisionReceipts("Bea")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("observes without nudging and never treats an unsupported claim as verified", async () => {
    const input = {
      goal: "Deliver tests",
      submission: "Everything passed",
      kind: "completion",
      evidence: [],
    };
    const r = await assessDeliverable(input, "observe", { providers: [judge()] });
    expect(r.note).toBe("");
    expect(r.receipt.action).toBe("review_evidence");
    expect(r.receipt.applied).toBe(false);
    const unavailable = await assessDeliverable(input, "on", { providers: [] });
    expect(unavailable.note).toBe("");
    expect(unavailable.receipt.status).toBe("unavailable");
  });

  it("does no work when off", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const backend = judge();
      expect(
        await reviewCrewDeliverable(
          db,
          { name: "Ada", id: "e_ada" },
          {
            subject: "crew:1",
            goal: "Write",
            kind: "completion",
            submission: "Done",
          },
          { env: {}, providers: [backend] },
        ),
      ).toBeUndefined();
      expect(backend.calls).toBe(0);
      expect(db.listDecisionReceipts("Ada")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not recreate receipts after an account is erased during review", async () => {
    const db = new MarinaDB(":memory:");
    try {
      db.createUser({ id: "u_review", name: "Ada" });
      const backend = judge();
      const ask = backend.ask.bind(backend);
      backend.ask = async (request, signal) => {
        db.deleteUser("u_review");
        return ask(request, signal);
      };
      const result = await reviewCrewDeliverable(
        db,
        { name: "Ada", id: "e_ada" },
        { subject: "crew:1", goal: "Write", kind: "completion", submission: "Done" },
        { env: { MARINA_CREW_DELIVERABLE_REVIEW: "on" }, providers: [backend] },
      );
      expect(result).toBeUndefined();
      expect(db.listDecisionReceipts("Ada")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("records completion immediately while a tracked review runs in the background", async () => {
    const fixture = createTestEngine();
    const { engine, db } = fixture;
    try {
      const conn = new MockConnection("review-ada");
      engine.addConnection(conn);
      engine.spawnEntity(conn.id, "Ada");
      const background: Promise<void>[] = [];
      let release!: () => void;
      const backend = judge();
      const ask = backend.ask.bind(backend);
      backend.ask = async (request, signal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ask(request, signal);
      };
      engine.commands.registerBuiltin(
        crewCommand({
          crews: engine.crewManager!,
          channels: engine.channelManager!,
          db,
          getEntity: (id) => engine.entities.get(id as EntityId),
          findAgentByName: (name) => engine.entities.findAgentByName(name),
          trackBackground: (work) => {
            background.push(work);
          },
          advisoryOptions: { env: { MARINA_CREW_DELIVERABLE_REVIEW: "on" }, providers: [backend] },
        }),
      );
      await engine.dispatchCommand(conn.entity!, "crew create review Ada -- Report findings");
      await engine.dispatchCommand(conn.entity!, "crew complete review -- Findings are ready");
      expect(conn.allTextJoined()).toContain('Crew "review" completed');
      expect(engine.crewManager!.getByName("review")).toBeUndefined();
      expect(background).toHaveLength(1);
      release();
      await Promise.all(background);
      expect(db.listDecisionReceipts("Ada")).toHaveLength(1);
      expect(conn.allTextJoined()).toContain("Deliverable review");
    } finally {
      await fixture.dispose();
    }
  });
});
