import { describe, expect, it } from "vitest";
import { formatEvent } from "../components/ActivityFeed";
import type { DashboardEvent } from "../lib/types";

const resolve = (id: string) => (id === "e_1" ? "Alice" : id === "e_2" ? "Bob" : undefined);

function evt(partial: Partial<DashboardEvent> & { type: string }): DashboardEvent {
  return { timestamp: 0, ...partial } as DashboardEvent;
}

describe("formatEvent — speech content", () => {
  it("strips the verb from a say body", () => {
    const r = formatEvent(
      evt({ type: "say", entity: "e_1", input: "say meet at the lobby", room: "zone/hall" }),
      resolve,
    );
    expect(r.prefix).toBe("Alice");
    expect(r.suffix).toContain("say: meet at the lobby");
  });

  it("shows recipient arrow and body for tell", () => {
    const r = formatEvent(
      evt({ type: "tell", entity: "e_1", input: "tell bob split the task" }),
      resolve,
    );
    expect(r.suffix).toBe(" → bob: split the task");
  });

  it("colors shout and broadcast as warning", () => {
    const shout = formatEvent(evt({ type: "shout", entity: "e_1", input: "shout HEY" }), resolve);
    const bcast = formatEvent(
      evt({ type: "broadcast", entity: "e_1", input: "broadcast news" }),
      resolve,
    );
    expect(shout.color).toBe("text-warning");
    expect(bcast.color).toBe("text-warning");
  });
});

describe("formatEvent — knowledge graph", () => {
  it("renders note_created with importance, type, and content snippet", () => {
    const r = formatEvent(
      evt({
        type: "note_created",
        entity: "e_1",
        authorName: "Alice",
        noteId: 42,
        content: "agents prefer bundled PRs",
        importance: 7,
        noteType: "principle",
      }),
      resolve,
    );
    expect(r.prefix).toBe("Alice");
    expect(r.suffix).toContain("!7");
    expect(r.suffix).toContain("#principle");
    expect(r.suffix).toContain("agents prefer bundled PRs");
  });

  it("renders note_link_created with relationship arrow", () => {
    const r = formatEvent(
      evt({
        type: "note_link_created",
        entity: "e_1",
        sourceId: 10,
        targetId: 20,
        relationship: "supports",
      }),
      resolve,
    );
    expect(r.suffix).toBe(" link 10 —[supports]→ 20");
  });

  it("renders recall_trace with query and activated count", () => {
    const r = formatEvent(
      evt({
        type: "recall_trace",
        entity: "e_1",
        query: "what did we decide about testing?",
        activatedNoteIds: [1, 2, 3],
      }),
      resolve,
    );
    expect(r.prefix).toBe("Alice");
    expect(r.suffix).toContain("(3 notes)");
    expect(r.suffix).toContain("what did we decide about testing?");
  });
});

describe("formatEvent — lifecycle", () => {
  it("renders agent_error with message", () => {
    const r = formatEvent(
      evt({ type: "agent_error", name: "alice", error: "missing key" }),
      resolve,
    );
    expect(r.color).toBe("text-red-400");
    expect(r.suffix).toBe(" error: missing key");
  });

  it("renders rank_change with direction arrow", () => {
    const up = formatEvent(
      evt({
        type: "rank_change",
        name: "alice",
        oldRank: 3,
        newRank: 4,
        direction: "promoted",
      }),
      resolve,
    );
    expect(up.color).toBe("text-warning");
    expect(up.suffix).toBe(" rank 3↑4");

    const down = formatEvent(
      evt({
        type: "rank_change",
        name: "alice",
        oldRank: 4,
        newRank: 3,
        direction: "demoted",
      }),
      resolve,
    );
    expect(down.suffix).toBe(" rank 4↓3");
  });
});

