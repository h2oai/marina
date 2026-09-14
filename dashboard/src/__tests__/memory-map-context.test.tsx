// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_ADMIN_EVENT, type OpenAdminDetail } from "../unified/lib/memory-map-admin-link";
import type { MemoryGraph } from "../unified/lib/memory-map-types";
import { MemoryContext } from "../unified/panels/MemoryContext";

const NOW = 1_800_000_000_000;

function fixture(): MemoryGraph {
  return {
    nodes: [
      { id: "note:1", kind: "note", label: "note 1", entityName: "alice" },
      {
        id: "record:10",
        kind: "record",
        label: "Lesson: cite twins",
        tier: "trusted",
        at: NOW - 3_600_000,
        meta: { version: 3 },
      },
      { id: "record:11", kind: "record", label: "old claim", tier: "evidence" },
      { id: "record:12", kind: "record", label: "new claim", tier: "evidence" },
      { id: "helper:reflector-1", kind: "helper", label: "reflector-1", role: "memory-reflector" },
      {
        id: "job:7",
        kind: "job",
        label: "reflector 7",
        state: "answered",
        role: "reflector",
        entityName: "alice",
        at: NOW - 120_000,
        meta: {
          workerName: "reflector-1",
          requesterName: "alice",
          remainingOperations: 4,
          initialOperations: 10,
          deadline: NOW + 600_000,
          marker: "accumulation",
          adopted: true,
        },
      },
      { id: "proposal:10", kind: "proposal", label: "proposal 10", state: "adopted" },
      {
        id: "resolution:1",
        kind: "resolution",
        label: "resolution 1",
        policy: "evidence_weighted",
        at: NOW - 60_000,
        meta: { actorName: "steward" },
      },
      {
        id: "space:guide",
        kind: "space",
        label: "guide",
        institutional: true,
        meta: { records: 2, ratified: 1 },
      },
    ],
    edges: [
      { id: "e1", source: "record:10", target: "note:1", relationship: "twin" },
      { id: "e2", source: "helper:reflector-1", target: "job:7", relationship: "worker" },
      { id: "e3", source: "job:7", target: "record:10", relationship: "adopted_as" },
      { id: "e4", source: "proposal:10", target: "job:7", relationship: "derived_from" },
      { id: "e5", source: "proposal:10", target: "note:1", relationship: "cites" },
      { id: "e6", source: "proposal:10", target: "record:11", relationship: "cites" },
      { id: "e7", source: "resolution:1", target: "record:12", relationship: "resolves" },
      { id: "e8", source: "record:11", target: "resolution:1", relationship: "superseded_by" },
      { id: "e9", source: "record:10", target: "space:guide", relationship: "in_space" },
      { id: "e10", source: "record:12", target: "space:guide", relationship: "in_space" },
    ],
    truncated: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemoryContext", () => {
  it("renders job details: state, role, worker → requester, age, remaining ops, marker, citations, adopted record", () => {
    const onEntityClick = vi.fn();
    const onMemoryNodeClick = vi.fn();
    render(
      <MemoryContext
        graph={fixture()}
        nodeId="job:7"
        now={() => NOW}
        onEntityClick={onEntityClick}
        onMemoryNodeClick={onMemoryNodeClick}
      />,
    );
    expect(screen.getByText("JOB")).toBeInTheDocument();
    expect(screen.getAllByText("answered").length).toBeGreaterThan(0);
    expect(screen.getByText("reflector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reflector-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "alice" })).toBeInTheDocument();
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    expect(screen.getByText(/^4 · in 10m$/)).toBeInTheDocument();
    expect(screen.getByText("A · accumulation")).toBeInTheDocument();
    // Citations gathered through the job's proposal
    expect(screen.getByText("Citations (2)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "old claim" })).toBeInTheDocument();
    // Adopted record link navigates the memory inspector
    fireEvent.click(screen.getByRole("button", { name: "Lesson: cite twins" }));
    expect(onMemoryNodeClick).toHaveBeenCalledWith("record:10");
    fireEvent.click(screen.getByRole("button", { name: "alice" }));
    expect(onEntityClick).toHaveBeenCalledWith("alice");
  });

  it("dispatches marina:open-admin for the Memory tab and degrades gracefully when unhandled", () => {
    render(<MemoryContext graph={fixture()} nodeId="job:7" now={() => NOW} />);
    const seen: OpenAdminDetail[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<OpenAdminDetail>).detail);
    window.addEventListener(OPEN_ADMIN_EVENT, listener);
    try {
      fireEvent.click(screen.getByRole("button", { name: /Open in Admin → Memory/ }));
      expect(seen).toEqual([{ tab: "memory", jobId: "7" }]);
      // Nobody claimed it → inline hint
      expect(screen.getByText(/No admin surface is listening/)).toBeInTheDocument();
    } finally {
      window.removeEventListener(OPEN_ADMIN_EVENT, listener);
    }
  });

  it("hides the hint when an admin surface claims the event via preventDefault", () => {
    render(<MemoryContext graph={fixture()} nodeId="job:7" now={() => NOW} />);
    const listener = (e: Event) => e.preventDefault();
    window.addEventListener(OPEN_ADMIN_EVENT, listener);
    try {
      fireEvent.click(screen.getByRole("button", { name: /Open in Admin → Memory/ }));
      expect(screen.queryByText(/No admin surface is listening/)).toBeNull();
    } finally {
      window.removeEventListener(OPEN_ADMIN_EVENT, listener);
    }
  });

  it("renders resolution details: policy, winner, losers, actor, time", () => {
    render(<MemoryContext graph={fixture()} nodeId="resolution:1" now={() => NOW} />);
    expect(screen.getByText("RESOLUTION")).toBeInTheDocument();
    expect(screen.getAllByText("evidence_weighted").length).toBeGreaterThan(0);
    expect(screen.getByText("steward")).toBeInTheDocument();
    expect(screen.getByText(/1m ago/)).toBeInTheDocument();
    expect(screen.getByText("Winner (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "new claim" })).toBeInTheDocument();
    expect(screen.getByText(/Losers \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "old claim" })).toBeInTheDocument();
  });

  it("renders space details with records / ratified counts", () => {
    render(<MemoryContext graph={fixture()} nodeId="space:guide" now={() => NOW} />);
    expect(screen.getByText("SPACE")).toBeInTheDocument();
    expect(screen.getByText("institutional")).toBeInTheDocument();
    const rows = screen.getAllByText(/^[12]$/);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Members (2)")).toBeInTheDocument();
  });

  it("renders record details with twin note link, version and tier", () => {
    const onNoteClick = vi.fn();
    render(
      <MemoryContext
        graph={fixture()}
        nodeId="record:10"
        now={() => NOW}
        onNoteClick={onNoteClick}
      />,
    );
    expect(screen.getByText("RECORD")).toBeInTheDocument();
    expect(screen.getAllByText("trusted").length).toBeGreaterThan(0);
    expect(screen.getByText("v3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "#1" }));
    expect(onNoteClick).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "guide" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reflector 7" })).toBeInTheDocument();
  });

  it("explains missing graph / unknown node", () => {
    render(<MemoryContext graph={null} nodeId="job:1" />);
    expect(screen.getByText(/Memory graph not loaded yet/)).toBeInTheDocument();
    render(<MemoryContext graph={{ ...fixture(), truncated: true }} nodeId="job:404" />);
    expect(screen.getByText(/job:404 is not in the current memory graph/)).toBeInTheDocument();
    expect(screen.getByText(/truncated/)).toBeInTheDocument();
  });
});
