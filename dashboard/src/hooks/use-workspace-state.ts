// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type { DetailView } from "../components/CoordinationCard";

export type WorkspaceView = "work" | "canvas" | "map" | "observe" | "admin" | "streams";
export type WorkspacePane = "webchat" | "workspace" | "context";
export type CanvasReference =
  | { kind: "task" | "note"; id: string }
  | { kind: "memory"; id: string; spaceId: string }
  | { kind: "artifact"; id: string; sessionId: string };
export interface MemoryDestination {
  query?: string;
  recordId?: string;
  spaceId?: string;
}
export type InspectorSelection =
  | NonNullable<DetailView>
  | { type: "entity"; name: string }
  | { type: "room"; id: string }
  | { type: "node"; id: string }
  | { type: "reference"; reference: CanvasReference };
export interface ChatAttachment {
  canvasId: string;
  nodeId: string;
  title: string;
  mode: "discuss" | "ask";
}
interface WorkspaceState {
  view: WorkspaceView;
  pane: WorkspacePane;
  selection: InspectorSelection | null;
  fullscreen: boolean;
  attachment: ChatAttachment | null;
  pendingPin: CanvasReference | null;
  participantId: string | null;
  canvasOrigin: { view: WorkspaceView; selection: InspectorSelection | null; url: string } | null;
  setView: (view: WorkspaceView) => void;
  inspect: (selection: InspectorSelection | null) => void;
  attach: (attachment: ChatAttachment | null) => void;
}
export const useWorkspaceState = create<WorkspaceState>((set) => ({
  view:
    window.location.pathname.startsWith("/canvas") ||
    new URLSearchParams(window.location.search).get("view") === "canvas"
      ? "canvas"
      : "work",
  pane: "workspace",
  fullscreen: window.location.pathname.startsWith("/canvas"),
  selection: null,
  attachment: null,
  pendingPin: null,
  canvasOrigin: null,
  participantId: new URLSearchParams(window.location.search).get("participant"),
  setView: (view) => set({ view, pane: "workspace" }),
  inspect: (selection) => set({ selection, pane: "context" }),
  attach: (attachment) => set({ attachment, pane: "webchat" }),
}));

export function openParticipant(id: string) {
  const url = new URL(window.location.href);
  url.pathname = "/dashboard";
  url.search = new URLSearchParams({ view: "streams", participant: id }).toString();
  window.history.pushState(null, "", url);
  useWorkspaceState.setState({
    participantId: id,
    view: "streams",
    pane: "workspace",
    fullscreen: false,
  });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function openMemory(query = "", recordId?: string, spaceId?: string) {
  window.dispatchEvent(
    new CustomEvent("marina:open-memory", { detail: { query, recordId, spaceId } }),
  );
}

export function openCanvas(canvasId?: string, nodeId?: string, fullscreen = false) {
  const current = useWorkspaceState.getState();
  if (current.view !== "canvas")
    useWorkspaceState.setState({
      canvasOrigin: {
        view: current.view,
        selection: current.selection,
        url: window.location.href,
      },
    });
  const url = new URL(window.location.href);
  url.pathname = fullscreen ? "/canvas" : "/dashboard";
  url.searchParams.set("view", "canvas");
  url.searchParams.delete("inspect");
  if (canvasId) url.searchParams.set("canvas", canvasId);
  if (nodeId) url.searchParams.set("node", nodeId);
  else if (canvasId) url.searchParams.delete("node");
  window.history.pushState(null, "", url);
  useWorkspaceState.setState({ view: "canvas", pane: "workspace", fullscreen });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function returnFromCanvas() {
  const origin = useWorkspaceState.getState().canvasOrigin;
  if (!origin) return;
  window.history.pushState(null, "", origin.url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  useWorkspaceState.setState({
    view: origin.view,
    selection: origin.selection,
    pane: origin.selection ? "context" : "workspace",
    fullscreen: false,
    canvasOrigin: null,
  });
}

/** Explicit world commands; attaching context never sends anything. */
export function attachedCommand(
  attachment: ChatAttachment,
  message: string,
  agent: string,
): string | null {
  if (attachment.mode === "ask") {
    if (!agent || /\s/.test(agent)) return null;
    return `tell ${agent} Canvas ${attachment.canvasId}, node ${attachment.nodeId}: ${message}`;
  }
  return `canvas post on:${attachment.canvasId} reply:${attachment.nodeId} ${message}`;
}
