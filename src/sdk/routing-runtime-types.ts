// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface RuntimeRequest {
  id: string;
  kind: "permission" | "question";
  title: string;
  input: unknown;
  choices?: string[];
}
export interface RuntimeState {
  version: 1;
  role: "supervisor" | "agent" | "attachment";
  status: "starting" | "idle" | "running" | "waiting" | "stopped" | "failed" | "disconnected";
  mode: "managed" | "attached";
  adapter: string;
  supervisorId: string;
  cwd: string;
  nativeSessionId?: string;
  request?: RuntimeRequest;
  error?: string;
  adapters?: { id: string; label: string }[];
  root?: string;
  activeCount?: number;
  updatedAt: number;
}
export type RuntimeControl =
  | {
      action: "launch";
      adapter: string;
      label: string;
      directory?: string;
      workspace?: "worktree" | "shared";
      model?: string;
      prompt?: string;
    }
  | { action: "prompt"; text: string }
  | { action: "interrupt" | "stop" | "resume" | "detach" }
  | { action: "respond"; requestId: string; allow: boolean; answer?: string };
export interface RoutingSyncInput {
  publications?: { sessionId: string; events: import("./routing-types").RoutingEventInput[] }[];
  acknowledgments?: { sessionId: string; messageId: string }[];
  inboxes?: string[];
}
export interface RoutingSyncResult {
  inboxes: { sessionId: string; messages: import("./routing-types").RoutingMessage[] }[];
}
