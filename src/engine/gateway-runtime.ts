// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "../net/ansi";
import type { MarinaDB } from "../persistence/database";
import { MarinaClient, type Perception } from "../sdk/client";
import { getErrorMessage } from "./errors";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GatewayStatus {
  name: string;
  url: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  bridgedChannels: string[];
  messagesRelayed: number;
  connectedAt: number | null;
  error?: string;
}

interface GatewayConnection {
  name: string;
  url: string;
  client: MarinaClient;
  entityName: string;
  bridgedChannels: Set<string>;
  status: "connecting" | "connected" | "disconnected" | "error";
  messagesRelayed: number;
  connectedAt: number | null;
  lastRelayAt: Map<string, number>;
  perceptionHandler?: (p: Perception) => void;
  error?: string;
}

/** Extract channel payload from structured perception data, falling back to regex on text. */
function extractChannelPayload(
  p: Perception,
): { channel: string; sender: string; content: string } | undefined {
  const d = p.data;
  // Prefer structured fields emitted by ChannelManager
  if (
    typeof d.channel === "string" &&
    typeof d.senderName === "string" &&
    typeof d.content === "string"
  ) {
    return { channel: d.channel, sender: d.senderName, content: d.content };
  }
  // Legacy fallback: parse formatted text via regex
  if (typeof d.text !== "string") return undefined;
  const clean = stripAnsi(d.text);
  const match = clean.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.*)/s);
  if (!match) return undefined;
  return { channel: match[1]!, sender: match[2]!.trim(), content: match[3]!.trim() };
}

/**
 * Recover the structured relay envelope carried out-of-band in perception data
 * (`relayOrigin` / `relayHops` / `relayTarget`). New peers ship origin/hops here
 * rather than inline in the message body, so the delivered/persisted channel
 * content stays clean while cross-peer loop detection still has a real,
 * non-content-derived hop count. Returns `undefined` when no structured relay
 * fields are present (older peer — fall back to parsing the body envelope).
 */
function extractRelayMeta(p: Perception): RelayEnvelope | undefined {
  const d = p.data;
  const hasHops = typeof d.relayHops === "number";
  const hasOrigin = typeof d.relayOrigin === "string";
  const hasTarget = typeof d.relayTarget === "string";
  if (!hasHops && !hasOrigin && !hasTarget) return undefined;
  return {
    hops: hasHops ? Math.max(0, d.relayHops as number) : 0,
    origin: hasOrigin ? (d.relayOrigin as string) : undefined,
    target: hasTarget ? (d.relayTarget as string) : undefined,
  };
}

/** Extract tell payload from structured perception data, falling back to regex on text. */
function extractTellPayload(p: Perception): { sender: string; message: string } | undefined {
  const d = p.data;
  // Prefer structured fields emitted by the tell command
  if (typeof d.senderName === "string" && typeof d.message === "string") {
    return { sender: d.senderName, message: d.message };
  }
  // Legacy fallback: parse formatted text via regex
  if (typeof d.text !== "string") return undefined;
  const clean = stripAnsi(d.text);
  const match = clean.match(/^>\s+(.+?)\s+tells you:\s+(.*)/s);
  if (!match) return undefined;
  return { sender: match[1]!.trim(), message: match[2]!.trim() };
}

// ─── Gateway Runtime ─────────────────────────────────────────────────────────

/** Protocol version for gateway relay framing. Increment when message format changes. */
export const GATEWAY_PROTOCOL_VERSION = 1;

const RELAY_MIN_MS = 1000;

/**
 * Maximum number of relay hops before a message is dropped. Caps
 * multi-gateway chains (A → B → C → A) where no individual hop looks
 * like a loop but the net effect is one.
 *
 * The authoritative hop count now lives in a STRUCTURED relay envelope
 * (`[relay origin=<id> hops=<n>] <body>`) that each relaying instance
 * rewrites — a real integer that is not derived from user-controlled
 * content. The legacy `[from ` substring count is retained only as a
 * fallback for messages from older peers that predate the envelope.
 */
const MAX_RELAY_HOPS = 3;

/**
 * Structured relay framing carried across gateway hops.
 *
 * `origin` is the instance name (`localWorldName`) of the FIRST instance to
 * federate a message into the mesh. Loop detection compares it against the
 * local instance name — if a message we introduced comes back to us, we drop
 * it. This is spoof-resistant in the sense that injecting "[from " into user
 * content cannot change `hops` or `origin` (those live in the framing, not the
 * body); a malicious peer can forge the envelope, but that only lets it drop
 * its own traffic or target a named origin, not defeat loop detection for
 * honest peers.
 *
 * `hops` is a real integer incremented by each relaying instance.
 * `target` (tells only) names the intended final local recipient.
 */
