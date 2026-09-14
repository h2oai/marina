// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { memoryGraphUrl, useMemoryMapState } from "../unified/hooks/use-memory-map";
import {
  applyMemoryJobEvent,
  looksLikeMemoryFrame,
  parseMemoryLiveMessage,
} from "../unified/lib/memory-map-reducer";
import {
  jobMarkerBadge,
  type MemoryGraph,
  type MemoryJobEvent,
  memoryFlowNodeId,
  parseMemoryNodeId,
  tierColor,
  UNIFIED_TIER_COLORS,
} from "../unified/lib/memory-map-types";

function fixture(): MemoryGraph {
  return {
    nodes: [
      { id: "note:1", kind: "note", label: "note 1", entityName: "alice" },
      { id: "record:10", kind: "record", label: "record 10", tier: "evidence" },
      { id: "helper:reflector-1", kind: "helper", label: "reflector-1", role: "memory-reflector" },
      { id: "helper:alice", kind: "helper", label: "alice", role: "requester" },
      {
        id: "job:7",
        kind: "job",
        label: "reflector 7",
        state: "pending",
        role: "reflector",
        entityName: "alice",
        meta: { remainingOperations: 10, initialOperations: 10 },
      },
    ],
    edges: [{ id: "e1", source: "record:10", target: "note:1", relationship: "twin" }],
    truncated: false,
  };
}

function jobEvent(
  partial: Partial<MemoryJobEvent["job"]> & { id: string },
  ts = 1000,
): MemoryJobEvent {
  return { type: "memory_job", job: { state: "running", ...partial }, timestamp: ts };
}

describe("memory-map types helpers", () => {
  it("parses prefixed node ids and maps notes onto the GRAPH layer's flow ids", () => {
    expect(parseMemoryNodeId("job:12")).toEqual({ kind: "job", ref: "12" });
    expect(parseMemoryNodeId("helper:mem-reflector")).toEqual({
      kind: "helper",
      ref: "mem-reflector",
    });
    expect(parseMemoryNodeId("bogus:1")).toBeNull();
    expect(parseMemoryNodeId("noprefix")).toBeNull();
    expect(memoryFlowNodeId("note:42")).toBe("note-42");
    expect(memoryFlowNodeId("record:42")).toBe("mem-record:42");
  });

  it("normalises marker strings to H/A/S badges", () => {
    expect(jobMarkerBadge("hygiene")).toBe("H");
    expect(jobMarkerBadge("[accumulation]")).toBe("A");
    expect(jobMarkerBadge("shared_write_review")).toBe("S");
    expect(jobMarkerBadge("other")).toBeNull();
    expect(jobMarkerBadge(undefined)).toBeNull();
  });

  it("maps legacy note tiers onto the unified palette", () => {
    expect(tierColor("skill")).toBe(UNIFIED_TIER_COLORS.skill);
    expect(tierColor("fact")).toBe(UNIFIED_TIER_COLORS.evidence);
    expect(tierColor("core")).toBe(UNIFIED_TIER_COLORS.trusted);
    expect(tierColor(undefined)).toBe(UNIFIED_TIER_COLORS.unverified);
  });

  it("builds the graph URL with an optional entity scope", () => {
    expect(memoryGraphUrl(undefined)).toBe("/api/memory/graph?limit=400");
    expect(memoryGraphUrl("alice b")).toBe("/api/memory/graph?entity=alice+b&limit=400");
  });
});

describe("parseMemoryLiveMessage", () => {
  it("pre-filters frames cheaply", () => {
    expect(looksLikeMemoryFrame('{"type":"memory_job"}')).toBe(true);
    expect(looksLikeMemoryFrame('{"type":"agent_text_delta"}')).toBe(false);
    expect(looksLikeMemoryFrame(new ArrayBuffer(1))).toBe(false);
  });

  it("accepts the top-level contract shape", () => {
    const live = parseMemoryLiveMessage({
      type: "memory_job",
      job: { id: "7", state: "running" },
      timestamp: 5,
    });
    expect(live?.type).toBe("memory_job");
    expect(live && live.type === "memory_job" ? live.job.id : null).toBe("7");
  });

  it("accepts the dashboard {type:'event', data} envelope", () => {
    const live = parseMemoryLiveMessage({
      type: "event",
      data: {
        type: "memory_service_event",
        kind: "assistance.adopted",
        spaceId: "s1",
        referenceId: "r1",
        timestamp: 9,
      },
    });
    expect(live).toMatchObject({
      type: "memory_service_event",
      kind: "assistance.adopted",
      spaceId: "s1",
      referenceId: "r1",
      timestamp: 9,
    });
  });

  it("ignores unrelated payloads", () => {
    expect(parseMemoryLiveMessage({ type: "event", data: { type: "note_created" } })).toBeNull();
    expect(parseMemoryLiveMessage("nope")).toBeNull();
    expect(parseMemoryLiveMessage({ type: "memory_job", job: {} })).toBeNull();
  });
});