describe("formatEvent — canvas, feed, unknown", () => {
  it("renders canvas_edge_created with relationship", () => {
    const r = formatEvent(
      evt({
        type: "canvas_edge_created",
        entity: "e_1",
        relationship: "supports",
      }),
      resolve,
    );
    expect(r.suffix).toBe(" edge [supports]");
  });

  it("uses feed_event summary", () => {
    const r = formatEvent(
      evt({
        type: "feed_event",
        entity: "e_1",
        kind: "market_consensus",
        summary: "70% yes on H1 delivery",
      }),
      resolve,
    );
    expect(r.suffix).toContain("market_consensus");
    expect(r.suffix).toContain("70% yes on H1 delivery");
  });

  it("clips long content to a snippet", () => {
    const longBody = "x".repeat(200);
    const r = formatEvent(evt({ type: "say", entity: "e_1", input: `say ${longBody}` }), resolve);
    expect(r.suffix.length).toBeLessThan(longBody.length + 10);
    expect(r.suffix).toContain("…");
  });

  it("falls back gracefully for unknown event types", () => {
    const r = formatEvent(evt({ type: "mystery_event", entity: "e_1", input: "payload" }), resolve);
    expect(r.color).toBe("text-text-dim");
    expect(r.suffix).toContain("mystery event");
    expect(r.suffix).toContain("payload");
  });
});

describe("formatEvent — crew lifecycle", () => {
  it("renders crew_created with name + formation + lifetime", () => {
    const r = formatEvent(
      evt({
        type: "crew_created",
        entity: "e_1",
        crew: "crew-abc12345",
        name: "researchers",
        formation: "research",
        lifetime: "persisted",
      }),
      resolve,
    );
    expect(r.prefix).toBe("Alice");
    expect(r.suffix).toContain('formed crew "researchers"');
    expect(r.suffix).toContain("research/persisted");
  });

  it("renders crew_member_joined with role", () => {
    const r = formatEvent(
      evt({
        type: "crew_member_joined",
        crew: "researchers",
        agentName: "Bob",
        role: "specialist",
      }),
      resolve,
    );
    expect(r.prefix).toBe("Bob");
    expect(r.suffix).toContain('joined crew "researchers"');
    expect(r.suffix).toContain("specialist");
  });

  it("renders crew_completed with result note id", () => {
    const r = formatEvent(
      evt({
        type: "crew_completed",
        crew: "researchers",
        resultNoteId: 17,
      }),
      resolve,
    );
    expect(r.color).toBe("text-success");
    expect(r.suffix).toContain('crew "researchers" completed');
    expect(r.suffix).toContain("note #17");
  });

  it("renders crew_dissolved with reason", () => {
    const r = formatEvent(
      evt({
        type: "crew_dissolved",
        crew: "researchers",
        reason: "idle timeout",
      }),
      resolve,
    );
    expect(r.suffix).toContain('crew "researchers" dissolved');
    expect(r.suffix).toContain("idle timeout");
  });

  it("renders crew_stage_completed with agent and stage", () => {
    const r = formatEvent(
      evt({
        type: "crew_stage_completed",
        crew: "researchers",
        agentName: "Bob",
        stage: "extract",
      }),
      resolve,
    );
    expect(r.prefix).toBe("Bob");
    expect(r.suffix).toContain('completed stage "extract"');
  });

  it("renders crew_artifact_deposited with kind and ref", () => {
    const r = formatEvent(
      evt({
        type: "crew_artifact_deposited",
        crew: "researchers",
        agentName: "Carol",
        kind: "map",
        artifactRef: "shard-7.json",
      }),
      resolve,
    );
    expect(r.prefix).toBe("Carol");
    expect(r.suffix).toContain('deposited map "shard-7.json"');
  });

  it("colors stall warning at offenseCount >= 3", () => {
    const first = formatEvent(
      evt({
        type: "crew_member_stalled",
        crew: "researchers",
        agentName: "Dan",
        reason: "no progress",
        offenseCount: 1,
      }),
      resolve,
    );
    expect(first.color).toBe("text-text-dim");

    const penalty = formatEvent(
      evt({
        type: "crew_member_stalled",
        crew: "researchers",
        agentName: "Dan",
        reason: "still nothing",
        offenseCount: 3,
      }),
      resolve,
    );
    expect(penalty.color).toBe("text-warning");
    expect(penalty.suffix).toContain("offense 3");
  });
});