export interface RelayEnvelope {
  origin?: string;
  hops: number;
  target?: string;
}

const RELAY_PREFIX_RE = /^\[relay ([^\]]*)\]\s?/;

/** Sanitize a field value so it can't break the space/bracket-delimited framing. */
function sanitizeField(v: string): string {
  return v.replace(/[[\]\s]/g, "_");
}

/**
 * Parse the structured relay envelope from content. Prefers the structured
 * `[relay ...]` prefix; falls back to counting the legacy `[from ` trail
 * (content-derived, spoofable) only when no structured envelope is present.
 */
export function parseRelayEnvelope(content: string): { meta: RelayEnvelope; body: string } {
  const m = content.match(RELAY_PREFIX_RE);
  if (m) {
    const meta: RelayEnvelope = { hops: 0 };
    for (const tok of m[1]!.trim().split(/\s+/)) {
      const eq = tok.indexOf("=");
      if (eq < 0) continue;
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      if (k === "origin") meta.origin = v;
      else if (k === "hops") meta.hops = Math.max(0, Number.parseInt(v, 10) || 0);
      else if (k === "target") meta.target = v;
    }
    return { meta, body: content.slice(m[0].length) };
  }
  return { meta: { hops: countRelayHops(content) }, body: content };
}

/** Serialize a relay envelope as a readable, machine-parseable prefix. */
export function buildRelayEnvelope(meta: RelayEnvelope, body: string): string {
  const parts: string[] = [];
  if (meta.origin) parts.push(`origin=${sanitizeField(meta.origin)}`);
  parts.push(`hops=${meta.hops}`);
  if (meta.target) parts.push(`target=${sanitizeField(meta.target)}`);
  return `[relay ${parts.join(" ")}] ${body}`;
}

/**
 * Recover an intended local recipient from a relayed tell body via a leading
 * `@name` or `to:name` routing token. When present, the relay delivers only to
 * that local entity instead of dropping (see localTellRelay). Returns the
 * cleaned body with the routing token stripped.
 */
export function extractRoutingTarget(message: string): { target?: string; body: string } {
  const m = message.match(/^\s*(?:@|to:)([A-Za-z0-9_-]{1,40})\s+([\s\S]*)$/);
  if (m) return { target: m[1], body: m[2]! };
  return { body: message };
}

/** Legacy fallback: count "[from " occurrences as a hop-count proxy. */
function countRelayHops(content: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf("[from ", idx)) !== -1) {
    count++;
    idx += 6;
  }
  return count;
}

export class GatewayRuntime {
  private connections = new Map<string, GatewayConnection>();
  private db?: MarinaDB;
  private localRelay: (channel: string, body: string, meta: RelayEnvelope) => void;
  private localTellRelay: (
    target: string | undefined,
    senderLabel: string,
    message: string,
    originEntity: string,
  ) => void;
  private localWorldName: string;

  constructor(opts: {
    db?: MarinaDB;
    localRelay: (channel: string, body: string, meta: RelayEnvelope) => void;
    localTellRelay: (
      target: string | undefined,
      senderLabel: string,
      message: string,
      originEntity: string,
    ) => void;
    localWorldName: string;
  }) {
    this.db = opts.db;
    this.localRelay = opts.localRelay;
    this.localTellRelay = opts.localTellRelay;
    this.localWorldName = opts.localWorldName;
  }

  /** Connect to a remote Marina instance. */
  async addGateway(name: string, url: string): Promise<void> {
    if (this.connections.has(name)) {
      throw new Error(`Gateway "${name}" is already connected.`);
    }

    const wsUrl = url.replace(/\/$/, "");
    const entityName = `Gateway_${this.localWorldName}`;
    const secret = process.env.GATEWAY_SECRET;
    const client = new MarinaClient(wsUrl, {
      autoReconnect: true,
      reconnectDelay: 5000,
      onOpen: secret
        ? (ws) => {
            ws.send(
              JSON.stringify({
                type: "gateway_auth",
                secret,
                version: GATEWAY_PROTOCOL_VERSION,
              }),
            );
          }
        : undefined,
    });

    const conn: GatewayConnection = {
      name,
      url: wsUrl,
      client,
      entityName,
      bridgedChannels: new Set(),
      status: "connecting",
      messagesRelayed: 0,
      connectedAt: null,
      lastRelayAt: new Map(),
    };
    this.connections.set(name, conn);

    try {
      // Connect with timeout to prevent hanging on unreachable hosts
      const connectPromise = client.connect(entityName);
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Connection timed out (15s)")), 15_000);
      });
      await Promise.race([connectPromise, timeoutPromise]);
      clearTimeout(timeoutId!);
      conn.status = "connected";
      conn.connectedAt = Date.now();
      console.log(`[gateway] "${name}" connected (protocol v${GATEWAY_PROTOCOL_VERSION})`);

