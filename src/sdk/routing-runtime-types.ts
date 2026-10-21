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
  model?: string;
  resumeSupported?: boolean;
  request?: RuntimeRequest;
  error?: string;
  adapters?: { id: string; label: string }[];
  root?: string;
  activeCount?: number;
  /** World account of a supervised resident run (`MARINA_SUPERVISED_RESIDENTS=on`). */
  resident?: string;
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
      /** Supervised residents only: the world name to run as (else one is chosen). */
      name?: string;
      /** Supervised residents only: the room to arrive in (else the launcher's room). */
      room?: string;
    }
  | { action: "prompt"; text: string }
  | { action: "interrupt" | "stop" | "resume" | "detach" }
  | { action: "respond"; requestId: string; allow: boolean; answer?: string }
  /** Supervised residents: the attention policy the run's bridge applies (`agent attention-mode`). */
  | {
      action: "attention";
      mode?: "focused" | "balanced" | "open";
      threshold?: number;
      relay?: "all" | "explicit";
    };
export interface RoutingSyncInput {
  publications?: { sessionId: string; events: import("./routing-types").RoutingEventInput[] }[];
  acknowledgments?: { sessionId: string; messageId: string }[];
  inboxes?: string[];
}
export interface RoutingSyncResult {
  inboxes: { sessionId: string; messages: import("./routing-types").RoutingMessage[] }[];
}

/** `POST /api/routing/residents` input: enrol the agent of one owned run session. */
export interface ResidentEnrolInput {
  /** The run's routing session; its `kind` (the adapter id) is the vendor. */
  sessionId: string;
  /** Requested world name. Omitted: a fresh name that never contains the vendor. */
  name?: string;
  /** Room to arrive in. Omitted: the launching person's current room. */
  room?: string;
}
/** A resident's world credential, returned once and never stored by the server. */
export interface ResidentCredential {
  token: string;
  expiresAt: number;
}
export interface ResidentEnrolment {
  name: string;
  vendor: string;
  /** Room the resident should arrive in, when one is known. */
  room?: string;
  /** True when an existing resident account of the same owner was reused. */
  reused: boolean;
  credential: ResidentCredential;
  /** The resident's stored attention policy (supervised residents' attention bridge). */
  attention?: ResidentAttentionPolicy;
}
/** How a supervised resident's attention bridge decides and relays. */
export interface ResidentAttentionPolicy {
  mode: "focused" | "balanced" | "open";
  threshold: number;
  relay: "all" | "explicit";
}
/** `POST /api/routing/residents/:name/attention`: bridge decisions and presence. */
export interface ResidentAttentionReport {
  sessionId: string;
  /** Wake decisions (refs and reasons only, never content), at most 100. */
  wakes?: {
    ref?: string;
    source: string;
    decision: "now" | "next" | "context" | "drop";
    reason: string;
    hop: number;
    steered: boolean;
    at: number;
  }[];
  /** The resident's current presence, when it changed. */
  status?: { status: RuntimeState["status"]; steer: "mid-turn" | "next-turn" | "none" };
}