describe("applyMemoryJobEvent", () => {
  it("updates an existing job's state in place and flags the transition", () => {
    const g = fixture();
    const res = applyMemoryJobEvent(
      g,
      jobEvent({ id: "7", state: "running", remainingOperations: 6 }),
    );
    expect(res.nodeId).toBe("job:7");
    expect(res.transitioned).toBe(true);
    const job = res.graph.nodes.find((n) => n.id === "job:7")!;
    expect(job.state).toBe("running");
    expect(job.meta?.remainingOperations).toBe(6);
    // denominator for the arc is preserved from the first sighting
    expect(job.meta?.initialOperations).toBe(10);
    // input graph untouched
    expect(g.nodes.find((n) => n.id === "job:7")!.state).toBe("pending");
  });

  it("does not flag a transition when the state is unchanged", () => {
    const g = fixture();
    const res = applyMemoryJobEvent(
      g,
      jobEvent({ id: "7", state: "pending", remainingOperations: 9 }),
    );
    expect(res.transitioned).toBe(false);
  });

  it("inserts unknown jobs and synthesises worker/requester edges to known helpers", () => {
    const g = fixture();
    const res = applyMemoryJobEvent(
      g,
      jobEvent({
        id: "8",
        state: "pending",
        role: "evaluator",
        workerName: "reflector-1",
        requesterName: "alice",
        remainingOperations: 20,
        marker: "hygiene",
      }),
    );
    const job = res.graph.nodes.find((n) => n.id === "job:8")!;
    expect(job.kind).toBe("job");
    expect(job.role).toBe("evaluator");
    expect(job.meta?.initialOperations).toBe(20);
    expect(job.meta?.marker).toBe("hygiene");
    expect(res.graph.edges).toContainEqual(
      expect.objectContaining({
        relationship: "worker",
        source: "helper:reflector-1",
        target: "job:8",
      }),
    );
    expect(res.graph.edges).toContainEqual(
      expect.objectContaining({
        relationship: "requester",
        source: "job:8",
        target: "helper:alice",
      }),
    );
    // Unknown helper → no dangling edge
    const res2 = applyMemoryJobEvent(res.graph, jobEvent({ id: "9", workerName: "ghost" }));
    expect(res2.graph.edges.some((e) => e.source === "helper:ghost")).toBe(false);
  });

  it("reports adoption once and links the adopted record when known", () => {
    const g = fixture();
    const first = applyMemoryJobEvent(
      g,
      jobEvent({ id: "7", state: "answered", adopted: true, adoptedRecordId: "10" }, 2000),
    );
    expect(first.adopted).toEqual({ jobId: "job:7", recordId: "10" });
    expect(first.graph.edges).toContainEqual(
      expect.objectContaining({ relationship: "adopted_as", source: "job:7", target: "record:10" }),
    );
    const second = applyMemoryJobEvent(
      first.graph,
      jobEvent({ id: "7", state: "answered", adopted: true, adoptedRecordId: "10" }, 3000),
    );
    expect(second.adopted).toBeUndefined();
    expect(second.graph.edges.filter((e) => e.relationship === "adopted_as")).toHaveLength(1);
  });
});

describe("useMemoryMapState store", () => {
  beforeEach(() => {
    useMemoryMapState.getState().reset();
  });

  it("applies a memory_job event to state, recording a pulse and an adoption", () => {
    useMemoryMapState.getState().setGraph(fixture(), "alice");
    useMemoryMapState.getState().applyJob(jobEvent({ id: "7", state: "running" }, 1234));
    let s = useMemoryMapState.getState();
    expect(s.graph.nodes.find((n) => n.id === "job:7")!.state).toBe("running");
    expect(s.pulses["job:7"]).toBe(1234);
    expect(Object.keys(s.adoptions)).toHaveLength(0);

    useMemoryMapState
      .getState()
      .applyJob(
        jobEvent({ id: "7", state: "answered", adopted: true, adoptedRecordId: "10" }, 2000),
      );
    s = useMemoryMapState.getState();
    expect(s.pulses["job:7"]).toBe(2000);
    expect(s.adoptions["job:7"]).toEqual({ recordId: "10", at: 2000 });
    expect(s.scopeEntity).toBe("alice");
  });
});
