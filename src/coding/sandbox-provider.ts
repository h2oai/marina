// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The seam every isolated-execution provider plugs into (Flywheel today;
 * OpenShell, containers and others as adapters). Marina keeps identity,
 * policy, approvals and audit; a provider only runs what it is handed.
 * Selection is always explicit — a session's target is `local` or a provider
 * id — and a selected provider never falls back to the host.
 */
import type { MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

/** Lifecycle state of an entity's sandbox. */
export type SandboxState = "creating" | "running" | "hibernated" | "unavailable" | "stopping";

export interface SandboxWorkspace {
  sessionId: string;
  sandboxId: string;
  image: string;
  keepAlive: boolean;
  state: SandboxState;
  publishedUrl?: string;
  lastError?: string;
  lastActivityAt?: number;
  lifecycleExpiresAt?: number;
  hibernatedReason?: string;
}

export interface SandboxInventoryItem extends SandboxWorkspace {
  entityId: EntityId;
  activeServices: boolean;
}

export interface SandboxReclaimCandidate {
  entityId: EntityId;
  sandboxId: string;
  reason: string;
  action: "hibernate" | "review";
}

/** A provider's structured event (kept as evidence; shape is the provider's). */
export interface SandboxEvent {
  [key: string]: unknown;
}

export interface SandboxExecutionResult {
  output: string;
  events: SandboxEvent[];
}

export interface SandboxBinaryResult {
  data: Uint8Array;
  events: SandboxEvent[];
  byteLength: number;
  sha256: string;
}

export interface SandboxWriteResult {
  byteLength: number;
  sha256: string;
}

export class SandboxExecutionTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    providerLabel = "Sandbox",
  ) {
    super(`${providerLabel} command exceeded ${timeoutMs}ms; remote cancellation was requested.`);
    this.name = "SandboxExecutionTimeoutError";
  }
}

/** What a provider can do; Marina never claims more than this. */
export interface SandboxCapabilities {
  /** Runs commands (every provider). */
  exec: true;
  /** Reads and writes guest files. */
  files: boolean;
  /** Exposes a guest port as a URL. */
  publish: boolean;
  /** Hibernates and resumes a sandbox. */
  hibernate: boolean;
  /** Enforces a per-destination network policy that Marina can set. */
  networkPolicy: boolean;
  /** Injects credentials at approved endpoints without exposing them to the guest. */
  credentialInjection: boolean;
  /** How the workspace reaches the guest: a host mount, a provider volume, or neither. */
  mounts: "host" | "volume" | "none";
}

export interface SandboxProvider {
  /** Stable id stored as a session's execution target (`local` is reserved). */
  readonly id: string;
  /** Name shown to people ("Flywheel"). */
  readonly label: string;
  readonly capabilities: SandboxCapabilities;
  create(entityId: EntityId, image?: string, keepAlive?: boolean): Promise<SandboxWorkspace>;
  exec(entityId: EntityId, command: string, args?: string[], cwd?: string): Promise<string>;
  execDetailed?(
    entityId: EntityId,
    command: string,
    args?: string[],
    cwd?: string,
    options?: { timeoutMs?: number },
  ): Promise<SandboxExecutionResult>;
  readFile?(
    entityId: EntityId,
    guestPath: string,
    options?: { maxBytes?: number; timeoutMs?: number },
  ): Promise<SandboxBinaryResult>;
  writeFile?(
    entityId: EntityId,
    guestPath: string,
    data: Uint8Array,
    options?: { maxBytes?: number; timeoutMs?: number },
  ): Promise<SandboxWriteResult>;
  publish(entityId: EntityId, port: number): Promise<string>;
  publishDetailed?(entityId: EntityId, port: number): Promise<{ url: string; subdomain: string }>;
  unpublish?(entityId: EntityId, subdomain: string): Promise<void>;
  hibernate(entityId: EntityId): Promise<void>;
  resume(entityId: EntityId): Promise<void>;
  stop(entityId: EntityId): Promise<void>;
  status(entityId: EntityId): SandboxWorkspace | undefined;
  reconcile?(): Promise<void>;
  maintenance?(): Promise<void>;
  inventory?(): SandboxInventoryItem[];
  reclaim?(apply?: boolean): Promise<SandboxReclaimCandidate[]>;
  operationSummary?(): ReturnType<MarinaDB["getFlywheelOperationSummary"]>;
}

/** A session's execution target: the host (`local`) or a registered provider id. */
export type SandboxTarget = string;
export const LOCAL_TARGET = "local";

/** The configured providers, in registration order. */
export class SandboxProviders {
  private readonly byId = new Map<string, SandboxProvider>();

  constructor(providers: readonly (SandboxProvider | undefined)[] = []) {
    for (const provider of providers) if (provider) this.register(provider);
  }

  register(provider: SandboxProvider): void {
    if (provider.id === LOCAL_TARGET || !/^[a-z][a-z0-9-]*$/.test(provider.id))
      throw new Error(`Invalid sandbox provider id "${provider.id}"`);
    if (this.byId.has(provider.id))
      throw new Error(`Sandbox provider "${provider.id}" is already registered`);
    this.byId.set(provider.id, provider);
  }

  get(id: string): SandboxProvider | undefined {
    return this.byId.get(id);
  }

  list(): SandboxProvider[] {
    return [...this.byId.values()];
  }

  /** The one provider when exactly one is configured (else the caller must name one). */
  only(): SandboxProvider | undefined {
    return this.byId.size === 1 ? this.list()[0] : undefined;
  }

  get size(): number {
    return this.byId.size;
  }
}

/** A target's display name: the provider's label, or the id when it is not configured. */
export function sandboxTargetLabel(
  providers: SandboxProviders | undefined,
  target: string,
): string {
  return target === LOCAL_TARGET ? "local" : (providers?.get(target)?.label ?? target);
}

/** One-line capability summary for listings and readiness. */
export function describeCapabilities(c: SandboxCapabilities): string {
  const yes = (on: boolean, name: string) => (on ? name : `no ${name}`);
  return [
    "exec",
    yes(c.files, "files"),
    yes(c.publish, "publish"),
    yes(c.hibernate, "hibernate"),
    yes(c.networkPolicy, "network policy"),
    yes(c.credentialInjection, "credential injection"),
    `mounts: ${c.mounts}`,
  ].join(", ");
}