      // Register relay listener (store reference for cleanup)
      const handler = (p: Perception) => this.handleRemotePerception(conn, p);
      conn.perceptionHandler = handler;
      client.onPerception(handler);
    } catch (err) {
      conn.status = "error";
      conn.error = getErrorMessage(err);
      // Clean up failed connection
      try {
        client.disconnect();
      } catch {
        // Expected
      }
      this.connections.delete(name);
      throw new Error(`Failed to connect gateway "${name}": ${conn.error}`);
    }
  }

  /** Disconnect and remove a gateway. */
  async removeGateway(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    // Remove perception handler before disconnecting to prevent reconnect loops
    if (conn.perceptionHandler) {
      conn.client.offPerception(conn.perceptionHandler);
    }
    try {
      conn.client.disconnect();
    } catch {
      // Expected: may already be disconnected
    }
    this.connections.delete(name);
  }

  /** Bridge a channel — join it on the remote side. */
  async bridgeChannel(name: string, channel: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Gateway "${name}" not found.`);
    if (conn.status !== "connected") throw new Error(`Gateway "${name}" is not connected.`);

    await conn.client.command(`channel join ${channel}`);
    conn.bridgedChannels.add(channel);
  }

  /** Stop bridging a channel. */
  async unbridgeChannel(name: string, channel: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Gateway "${name}" not found.`);

    if (conn.status === "connected") {
      await conn.client.command(`channel leave ${channel}`);
    }
    conn.bridgedChannels.delete(channel);
  }

  /** Send a cross-instance tell. */
  async sendTell(name: string, target: string, message: string, senderName: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`Gateway "${name}" not found.`);
    if (conn.status !== "connected") throw new Error(`Gateway "${name}" is not connected.`);

    await conn.client.command(`tell ${target} [from ${senderName}] ${message}`);
  }

  /** Get status of a specific gateway. */
  getStatus(name: string): GatewayStatus | undefined {
    const conn = this.connections.get(name);
    if (!conn) return undefined;
    return {
      name: conn.name,
      url: conn.url,
      status: conn.status,
      bridgedChannels: [...conn.bridgedChannels],
      messagesRelayed: conn.messagesRelayed,
      connectedAt: conn.connectedAt,
      error: conn.error,
    };
  }

  /** List all gateway names and statuses. */
  listAll(): GatewayStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.name,
      url: c.url,
      status: c.status,
      bridgedChannels: [...c.bridgedChannels],
      messagesRelayed: c.messagesRelayed,
      connectedAt: c.connectedAt,
      error: c.error,
    }));
  }

  /** Load gateways from database and reconnect. */
  async loadFromDB(): Promise<number> {
    if (!this.db) return 0;
    const gateways = this.db.listGateways("active");
    let loaded = 0;
    for (const gw of gateways) {
      try {
        await this.addGateway(gw.name, gw.url);
        // Restore bridged channels
        const bridges = this.db.listGatewayBridges(gw.id);
        for (const channel of bridges) {
          try {
            await this.bridgeChannel(gw.name, channel);
          } catch {
            // Channel join may fail — continue with others
          }
        }
        loaded++;
      } catch (err) {
        console.error(`[gateway] Failed to restore gateway "${gw.name}":`, getErrorMessage(err));
        this.db.updateGatewayStatus(gw.id, "error");
      }
    }
    if (loaded > 0) {
      console.log(`[gateway] Restored ${loaded} gateways from database.`);
    }
    return loaded;
  }

  /** Disconnect all gateways. */
  async close(): Promise<void> {
    const names = [...this.connections.keys()];
    for (const name of names) {
      await this.removeGateway(name);
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private handleRemotePerception(conn: GatewayConnection, p: Perception): void {
    if (p.kind !== "message") return;
    // Require at least text or structured channel/senderName fields
    if (!p.data?.text && !p.data?.channel) return;
    const now = Date.now();

    // Try channel message relay
    const channelPayload = extractChannelPayload(p);
    if (channelPayload) {
      if (channelPayload.sender === conn.entityName) return; // self-loop
      if (!conn.bridgedChannels.has(channelPayload.channel)) return; // not bridged

      // Secondary heuristic: skip messages authored by a peer gateway's own
      // client identity. Not authoritative — the structured envelope below is
      // the real loop guard.
      if (channelPayload.sender.startsWith("Gateway_")) return;

      // Prefer the structured relay meta carried out-of-band in perception data
      // (new peers); otherwise parse it from the body envelope (older peers).
      // Either way `body` is the envelope-stripped content, so local delivery
      // never sees the `[relay …]` framing.
      const parsed = parseRelayEnvelope(channelPayload.content);
      const meta = extractRelayMeta(p) ?? parsed.meta;
      const body = parsed.body;

      // Structured origin loop guard: a message we first federated has come
      // back around. Cannot be spoofed by "[from " in user content — that only
      // affects the legacy fallback count, never `origin`/`hops`.
      if (meta.origin && meta.origin === this.localWorldName) {
        console.warn(
          `[gateway] "${conn.name}" dropped channel relay looped back to origin "${this.localWorldName}"`,
        );
        return;
      }
      if (meta.hops >= MAX_RELAY_HOPS) {
        console.warn(
          `[gateway] "${conn.name}" dropped over-hopped channel relay (${meta.hops} >= ${MAX_RELAY_HOPS} hops)`,
        );
        return;
      }

      // Per-channel rate limit
      const lastRelay = conn.lastRelayAt.get(channelPayload.channel) ?? 0;
      if (now - lastRelay < RELAY_MIN_MS) return;

      conn.lastRelayAt.set(channelPayload.channel, now);
      conn.messagesRelayed++;
      // Deliver the CLEAN readable body to local members; the relay envelope is
      // handed back as structured meta so the caller can carry it out-of-band to
      // other peers (preserving multi-hop loop detection) without leaking the
      // `[relay …]` framing into a local channel message or a user's view.
      const readable = `[from ${conn.name}/${channelPayload.sender}] ${body}`;
      this.localRelay(channelPayload.channel, readable, {
        origin: meta.origin ?? this.localWorldName,
        hops: meta.hops + 1,
      });
      return;
    }

    // Try tell relay
    if (p.tag === "tell") {
      const tellPayload = extractTellPayload(p);
      if (!tellPayload) return;
      if (tellPayload.sender.startsWith("Gateway_")) return; // from another gateway

      const { meta, body } = parseRelayEnvelope(tellPayload.message);
      if (meta.origin && meta.origin === this.localWorldName) {
        console.warn(
          `[gateway] "${conn.name}" dropped tell relay looped back to origin "${this.localWorldName}"`,
        );
        return;
      }
      if (meta.hops >= MAX_RELAY_HOPS) {
        console.warn(
          `[gateway] "${conn.name}" dropped over-hopped tell relay (${meta.hops} >= ${MAX_RELAY_HOPS} hops)`,
        );
        return;
      }

      // Recover the intended local recipient. Prefer the structured envelope
      // target, then a leading `@name`/`to:name` routing token. When neither is
      // present the target is unrecoverable — localTellRelay must NOT broadcast.
      const routed = extractRoutingTarget(body);
      const target = meta.target ?? routed.target;

      // Rate limit tells
      const lastTellRelay = conn.lastRelayAt.get("__tell__") ?? 0;
      if (now - lastTellRelay < RELAY_MIN_MS) return;

      conn.lastRelayAt.set("__tell__", now);
      conn.messagesRelayed++;
      this.localTellRelay(
        target,
        `${conn.name}/${tellPayload.sender}`,
        routed.body,
        conn.entityName,
      );
    }
  }

  /**
   * @internal Test hook — feed a perception as if it arrived on a connection
   * named `connName` (presenting as `entityName`, bridged to `bridged`).
   * Exercises the real relay decision + local delivery wiring without a live
   * WebSocket. Not used in production paths.
   */
  receivePerceptionForTest(
    connName: string,
    entityName: string,
    bridged: string[],
    p: Perception,
  ): void {
    const conn: GatewayConnection = {
      name: connName,
      url: "",
      client: undefined as unknown as MarinaClient,
      entityName,
      bridgedChannels: new Set(bridged),
      status: "connected",
      messagesRelayed: 0,
      connectedAt: 0,
      lastRelayAt: new Map(),
    };
    this.handleRemotePerception(conn, p);
  }
}
