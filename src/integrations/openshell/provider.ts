// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * NVIDIA OpenShell as a Marina sandbox provider (experimental; off unless an
 * operator points Marina at a gateway THEY run — Marina never installs one).
 *
 * Each entity gets one OpenShell sandbox, named from its id and labelled so a
 * restarted Marina finds it again. Commands, files and service exposure go
 * through the gateway's gRPC API (`grpc.ts`, mutual TLS). OpenShell enforces
 * network policy per program inside the sandbox; when it holds a request it
 * drafts a pending rule, and Marina turns each one into a challenge for a
 * person — approving it approves the rule in OpenShell — so Marina stays the
 * only approver. Nothing here falls back to the host.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type SandboxBinaryResult,
  type SandboxCapabilities,
  type SandboxEvent,
  type SandboxExecutionResult,
  SandboxExecutionTimeoutError,
  type SandboxInventoryItem,
  type SandboxProvider,
  type SandboxState,
  type SandboxWorkspace,
  type SandboxWriteResult,
} from "../../coding/sandbox-provider";
import { raiseForTool } from "../../engine/challenges";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import type { EntityId } from "../../types";
import { GRPC_DEADLINE_EXCEEDED, GRPC_NOT_FOUND, GrpcClient, GrpcError } from "./grpc";
import { ProtoMessage, ProtoWriter } from "./protobuf";

const logger = new Logger();

/** `SandboxPhase` values (openshell.proto). */
const PHASE = {
  provisioning: 1,
  ready: 2,
  error: 3,
  deleting: 4,
  unknown: 5,
  stopping: 6,
  stopped: 7,
  starting: 8,
  completed: 9,
} as const;

const MANAGED_LABEL = "marina.managed";
const ENTITY_LABEL = "marina.entity";
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const READY_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function phaseState(phase: number): SandboxState {
  if (phase === PHASE.ready) return "running";
  if (phase === PHASE.provisioning || phase === PHASE.starting) return "creating";
  if (phase === PHASE.stopped) return "hibernated";
  if (phase === PHASE.stopping || phase === PHASE.deleting) return "stopping";
  return "unavailable";
}

/** The sandbox name for an entity: stable, DNS-safe, and not the raw id. */
export function sandboxName(entityId: string): string {
  // OpenShell names are at most 19 characters: `marina-` plus 12 hex (48 bits).
  return `marina-${createHash("sha256").update(entityId).digest("hex").slice(0, 12)}`;
}

/** A pending OpenShell network rule, as Marina shows it to approvers. */
export interface PendingNetworkRule {
  id: string;
  reviewToken: string;
  ruleName: string;
  binary: string;
  endpoints: string[];
  rationale: string;
}

/** Decode a `PolicyChunk` (openshell.proto) into what an approver needs. */
export function decodePolicyChunk(chunk: ProtoMessage): PendingNetworkRule {
  const rule = chunk.message(4);
  const endpoints = (rule?.messages(2) ?? []).map((e) => {
    const port = e.uint(2);
    return port ? `${e.string(1)}:${port}` : e.string(1);
  });
  const binaries = (rule?.messages(3) ?? []).map((b) => b.string(1));
  return {
    id: chunk.string(1),
    reviewToken: chunk.string(20),
    ruleName: chunk.string(3),
    binary: chunk.string(16) || binaries[0] || "",
    endpoints,
    rationale: chunk.string(5),
  };
}

export interface OpenShellOptions {
  url: string;
  /** PEM contents for mutual TLS (absent only for a loopback `http://` test gateway). */
  tls?: { ca: string; cert: string; key: string };
  workspace?: string;
  image?: string;
  /** Raise a challenge for a held network request (default: Marina's challenges). */
  raise?: typeof raiseForTool;
}

interface Tracked extends SandboxWorkspace {
  entityId: EntityId;
  name: string;
  services: Set<string>;
}

