// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { projectJourneyState } from "../src/engine/journey-state";
import type { JourneyEventKind, JourneyEventRow } from "../src/persistence/database";

function event(id: number, kind: JourneyEventKind, createdAt = id * 100): JourneyEventRow {
  return {
    id,
    journey_id: "journey_test",
    kind,
    summary: `${kind} evidence`,
    actor_id: "e_1",
    actor_name: "Alice",
    ref_kind: null,
    ref: null,
    data_json: "{}",
    created_at: createdAt,
  };
}

describe("journey state projection", () => {
  it("starts expressed without later evidence", () => {
    expect(projectJourneyState({ createdAt: 10, events: [] })).toEqual({
      state: "expressed",
      changedAt: 10,
      reason: "the original desire has been preserved; no later journey evidence exists",
      evidence: ["journey:created"],
    });
  });

  it("projects the newest append-only event", () => {
    const projection = projectJourneyState({
      createdAt: 10,
      events: [event(1, "grounding"), event(2, "action_started"), event(3, "waiting")],
    });
    expect(projection.state).toBe("waiting");
    expect(projection.evidence).toEqual(["journey_event:3"]);
  });

  it("uses event id as the deterministic tie breaker", () => {
    const projection = projectJourneyState({
      createdAt: 10,
      events: [event(1, "waiting", 100), event(2, "result", 100)],
    });
    expect(projection.state).toBe("useful_result");
  });

  it("treats open linked work as ready rather than active", () => {
    const projection = projectJourneyState({
      createdAt: 10,
      events: [],
      work: [{ kind: "task", ref: "42", status: "open", updatedAt: 200 }],
    });
    expect(projection.state).toBe("ready");
    expect(projection.evidence).toEqual(["task:42"]);
  });

  it("lets newer live work supersede an older waiting event", () => {
    const projection = projectJourneyState({
      createdAt: 10,
      events: [event(1, "waiting", 100)],
      work: [{ kind: "task", ref: "42", status: "claimed", updatedAt: 200 }],
    });
    expect(projection.state).toBe("active");
  });

  it("lets a newer explicit dormant event supersede stale claimed work", () => {
    const projection = projectJourneyState({
      createdAt: 10,
      events: [event(1, "dormant", 300)],
      work: [{ kind: "task", ref: "42", status: "claimed", updatedAt: 200 }],
    });
    expect(projection.state).toBe("dormant");
  });
});
