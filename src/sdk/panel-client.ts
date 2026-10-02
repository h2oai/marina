// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type A2UINodeData, validatePanelDocument } from "./panel-document";
import type { PanelChangeEvent } from "./panel-events";

export interface PublishedPanelNode {
  id: string;
  canvas_id: string;
  type: string;
  creator_name: string;
  updated_at: number;
  data: Record<string, unknown> & { panelRevision?: string };
}
export interface PanelInteractionInput {
  revision: string;
  componentId: string;
  fields?: Record<string, string | boolean>;
  value?: string | boolean;
  requestId?: string;
  sourceId?: string;
  capabilityRevision?: number;
}
/** Small adapter over existing Canvas HTTP resources; no resident connection or new store. */
export class MarinaPanelClient {
  constructor(
    private options: {
      url: string;
      token: string | (() => string | undefined);
      fetch?: typeof fetch;
    },
  ) {}
  async request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const token =
      typeof this.options.token === "function" ? this.options.token() : this.options.token;
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.url), {
      method,
      signal: signal ?? AbortSignal.timeout(35000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `Marina request failed (${response.status})`);
    return value as T;
  }
  canvases(signal?: AbortSignal) {
    return this.request<Array<{ id: string; name: string }>>(
      "/api/canvases?limit=100",
      "GET",
      undefined,
      signal,
    );
  }
  /** Existing dashboard transport, scoped with this client's credential. Reconnect requires a
   * fresh authorized snapshot; missed events are never treated as a complete history. */
  watchChanges(onEvent: (event: PanelChangeEvent) => void, onReconnect: () => void): () => void {
    let closed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = () => {
      if (closed) return;
      const url = new URL("/dashboard-ws", this.options.url);
      url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
      const token =
        typeof this.options.token === "function" ? this.options.token() : this.options.token;
      if (token) url.searchParams.set("token", token);
      const ws = new WebSocket(url);
      socket = ws;
      ws.onmessage = ({ data }) => {
        if (closed || socket !== ws) return;
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === "snapshot") {
            attempts = 0;
            onReconnect();
          }
          if (msg.type === "event" && typeof msg.data?.type === "string") onEvent(msg.data);
        } catch {
          /* Malformed frames cannot change the authorized resource snapshot. */
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (!closed && socket === ws)
          timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }
  async list(canvasId: string, signal?: AbortSignal) {
    const canvas = await this.request<{ nodes: PublishedPanelNode[] }>(
      `/api/canvases/${encodeURIComponent(canvasId)}`,
      "GET",
      undefined,
      signal,
    );
    return canvas.nodes.filter((node) => node.type === "a2ui");
  }
  get(canvasId: string, nodeId: string, signal?: AbortSignal) {
    return this.request<PublishedPanelNode>(this.path(canvasId, nodeId), "GET", undefined, signal);
  }
  publish(canvasId: string, document: A2UINodeData) {
    const parsed = validatePanelDocument(document);
    if (!parsed.ok) throw new Error(parsed.error);
    return this.request<PublishedPanelNode>(
      `/api/canvases/${encodeURIComponent(canvasId)}/nodes`,
      "POST",
      { type: "a2ui", data: parsed.document },
    );
  }
  revise(canvasId: string, nodeId: string, revision: string, document: A2UINodeData) {
    const parsed = validatePanelDocument(document);
    if (!parsed.ok) throw new Error(parsed.error);
    return this.request<PublishedPanelNode>(this.path(canvasId, nodeId), "PATCH", {
      revision,
      data: parsed.document,
    });
  }
  interact(canvasId: string, nodeId: string, input: PanelInteractionInput) {
    return this.request<{
      status: string;
      message?: string;
      receipt?: { id: string; status: string };
    }>(`${this.path(canvasId, nodeId)}/interaction`, "POST", input);
  }
  private path(canvasId: string, nodeId: string) {
    return `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}`;
  }
}