export class OpenShellProvider implements SandboxProvider {
  readonly id = "openshell";
  readonly label = "OpenShell";
  readonly capabilities: SandboxCapabilities = {
    exec: true,
    files: true,
    publish: true,
    hibernate: true,
    networkPolicy: true,
    credentialInjection: false,
    mounts: "none",
  };
  private readonly client: GrpcClient;
  private readonly workspace: string;
  private readonly sandboxes = new Map<EntityId, Tracked>();
  /** Pending rules already raised as challenges (chunk ids). */
  private readonly raised = new Set<string>();
  private readonly raise: typeof raiseForTool;

  constructor(private readonly opts: OpenShellOptions) {
    this.client = new GrpcClient({
      url: opts.url,
      service: "openshell.v1.OpenShell",
      ...(opts.tls ? { tls: opts.tls } : {}),
    });
    this.workspace = opts.workspace ?? "default";
    this.raise = opts.raise ?? raiseForTool;
  }

  /**
   * From `MARINA_OPENSHELL_URL` and the mTLS bundle (`MARINA_OPENSHELL_CA` /
   * `_CERT` / `_KEY`, file paths); undefined when no URL is set. A partial
   * bundle throws, so a misconfiguration is loud.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenShellProvider | undefined {
    const url = env.MARINA_OPENSHELL_URL?.trim();
    if (!url) return undefined;
    const paths = [env.MARINA_OPENSHELL_CA, env.MARINA_OPENSHELL_CERT, env.MARINA_OPENSHELL_KEY]
      .map((p) => p?.trim())
      .filter((p): p is string => !!p);
    if (paths.length !== 3 && !url.startsWith("http://"))
      throw new Error(
        "MARINA_OPENSHELL_URL needs MARINA_OPENSHELL_CA, MARINA_OPENSHELL_CERT and MARINA_OPENSHELL_KEY (the gateway's client mTLS bundle).",
      );
    const [ca, cert, key] = paths.map((p) => readFileSync(p, "utf8"));
    return new OpenShellProvider({
      url,
      ...(ca && cert && key ? { tls: { ca, cert, key } } : {}),
      ...(env.MARINA_OPENSHELL_WORKSPACE?.trim()
        ? { workspace: env.MARINA_OPENSHELL_WORKSPACE.trim() }
        : {}),
      ...(env.MARINA_OPENSHELL_IMAGE?.trim() ? { image: env.MARINA_OPENSHELL_IMAGE.trim() } : {}),
    });
  }

  private scope(): ProtoWriter {
    return new ProtoWriter().string(1, this.workspace);
  }

  private async getSandbox(name: string): Promise<ProtoMessage | undefined> {
    try {
      const reply = await this.client.unary(
        "GetSandbox",
        new ProtoWriter().message(2, this.scope()).string(1, name).bytes(),
      );
      return ProtoMessage.decode(reply).message(1);
    } catch (error) {
      if (error instanceof GrpcError && error.code === GRPC_NOT_FOUND) return undefined;
      throw error;
    }
  }

  private async waitReady(tracked: Tracked): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const sandbox = await this.getSandbox(tracked.name);
      const phase = sandbox?.message(3)?.uint(6) ?? PHASE.unknown;
      tracked.state = phaseState(phase);
      if (sandbox) tracked.sandboxId = sandbox.message(1)?.string(1) || tracked.sandboxId;
      if (phase === PHASE.ready) return;
      if (phase === PHASE.error || !sandbox)
        throw new Error(`OpenShell sandbox ${tracked.name} failed to start.`);
      if (Date.now() > deadline)
        throw new Error(`OpenShell sandbox ${tracked.name} was not ready in time.`);
      await Bun.sleep(500);
    }
  }

  private tracked(entityId: EntityId): Tracked {
    const tracked = this.sandboxes.get(entityId);
    if (!tracked)
      throw new Error("This entity has no OpenShell sandbox; use `code sandbox start`.");
    return tracked;
  }

  async create(entityId: EntityId, image = this.opts.image, keepAlive = true) {
    // A failed earlier attempt (`unavailable`) may be retried; a live sandbox may not be doubled.
    const existing = this.sandboxes.get(entityId);
    if (existing && existing.state !== "unavailable")
      throw new Error(
        "This entity already has an OpenShell sandbox; stop it before creating another.",
      );
    if (!LABEL_VALUE.test(entityId))
      throw new Error("This entity id cannot label an OpenShell sandbox.");
    const name = sandboxName(entityId);
    const tracked: Tracked = {
      entityId,
      name,
      sessionId: name,
      sandboxId: "",
      image: image ?? "openshell-default",
      keepAlive,
      state: "creating",
      services: new Set(),
      lastActivityAt: Date.now(),
    };
    this.sandboxes.set(entityId, tracked);
    try {
      const spec = new ProtoWriter().message(
        6,
        image ? new ProtoWriter().string(1, image) : new ProtoWriter(),
      );
      await this.client.unary(
        "CreateSandbox",
        new ProtoWriter()
          .message(7, this.scope())
          .message(1, spec)
          .string(2, name)
          .stringMap(3, { [MANAGED_LABEL]: "true", [ENTITY_LABEL]: entityId })
          .bytes(),
      );
      await this.waitReady(tracked);
      return publicWorkspace(tracked);
    } catch (error) {
      tracked.state = "unavailable";
      tracked.lastError = getErrorMessage(error);
      throw error;
    }
  }

  async execDetailed(
    entityId: EntityId,
    command: string,
    args: string[] = [],
    cwd?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<SandboxExecutionResult> {
    const ran = await this.run(entityId, [command, ...args], { cwd, timeoutMs: options.timeoutMs });
    return {
      output: new TextDecoder().decode(ran.output),
      events: [{ process: { kind: "exit", exitCode: ran.exitCode } }],
    };
  }

  async exec(entityId: EntityId, command: string, args: string[] = [], cwd?: string) {
    return (await this.execDetailed(entityId, command, args, cwd)).output;
  }

  /** One command over `ExecSandbox`: stdout and stderr in arrival order, and the exit code. */
  private async run(
    entityId: EntityId,
    argv: string[],
    opts: {
      cwd?: string;
      timeoutMs?: number;
      stdin?: Uint8Array;
      stdoutOnly?: boolean;
      maxBytes?: number;
    },
  ): Promise<{ output: Uint8Array; exitCode: number; stderr: string }> {
    const tracked = this.tracked(entityId);
    if (tracked.state !== "running")
      throw new Error(`OpenShell sandbox is ${tracked.state}; the command was not run locally.`);
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let stderr = "";
    let exitCode: number | undefined;
    const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const request = new ProtoWriter()
      .message(12, this.scope())
      .string(1, tracked.name)
      .repeatedString(2, argv)
      .string(3, opts.cwd)
      .message(105, new ProtoWriter().uint(1, Math.ceil(timeoutMs / 1000)))
      .bytesField(6, opts.stdin)
      .uint(10, true);
    try {
      await this.client.stream(
        "ExecSandbox",
        request.bytes(),
        (bytes) => {
          const event = ProtoMessage.decode(bytes);
          const out = event.message(1)?.bytes(1);
          const err = event.message(2)?.bytes(1);
          if (event.has(3)) exitCode = event.message(3)?.int32(1) ?? 0;
          const data = out ?? (opts.stdoutOnly ? undefined : err);
          if (err && opts.stdoutOnly) stderr += new TextDecoder().decode(err);
          if (!data) return;
          size += data.length;
          if (size > max) throw new Error(`Output exceeds ${max} bytes.`);
          chunks.push(data);
        },
        { timeoutMs: timeoutMs + 10_000 },
      );
    } catch (error) {
      if (error instanceof GrpcError && error.code === GRPC_DEADLINE_EXCEEDED)
        throw new SandboxExecutionTimeoutError(timeoutMs, this.label);
      throw error;
    }
    tracked.lastActivityAt = Date.now();
    if (exitCode === undefined)
      throw new Error("OpenShell ended the command without an exit status; outcome unknown.");
    const output = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    return { output, exitCode, stderr };
  }

