// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * UnifiedCanvas MEMORY layer: subscribes to the live memory map, lays it out
 * around the knowledge-graph notes and projects it to ReactFlow nodes and
 * edges. Extracted from UnifiedCanvas without behaviour change.
 */

import type { Edge, Node } from "@xyflow/react";
import { useMemo } from "react";
import { computeMemoryLayout } from "../lib/memory-map-layout";
import { indexMemoryGraph, neighborsVia } from "../lib/memory-map-reducer";
import { LEGACY_LINK_RELATIONSHIPS, memoryFlowNodeId } from "../lib/memory-map-types";
import { type MemoryMapNodeData, memoryNodeSize } from "../nodes/MemoryMapNode";
import type { ContextType } from "../panels/ContextPanel";
import {
  MEMORY_ADOPT_HANDOFF_MS,
  type UseMemoryMapLiveOptions,
  useMemoryMapLive,
  useMemoryMapState,
} from "./use-memory-map";

export interface UseMemoryLayerOptions {
  hideMemory: boolean;
  hideGraph: boolean;
  /** Inspector target: scopes the live map to a focused entity, emphasises a memory node's edges. */
  contextType: ContextType | null;
  contextId: string | null;
  wsRef: UseMemoryMapLiveOptions["wsRef"];
  connected: boolean;
  /** Knowledge-graph notes (importance sizes the note box). */
  graphNotes: ReadonlyMap<number, { importance?: number }>;
  /** Knowledge-graph note top-left positions. */
  noteLayout: ReadonlyMap<number, { x: number; y: number }>;
  onMemoryNodeClick: MemoryMapNodeData["onClick"];
}

export function useMemoryLayer({
  hideMemory,
  hideGraph,
  contextType,
  contextId,
  wsRef,
  connected,
  graphNotes,
  noteLayout,
  onMemoryNodeClick,
}: UseMemoryLayerOptions) {
  // Scope: the focused entity when the inspector is on one, else the operator
  // view (server decides what to return without an entity filter).
  const memoryScopeEntity = contextType === "entity" && contextId ? contextId : undefined;
  useMemoryMapLive({ enabled: !hideMemory, entityName: memoryScopeEntity, wsRef, connected });
  const memoryGraph = useMemoryMapState((s) => s.graph);
  const memoryPulses = useMemoryMapState((s) => s.pulses);
  const memoryAdoptions = useMemoryMapState((s) => s.adoptions);
  const memoryIndex = useMemo(() => indexMemoryGraph(memoryGraph), [memoryGraph]);

  // GraphNoteNode positions are the top-left of an importance-sized box; the
  // memory layout docks twins against note CENTERS.
  const noteCenters = useMemo(() => {
    const centers = new Map<number, { x: number; y: number }>();
    for (const [id, pos] of noteLayout) {
      const importance = graphNotes.get(id)?.importance ?? 5;
      const half = ((8 + importance * 1.6) * 2 + 6) / 2;
      centers.set(id, { x: pos.x + half, y: pos.y + half });
    }
    return centers;
  }, [noteLayout, graphNotes]);

  const memoryLayout = useMemo(() => {
    if (hideMemory || memoryGraph.nodes.length === 0) return null;
    return computeMemoryLayout(memoryGraph, noteCenters, {
      center: { x: 0, y: 3200 },
      baseRadius: 400,
    });
  }, [memoryGraph, noteCenters, hideMemory]);

  const memoryNodes = useMemo<Node[]>(() => {
    if (!memoryLayout) return [];
    const now = Date.now();
    // record id → job id it was adopted from (graph edges + live adoption events)
    const adoptedRecordToJob = new Map<string, string>();
    for (const e of memoryGraph.edges) {
      if (e.relationship === "adopted_as") adoptedRecordToJob.set(e.target, e.source);
    }
    for (const [jobId, a] of Object.entries(memoryAdoptions)) {
      if (!a.recordId) continue;
      adoptedRecordToJob.set(
        a.recordId.startsWith("record:") ? a.recordId : `record:${a.recordId}`,
        jobId,
      );
    }
    const adoptedJobs = new Set(adoptedRecordToJob.values());

    const result: Node[] = [];
    for (const n of memoryGraph.nodes) {
      if (n.kind === "note") continue; // legacy notes are the GRAPH layer's
      const p = memoryLayout.positions.get(n.id);
      if (!p) continue;
      const hull = n.kind === "space" ? memoryLayout.hullRadius.get(n.id) : undefined;
      const size = memoryNodeSize(n.kind, hull);
      const data: MemoryMapNodeData = {
        node: n,
        pulseAt: memoryPulses[n.id],
        onClick: onMemoryNodeClick,
      };
      if (n.kind === "space") {
        data.hullRadius = hull;
        data.memberCount = neighborsVia(memoryIndex, n.id, "in_space", "in").length;
      } else if (n.kind === "job") {
        const rem = n.meta?.remainingOperations;
        const init = n.meta?.initialOperations;
        data.remainingFraction =
          typeof rem === "number" && typeof init === "number" && init > 0 ? rem / init : null;
        data.handOff = n.meta?.adopted === true || adoptedJobs.has(n.id);
      } else if (n.kind === "record") {
        const fromJob = adoptedRecordToJob.get(n.id);
        const a = fromJob ? memoryAdoptions[fromJob] : undefined;
        if (fromJob && a && now - a.at < MEMORY_ADOPT_HANDOFF_MS) data.adoptedFromJob = fromJob;
      } else if (n.kind === "proposal") {
        data.adopted =
          n.state === "adopted" ||
          n.meta?.adopted === true ||
          adoptedRecordToJob.has(`record:${n.id.slice("proposal:".length)}`);
      }
      const isHull = n.kind === "space";
      result.push({
        id: memoryFlowNodeId(n.id),
        type: "memoryNode",
        position: { x: p.x - size / 2, y: p.y - size / 2 },
        data: data as unknown as Record<string, unknown>,
        draggable: !isHull,
        selectable: !isHull,
        zIndex: isHull ? -1 : undefined,
        className: isHull ? "uc-memory-hull" : undefined,
      });
    }
    return result;
  }, [memoryLayout, memoryGraph, memoryIndex, memoryPulses, memoryAdoptions, onMemoryNodeClick]);

  const memoryEdges = useMemo<Edge[]>(() => {
    if (!memoryLayout) return [];
    const present = new Set(memoryNodes.map((n) => n.id));
    if (!hideGraph) for (const id of noteLayout.keys()) present.add(`note-${id}`);
    const result: Edge[] = [];
    for (const e of memoryGraph.edges) {
      const s = memoryFlowNodeId(e.source);
      const t = memoryFlowNodeId(e.target);
      if (s === t || !present.has(s) || !present.has(t)) continue;
      const emphasized =
        contextType === "memory" && (e.source === contextId || e.target === contextId);
      if (LEGACY_LINK_RELATIONSHIPS.has(e.relationship)) {
        // Keep the GRAPH layer's styles for related_to / part_of / supersedes / contradicts.
        result.push({
          id: `mem-edge-${e.id}`,
          source: s,
          target: t,
          type: "graphLink",
          data: { relationship: e.relationship, activated: emphasized },
        });
      } else {
        result.push({
          id: `mem-edge-${e.id}`,
          source: s,
          target: t,
          type: "memoryEdge",
          data: { relationship: e.relationship, emphasized },
        });
      }
    }
    return result;
  }, [memoryLayout, memoryNodes, memoryGraph, noteLayout, hideGraph, contextType, contextId]);

  return { memoryGraph, memoryNodes, memoryEdges };
}
