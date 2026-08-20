// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed RPC contract between the Bun main process and the dashboard webview.
 *
 * Uses Electrobun's ElectrobunRPCSchema format:
 * - bun.requests: handlers implemented on the bun side, called by the webview
 * - bun.messages: messages the bun side listens for (sent by webview)
 * - webview.requests: handlers on webview side, called by bun
 * - webview.messages: messages the webview listens for (sent by bun)
 */
import type { ElectrobunRPCSchema } from "electrobun/bun";
import type { EngineEvent, Perception } from "../../../src/types";

// ─── Data shapes ────────────────────────────────────────────────────────────

/**
 * Periodic state push to the webview. Payload types in `webview.messages`
 * must be concrete: a payload typed `unknown` makes electrobun's `send`
 * infer "no argument" (because `void extends unknown`), which is why these
 * push messages need a real shape.
 */
export interface StateSnapshot {
  timestamp: number;
  entities: { id: string; name: string; kind: string; room: string }[];
  roomPopulations: Record<string, number>;
  rooms: { id: string; short: string; district: string; exits: Record<string, string> }[];
  connections: number;
  memory: { heapUsed: number; rss: number };
}

export interface WorldData {
  rooms: {
    id: string;
    short: string;
    district: string;
    exits: Record<string, string>;
    entityCount: number;
  }[];
  entities: {
    id: string;
    name: string;
    kind: string;
    room: string;
    rank: number;
  }[];
}

export interface SystemData {
  status: string;
  uptime: number;
  connections: number;
  rooms: number;
  entities: { total: number; agents: number; npcs: number };
  roomPopulations: Record<string, number>;
  memory: { heapUsed: number; rss: number };
  tasks?: {
    open: number;
    claimed: number;
    submitted: number;
    completed: number;
  };
  projectCount?: number;
  connectorCount?: number;
  commandCount?: number;
}

export interface EngineStatusData {
  running: boolean;
  uptime: number;
  entityCount: number;
  agentCount: number;
  roomCount: number;
  connectionCount: number;
  memory: { heapUsed: number; rss: number };
}

export interface PreferencesData {
  mode: "local" | "remote";
  remoteUrl: string;
  dbPath: string;
  wsPort: number;
  telnetPort: number;
  mcpPort: number;
  tickMs: number;
  startRoom: string;
}

// ─── Canvas / Asset request param shapes ───────────────────────────────────

export interface CreateCanvasParams {
  name: string;
  description?: string;
  scope?: string;
  scope_id?: string;
  creator_name?: string;
}

export interface CreateNodeParams {
  canvas_id: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  asset_id?: string;
  data?: Record<string, unknown>;
  creator_name?: string;
}

export interface UpdateNodeParams {
  id: string;
  canvas_id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  data?: Record<string, unknown>;
}

export interface DeleteNodeParams {
  id: string;
  canvas_id: string;
}

export interface UploadAssetParams {
  filename: string;
  mime: string;
  /** Base64-encoded file data */
  dataBase64: string;
  entity?: string;
}

export interface ApiKeyParams {
  name: string;
  provider: string;
  value: string;
}

export interface AgentSpawnParams {
  name: string;
  model?: string;
  role?: string;
  goal?: string;
  keyName?: string;
}