  async readFile(
    entityId: EntityId,
    guestPath: string,
    options: { maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<SandboxBinaryResult> {
    const ran = await this.run(entityId, ["cat", "--", guestPath], {
      stdoutOnly: true,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (ran.exitCode !== 0) throw new Error(`Could not read ${guestPath}: ${ran.stderr.trim()}`);
    return {
      data: ran.output,
      events: [] as SandboxEvent[],
      byteLength: ran.output.length,
      sha256: createHash("sha256").update(ran.output).digest("hex"),
    };
  }

  async writeFile(
    entityId: EntityId,
    guestPath: string,
    data: Uint8Array,
    options: { maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<SandboxWriteResult> {
    if (data.length > (options.maxBytes ?? DEFAULT_MAX_BYTES))
      throw new Error("File exceeds the transfer limit.");
    const ran = await this.run(entityId, ["sh", "-c", 'cat > "$1"', "marina-write", guestPath], {
      stdin: data,
      stdoutOnly: true,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (ran.exitCode !== 0) throw new Error(`Could not write ${guestPath}: ${ran.stderr.trim()}`);
    return { byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }

  async publishDetailed(entityId: EntityId, port: number) {
    const tracked = this.tracked(entityId);
    const name = `port-${port}`;
    const reply = ProtoMessage.decode(
      await this.client.unary(
        "ExposeService",
        new ProtoWriter()
          .message(5, this.scope())
          .string(1, tracked.name)
          .string(2, name)
          .uint(3, port)
          .bytes(),
      ),
    );
    const url = reply.string(2);
    if (!url) throw new Error("OpenShell returned no service URL.");
    tracked.services.add(name);
    tracked.publishedUrl = url;
    return { url, subdomain: name };
  }

  async publish(entityId: EntityId, port: number) {
    return (await this.publishDetailed(entityId, port)).url;
  }

  async unpublish(entityId: EntityId, subdomain: string) {
    const tracked = this.tracked(entityId);
    await this.client.unary(
      "DeleteService",
      new ProtoWriter()
        .message(3, this.scope())
        .string(1, tracked.name)
        .string(2, subdomain)
        .uint(4, true)
        .bytes(),
    );
    tracked.services.delete(subdomain);
    if (tracked.services.size === 0) delete tracked.publishedUrl;
  }

  async hibernate(entityId: EntityId) {
    const tracked = this.tracked(entityId);
    await this.client.unary(
      "StopSandbox",
      new ProtoWriter().message(2, this.scope()).string(1, tracked.name).bytes(),
      120_000,
    );
    tracked.state = "hibernated";
    tracked.hibernatedReason = "requested";
  }

  async resume(entityId: EntityId) {
    const tracked = this.tracked(entityId);
    await this.client.unary(
      "StartSandbox",
      new ProtoWriter().message(2, this.scope()).string(1, tracked.name).bytes(),
      120_000,
    );
    await this.waitReady(tracked);
    delete tracked.hibernatedReason;
  }

  async stop(entityId: EntityId) {
    const tracked = this.sandboxes.get(entityId);
    if (!tracked) return;
    await this.client.unary(
      "DeleteSandbox",
      new ProtoWriter().message(2, this.scope()).string(1, tracked.name).uint(3, true).bytes(),
      120_000,
    );
    this.sandboxes.delete(entityId);
  }

  status(entityId: EntityId): SandboxWorkspace | undefined {
    const tracked = this.sandboxes.get(entityId);
    return tracked ? publicWorkspace(tracked) : undefined;
  }

  inventory(): SandboxInventoryItem[] {
    return [...this.sandboxes.values()].map((t) => ({
      ...publicWorkspace(t),
      entityId: t.entityId,
      activeServices: t.services.size > 0,
    }));
  }

  /** Find the sandboxes this Marina created (by label), e.g. after a restart. */
  async reconcile(): Promise<void> {
    let pageToken = "";
    do {
      const reply = ProtoMessage.decode(
        await this.client.unary(
          "ListSandboxes",
          new ProtoWriter()
            .message(4, this.scope())
            .uint(1, 100)
            .string(2, pageToken)
            .string(3, `${MANAGED_LABEL}=true`)
            .bytes(),
        ),
      );
      for (const sandbox of reply.messages(1)) {
        const meta = sandbox.message(1);
        const entityId = meta?.stringMap(4)[ENTITY_LABEL] as EntityId | undefined;
        if (!meta || !entityId || this.sandboxes.has(entityId)) continue;
        this.sandboxes.set(entityId, {
          entityId,
          name: meta.string(2),
          sessionId: meta.string(2),
          sandboxId: meta.string(1),
          image: sandbox.message(2)?.message(6)?.string(1) || "openshell-default",
          keepAlive: true,
          state: phaseState(sandbox.message(3)?.uint(6) ?? PHASE.unknown),
          services: new Set(),
        });
      }
      pageToken = reply.string(2);
    } while (pageToken);
  }

  /** The rules OpenShell drafted for requests it held in this entity's sandbox. */
  async pendingNetworkRules(entityId: EntityId): Promise<PendingNetworkRule[]> {
    const tracked = this.tracked(entityId);
    const reply = ProtoMessage.decode(
      await this.client.unary(
        "GetDraftPolicy",
        new ProtoWriter()
          .message(3, this.scope())
          .string(1, tracked.name)
          .string(2, "pending")
          .bytes(),
      ),
    );
    return reply.messages(1).map(decodePolicyChunk);
  }

  async approveNetworkRule(entityId: EntityId, rule: PendingNetworkRule): Promise<void> {
    const tracked = this.tracked(entityId);
    await this.client.unary(
      "ApproveDraftChunk",
      new ProtoWriter()
        .message(3, this.scope())
        .string(1, tracked.name)
        .string(2, rule.id)
        .string(4, rule.reviewToken)
        .bytes(),
    );
  }

  /**
   * Turn each newly pending OpenShell rule into a challenge for a person
   * (the requester's owner or an operator). Approval approves that rule in
   * OpenShell; nothing waits on it. Runs on the maintenance tick.
   */
  async maintenance(): Promise<void> {
    for (const tracked of this.sandboxes.values()) {
      if (tracked.state !== "running") continue;
      let rules: PendingNetworkRule[];
      try {
        rules = await this.pendingNetworkRules(tracked.entityId);
      } catch (error) {
        logger.warn("flywheel", "OpenShell draft policy read failed", {
          sandbox: tracked.name,
          error: getErrorMessage(error),
        });
        continue;
      }
      for (const rule of rules) {
        if (this.raised.has(rule.id)) continue;
        this.raised.add(rule.id);
        const where = rule.endpoints.join(", ") || rule.ruleName;
        this.raise({
          requesterId: tracked.entityId,
          toolName: "egress",
          summary: `allow ${rule.binary || "a program"} → ${where} in OpenShell sandbox ${tracked.name}`,
          reason: `OpenShell held a network request${rule.rationale ? `: ${rule.rationale}` : ""}.`,
          rerun: async () => {
            await this.approveNetworkRule(tracked.entityId, rule);
            return `OpenShell allows ${where} for ${rule.binary || "that program"} now (it applies within seconds); retry the command.`;
          },
        });
      }
    }
  }
}

function publicWorkspace(t: Tracked): SandboxWorkspace {
  return {
    sessionId: t.sessionId,
    sandboxId: t.sandboxId,
    image: t.image,
    keepAlive: t.keepAlive,
    state: t.state,
    ...(t.publishedUrl ? { publishedUrl: t.publishedUrl } : {}),
    ...(t.lastError ? { lastError: t.lastError } : {}),
    ...(t.lastActivityAt ? { lastActivityAt: t.lastActivityAt } : {}),
    ...(t.hibernatedReason ? { hibernatedReason: t.hibernatedReason } : {}),
  };
}
