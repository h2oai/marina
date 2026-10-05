// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandUsage } from "./command-forms";
import type { DurableMemoryAPI } from "./memory-operations";
import type { EntityId, EntityRank, RoomId } from "./protocol";

export const EXTENSION_API_VERSION = 1;
export interface ExtensionCommandContext {
  readonly caller: Readonly<{ id: EntityId; name: string; rank: number }>;
  readonly room: RoomId;
  /** Canonical records, scoped to the current caller and service ACLs. */
  readonly durableMemory: DurableMemoryAPI;
  reply(text: string): void;
}
export interface ExtensionCommand {
  name: string;
  aliases?: string[];
  help: string;
  usage?: CommandUsage[];
  category?: string;
  minRank: EntityRank;
  gate?: string;
  run(context: ExtensionCommandContext, args: string): void | Promise<void>;
}
export interface ExtensionWidget {
  id: string;
  title: string;
  slot: "sidebar" | "admin-tab";
  source: "readiness" | "world";
}
export interface ExtensionResolver {
  kind: string;
  description: string;
  parseArgs(
    raw: Record<string, string>,
  ): { ok: true; args: unknown } | { ok: false; error: string };
  idFromArgs(args: unknown): string;
  closesOn: ("resolved" | "changed" | "no-change" | "error")[];
  resolve(input: {
    args: unknown;
    previousSample?: unknown;
  }): Promise<
    | { status: "resolved" | "changed"; value: unknown; source: string; rawHash?: string }
    | { status: "no-change"; source: string }
    | { status: "error"; reason: string; retryAfter?: number }
  >;
}
/**
 * What a peer gateway presented when it opened its federation handshake. `proof`
 * is the opaque `entitlement` value of its `gateway_auth` message (undefined when
 * it sent none); the extension that registered the check decides what it means.
 */
export interface GatewayAdmissionRequest {
  readonly proof: unknown;
  /** Gateway protocol version the peer declared, when it declared one. */
  readonly peerVersion: number | null;
}
export type GatewayAdmissionResult =
  | { admit: true; label?: string }
  | { admit: false; reason: string };
/**
 * Extra admission for INBOUND gateway peers, run after (never instead of) the
 * `GATEWAY_SECRET` check. With no check registered the handshake is unchanged.
 */
export type GatewayAdmissionCheck = (
  request: GatewayAdmissionRequest,
) => GatewayAdmissionResult | Promise<GatewayAdmissionResult>;
/**
 * Supplies the opaque `entitlement` value this instance presents when IT dials a
 * peer gateway (`undefined` = present nothing). Must be JSON-serialisable.
 */
export type GatewayProofProvider = (gateway: { name: string; url: string }) => unknown;
/** Trusted operator-installed modules. The API limits coupling, not host-code privileges. */
export interface ExtensionContext {
  readonly apiVersion: 1;
  readonly signal: AbortSignal;
  registerCommand(command: ExtensionCommand): void;
  registerResolver(resolver: ExtensionResolver): void;
  registerWidget(widget: ExtensionWidget): void;
  /** At most one per instance. Optional additive hook: absent ⇒ federation unchanged. */
  registerGatewayAdmission?(check: GatewayAdmissionCheck): void;
  /** At most one per instance. Optional additive hook: absent ⇒ federation unchanged. */
  registerGatewayProof?(provider: GatewayProofProvider): void;
}
export interface MarinaExtension {
  activate(
    context: ExtensionContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
