// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface CanvasData {
  id: string;
  name: string;
  description: string;
  scope: string;
  scope_id: string | null;
  creator_name: string;
  created_at: number;
  updated_at: number;
  nodes: CanvasNodeData[];
  edges?: CanvasEdgeData[];
}

export interface CanvasEdgeData {
  id: string;
  sourceId: string;
  targetId: string;
  relationship: string;
  data: Record<string, unknown> | null;
  creatorName: string;
  createdAt: number;
}

export interface CanvasNodeData {
  id: string;
  canvas_id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  asset_id: string | null;
  data: Record<string, unknown>;
  creator_name: string;
  parent_node_id: string | null;
  created_at: number;
  updated_at: number;
}

export type NodeType =
  | "image"
  | "video"
  | "pdf"
  | "audio"
  | "document"
  | "text"
  | "embed"
  | "frame"
  | "a2ui";
