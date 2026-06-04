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
 * Maximum number of relay hops before a message is dropped. The existing
 * self-loop and sender-prefix checks catch immediate cycles; this caps
 * multi-gateway chains (A → B → C → A) where no individual hop looks
 * like a loop but the net effect is one.
 *
 * The relay format `[from <gw>/<sender>] <content>` accumulates one
 * "[from " per hop, so counting occurrences in the incoming content is
 * a good hop-count proxy without a protocol format change.
 */
const MAX_RELAY_HOPS = 3;

function countRelayHops(content: string): number {
  // Count non-overlapping occurrences of "[from " — one per relay hop.
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
  private localRelay: (channel: string, message: string) => void;
  private localTellRelay: (senderLabel: string, message: string, originEntity: string) => void;
  private localWorldName: string;

  constructor(opts: {
    db?: MarinaDB;
    localRelay: (channel: string, message: string) => void;
    localTellRelay: (senderLabel: string, message: string, originEntity: string) => void;
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

      // Don't relay messages from other gateways (prevent cross-gateway loops)
      if (channelPayload.sender.startsWith("Gateway_")) return;

      // Hop-count guard: drop messages that have already been relayed
      // through MAX_RELAY_HOPS gateways to prevent multi-hop chains.
      if (countRelayHops(channelPayload.content) >= MAX_RELAY_HOPS) {
        console.warn(
          `[gateway] "${conn.name}" dropped over-hopped channel relay (>=${MAX_RELAY_HOPS} hops)`,
        );
        return;
      }

      // Per-channel rate limit
      const lastRelay = conn.lastRelayAt.get(channelPayload.channel) ?? 0;
      if (now - lastRelay < RELAY_MIN_MS) return;

      conn.lastRelayAt.set(channelPayload.channel, now);
      conn.messagesRelayed++;
      this.localRelay(
        channelPayload.channel,
        `[from ${conn.name}/${channelPayload.sender}] ${channelPayload.content}`,
      );
      return;
    }

    // Try tell relay
    if (p.tag === "tell") {
      const tellPayload = extractTellPayload(p);
      if (!tellPayload) return;
      if (tellPayload.sender.startsWith("Gateway_")) return; // from another gateway

      // Hop-count guard (same rationale as channel relay above).
      if (countRelayHops(tellPayload.message) >= MAX_RELAY_HOPS) {
        console.warn(
          `[gateway] "${conn.name}" dropped over-hopped tell relay (>=${MAX_RELAY_HOPS} hops)`,
        );
        return;
      }

      // Rate limit tells
      const lastTellRelay = conn.lastRelayAt.get("__tell__") ?? 0;
      if (now - lastTellRelay < RELAY_MIN_MS) return;

      conn.lastRelayAt.set("__tell__", now);
      conn.messagesRelayed++;
      this.localTellRelay(
        `${conn.name}/${tellPayload.sender}`,
        tellPayload.message,
        conn.entityName,
      );
    }
  }
}