export interface ApiProxyParams {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

// ─── Electrobun RPC Schema ──────────────────────────────────────────────────

export interface DashboardRPCSchema extends ElectrobunRPCSchema {
  /** Bun-side: handles incoming requests from webview, listens for webview messages */
  bun: {
    requests: {
      getWorld: { params: undefined; response: WorldData };
      getSystem: { params: undefined; response: SystemData };
      getEntities: { params: undefined; response: unknown[] };
      getRoomDetail: { params: string; response: unknown };
      getEntityDetail: { params: string; response: unknown };
      deleteEntity: { params: string; response: unknown };
      getBoards: { params: undefined; response: unknown[] };
      getBoardDetail: { params: string; response: unknown };
      getTasks: { params: undefined; response: unknown[] };
      getTaskDetail: { params: number; response: unknown };
      getChannels: { params: undefined; response: unknown[] };
      getChannelDetail: { params: string; response: unknown };
      getGroups: { params: undefined; response: unknown[] };
      getGroupDetail: { params: string; response: unknown };
      getProjects: { params: undefined; response: unknown[] };
      getConnectors: { params: undefined; response: unknown[] };
      getCommands: { params: undefined; response: unknown[] };
      getMemoryPools: { params: undefined; response: unknown[] };
      getMemoryNotes: { params: string; response: unknown[] };
      getMemoryCore: { params: string; response: unknown[] };
      getEvents: { params: number; response: unknown[] };
      getEngineStatus: { params: undefined; response: EngineStatusData };
      getPreferences: { params: undefined; response: PreferencesData };
      setPreferences: {
        params: Partial<PreferencesData>;
        response: { ok: boolean };
      };
      connectRemote: {
        params: string;
        response: { ok: boolean; error?: string };
      };
      switchToLocal: { params: undefined; response: { ok: boolean } };
      /** Create a game connection (virtual WebSocket) for the web chat */
      gameConnect: { params: undefined; response: { connId: string } };
      /** Send a raw JSON message on the game connection (login/auth/command) */
      gameSend: { params: string; response: void };
      /** Disconnect the game connection */
      gameDisconnect: { params: undefined; response: void };

      // ── Clickable desktop setup and agent lifecycle ──
      getKeys: { params: undefined; response: unknown[] };
      addKey: { params: ApiKeyParams; response: unknown };
      deleteKey: { params: string; response: unknown };
      testKey: { params: string; response: unknown };
      getModels: { params: undefined; response: unknown };
      getDefaultModel: { params: undefined; response: unknown };
      setDefaultModel: { params: string; response: unknown };
      clearDefaultModel: { params: undefined; response: unknown };
      getRoles: { params: undefined; response: unknown[] };
      getAgents: { params: undefined; response: unknown[] };
      spawnAgent: { params: AgentSpawnParams; response: unknown };
      stopAgent: { params: string; response: unknown };
      sendAgentAttention: {
        params: { name: string; message: string };
        response: unknown;
      };
      proxyApi: {
        params: ApiProxyParams;
        response: { status: number; contentType: string; body: string };
      };

      // ── Canvas ──
      getCanvases: { params: undefined; response: unknown[] };
      getCanvasDetail: { params: string; response: unknown };
      createCanvas: { params: CreateCanvasParams; response: unknown };
      deleteCanvas: { params: string; response: unknown };
      createNode: { params: CreateNodeParams; response: unknown };
      updateNode: { params: UpdateNodeParams; response: unknown };
      deleteNode: { params: DeleteNodeParams; response: unknown };
      getNode: { params: { canvas_id: string; node_id: string }; response: unknown };

      // ── Assets ──
      getAssets: { params: undefined; response: unknown[] };
      getAssetDetail: { params: string; response: unknown };
      uploadAsset: { params: UploadAssetParams; response: unknown };
      deleteAsset: { params: string; response: unknown };
    };
    messages: {
      /** Webview signals it's ready to receive data */
      ready: void;
    };
  };

  /** Webview-side: no request handlers, listens for bun push messages */
  webview: {
    requests: Record<string, never>;
    messages: {
      /** Full world snapshot pushed periodically */
      snapshot: StateSnapshot;
      /** Periodic state update */
      state: StateSnapshot;
      /** Individual engine event */
      event: EngineEvent;
      /** Engine status changed */
      statusChange: EngineStatusData;
      /** Log entry from engine */
      engineLog: { level: string; category: string; message: string };
      /** Game perception pushed to the web chat */
      gameMessage: Perception;
      /** Canvas node change (add/update/delete) */
      canvasEvent: EngineEvent;
    };
  };
}
