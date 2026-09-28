// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { EntityId, Perception } from "../types";

export interface McpSession {
  connId: string;
  entityId: EntityId | null;
  /** Real socket peer (never header-derived) — informational. */
  peerIp?: string;
  /** `<listen port>|<peer ip>` — the per-peer login/session throttle bucket. */
  throttleKey: string;
  perceptionBuffer: Perception[];
  commandTail: Promise<unknown>;
  context?: {
    mode: "auto" | "manual" | "off";
    query: string;
    querySource?: "explicit" | "goal";
    scope: "all" | "evidence";
    budgetBytes: number;
  };
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: McpServer;
}

export type McpResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function text(msg: string): McpResult {
  return { content: [{ type: "text" as const, text: msg }] };
}

export function errorText(msg: string): McpResult {
  return { ...text(msg), isError: true };
}
