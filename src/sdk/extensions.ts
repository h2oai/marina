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
/** Trusted operator-installed modules. The API limits coupling, not host-code privileges. */
export interface ExtensionContext {
  readonly apiVersion: 1;
  readonly signal: AbortSignal;
  registerCommand(command: ExtensionCommand): void;
  registerResolver(resolver: ExtensionResolver): void;
  registerWidget(widget: ExtensionWidget): void;
}
export interface MarinaExtension {
  activate(
    context: ExtensionContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
