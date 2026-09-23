// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CanvasEdgeRow,
  CanvasIntentClaimResult,
  CanvasIntentCompleteResult,
  CanvasIntentFailResult,
  CanvasIntentStatus,
  CanvasIntentSummary,
  CanvasNodeRow,
  CanvasRow,
} from "../db-canvas";
import type { ExactKeys } from "./exact-keys";

/** Canvases, nodes, edges and intents (`db-canvas.ts`). */
export interface CanvasStore {
  createCanvas(canvas: {
    id: string;
    name: string;
    description?: string;
    scope?: string;
    scopeId?: string;
    creatorName: string;
  }): void;
  getCanvas(id: string): CanvasRow | undefined;
  getCanvasByName(name: string): CanvasRow | undefined;
  listCanvases(opts?: { scope?: string; limit?: number }): CanvasRow[];
  /** Look up the per-entity workspace canvas, if one exists. */
  getEntityCanvas(entityId: string): CanvasRow | undefined;
  ensureEntityCanvas(entityId: string, entityName: string, creatorName: string): CanvasRow;
  deleteCanvas(id: string): boolean;
  createNode(node: {
    id: string;
    canvasId: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    assetId?: string;
    data?: Record<string, unknown>;
    creatorName: string;
    parentNodeId?: string;
  }): void;
  getNode(id: string): CanvasNodeRow | undefined;
  getNodesByCanvas(canvasId: string): CanvasNodeRow[];
  trimCanvasNodes(canvasId: string, max: number): number;
  /** Trim old canvas nodes and return their ids so live clients can converge. */
  trimCanvasNodesWithIds(canvasId: string, max: number): string[];
  updateNode(
    id: string,
    updates: { x?: number; y?: number; width?: number; height?: number; data?: string },
  ): boolean;
  listCanvasIntents(options?: {
    statuses?: CanvasIntentStatus[];
    canvasName?: string;
    limit?: number;
    expireActiveMs?: number;
    now?: number;
  }): CanvasIntentSummary[];
  expireCanvasIntentClaims(timeoutMs: number, now?: number): number;
  claimCanvasIntent(
    idOrPrefix: string,
    claimantName: string,
    now?: number,
  ): CanvasIntentClaimResult;
  completeCanvasIntent(
    idOrPrefix: string,
    params: {
      result: string;
      resultType?: string;
      resultData?: Record<string, unknown>;
      completerName: string;
      now?: number;
    },
  ): CanvasIntentCompleteResult;
  failCanvasIntent(idOrPrefix: string, reason: string, now?: number): CanvasIntentFailResult;
  resolveCanvasNode(idOrPrefix: string): CanvasNodeRow | undefined;
  getChildNodes(parentNodeId: string): CanvasNodeRow[];
  getRootNodes(canvasId: string): CanvasNodeRow[];
  deleteNode(id: string): boolean;
  createCanvasEdge(edge: {
    id: string;
    canvasId: string;
    sourceId: string;
    targetId: string;
    relationship: string;
    data?: Record<string, unknown>;
    creatorName: string;
  }): void;
  getCanvasEdges(canvasId: string): CanvasEdgeRow[];
  getCanvasEdge(id: string): CanvasEdgeRow | undefined;
  deleteCanvasEdge(id: string): boolean;
}

/** Runtime mirror of `CanvasStore`'s method names — the drift test compares it to the facade. */
export const CANVAS_STORE_METHODS = [
  "createCanvas",
  "getCanvas",
  "getCanvasByName",
  "listCanvases",
  "getEntityCanvas",
  "ensureEntityCanvas",
  "deleteCanvas",
  "createNode",
  "getNode",
  "getNodesByCanvas",
  "trimCanvasNodes",
  "trimCanvasNodesWithIds",
  "updateNode",
  "listCanvasIntents",
  "expireCanvasIntentClaims",
  "claimCanvasIntent",
  "completeCanvasIntent",
  "failCanvasIntent",
  "resolveCanvasNode",
  "getChildNodes",
  "getRootNodes",
  "deleteNode",
  "createCanvasEdge",
  "getCanvasEdges",
  "getCanvasEdge",
  "deleteCanvasEdge",
] as const satisfies readonly (keyof CanvasStore)[];

export const CANVAS_STORE_COMPLETE: ExactKeys<CanvasStore, typeof CANVAS_STORE_METHODS> = true;
