// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * RPC Shim — Injected into the dashboard webview via the Electroview entry.
 *
 * Monkey-patches window.fetch and WebSocket so the dashboard SPA
 * (which expects HTTP/WS to localhost) transparently routes through
 * Electrobun's RPC instead.
 *
 * The dashboard source code is completely unaware of this shim.
 */

import { Electroview } from "electrobun/view";
import type { DashboardRPCSchema } from "../../bun/rpc-schema";

// ─── Debug helpers ──────────────────────────────────────────────────────────

/** Persistent overlay for fatal init errors only (RPC setup failure, etc.) */
function showFatalError(msg: string): void {
  let el = document.getElementById("__err");
  if (!el) {
    el = document.createElement("pre");
    el.id = "__err";
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;padding:16px;background:#1a1a2e;color:#ff4444;font:13px/1.5 monospace;z-index:99999;white-space:pre-wrap;max-height:50vh;overflow:auto";
    document.body?.prepend(el);
  }
  el.textContent += msg + "\n";
}

/** Auto-dismissing toast for transient warnings (game WS errors, etc.) */
function showToast(msg: string, durationMs = 4000): void {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;bottom:16px;right:16px;padding:10px 16px;background:#1a1a2e;color:#ff8844;font:12px/1.4 'Share Tech Mono',monospace;z-index:99999;border:1px solid #ff884444;border-radius:6px;opacity:0;transition:opacity 0.3s ease;max-width:400px;pointer-events:none";
  document.body?.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

// ─── RPC Setup ──────────────────────────────────────────────────────────────

// Save original WebSocket before any patching
const OriginalWebSocket = window.WebSocket;

let rpc: ReturnType<typeof Electroview.defineRPC<DashboardRPCSchema>>;
let rpcConnected = false;

try {
  // Define RPC with bun→webview push message handlers
  rpc = Electroview.defineRPC<DashboardRPCSchema>({
    handlers: {
      requests: {},
      messages: {
        snapshot: (data) => {
          dispatchWsMessage({ type: "snapshot", data });
        },
        state: (data) => {
          dispatchWsMessage({ type: "state", data });
        },
        event: (data) => {
          dispatchWsMessage({ type: "event", data });
        },
        statusChange: (data) => {
          dispatchWsMessage({ type: "statusChange", data });
        },
        engineLog: (_entry) => {},
        gameMessage: (data) => {
          dispatchGameMessage(data);
        },
        canvasEvent: (data) => {
          dispatchCanvasMessage(data);
        },
      },
    },
  });

  // Initialize Electroview to set up the WebSocket transport to the bun process.
  new Electroview({ rpc });
  rpcConnected = true;
} catch (err) {
  showFatalError(
    `[rpc-shim] Electroview init failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
  );
}

// ─── WebSocket Message Relay ────────────────────────────────────────────────

type WsMessageHandler = (ev: MessageEvent) => void;
const wsMessageHandlers: WsMessageHandler[] = [];

function dispatchWsMessage(data: unknown): void {
  const msgEvent = new MessageEvent("message", {
    data: JSON.stringify(data),
  });
  for (const handler of wsMessageHandlers) {
    handler(msgEvent);
  }
}

// ─── Fetch Interception ─────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);

// Cast the LHS: the bound original fetch is a plain function type, while
// `window.fetch` (lib.dom) now carries a `preconnect` static the polyfill
// doesn't implement. Assigning through the original's type is correct here.
(
  window as unknown as {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }
).fetch = async function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  // Extract pathname — handle both relative (/api/...) and absolute URLs
  let pathname: string;
  try {
    const parsed = new URL(url, window.location.origin);
    pathname = parsed.pathname;
  } catch {
    pathname = url;
  }

  // Only intercept /api/* paths when RPC is connected
  if (!pathname.startsWith("/api/") || !rpcConnected) {
    return originalFetch(input, init);
  }

  const method = init?.method?.toUpperCase() ?? "GET";

  try {
    // Special case: asset upload via multipart or raw body
    if (pathname === "/api/assets" && method === "POST") {
      const data = await handleAssetUpload(input, init);
      return new Response(JSON.stringify(data), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse JSON body for POST/PATCH requests
    let body: unknown;
    if ((method === "POST" || method === "PATCH") && init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = undefined;
      }
    }

    const data = await routeApiRequest(pathname, method, body);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Silently return 503 — React Query handles retries/error states.
    // RPC timeouts are expected when native dialogs block the event loop.
    console.warn(`[rpc-shim] RPC request failed: ${pathname}`, err);
    return new Response(JSON.stringify({ error: "RPC unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
};

/** Convert multipart or raw asset upload into a base64 RPC call. */
async function handleAssetUpload(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  const contentType =
    (init?.headers as Record<string, string>)?.["Content-Type"] ??
    (init?.headers as Record<string, string>)?.["content-type"] ??
    "";

  let filename: string;
  let mime: string;
  let dataBase64: string;
  let entity = "system";

  if (contentType.includes("multipart/form-data") && init?.body) {
    // Reconstruct FormData from the body
    const res = new Response(init.body, { headers: { "Content-Type": contentType } });
    const formData = await res.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) throw new Error("Missing file field");
    filename = file.name;
    mime = file.type || "application/octet-stream";
    const buf = await file.arrayBuffer();
    dataBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    entity = (formData.get("entity") as string) ?? "system";
  } else {
    // Raw body upload
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, window.location.origin);
    filename = parsed.searchParams.get("filename") ?? "upload";
    mime = contentType || "application/octet-stream";
    entity = parsed.searchParams.get("entity") ?? "system";
    const buf = init?.body
      ? typeof init.body === "string"
        ? new TextEncoder().encode(init.body)
        : new Uint8Array(init.body as ArrayBuffer)
      : new Uint8Array(0);
    dataBase64 = btoa(String.fromCharCode(...buf));
  }

  return rpc.request.uploadAsset({ filename, mime, dataBase64, entity });
}

async function routeApiRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  // ── DELETE routes ──
  if (method === "DELETE") {
    const entityDeleteMatch = pathname.match(/^\/api\/entities\/(.+)$/);
    if (entityDeleteMatch) {
      return rpc.request.deleteEntity(
        decodeURIComponent(entityDeleteMatch[1]!),
      );
    }
    // DELETE /api/canvases/:id/nodes/:nodeId
    const nodeDeleteMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)$/);
    if (nodeDeleteMatch) {
      return rpc.request.deleteNode({
        canvas_id: decodeURIComponent(nodeDeleteMatch[1]!),
        id: decodeURIComponent(nodeDeleteMatch[2]!),
      });
    }
    // DELETE /api/canvases/:id
    const canvasDeleteMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasDeleteMatch) {
      return rpc.request.deleteCanvas(decodeURIComponent(canvasDeleteMatch[1]!));
    }
    // DELETE /api/assets/:id
    const assetDeleteMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetDeleteMatch) {
      return rpc.request.deleteAsset(decodeURIComponent(assetDeleteMatch[1]!));
    }
    throw new Error(`Unknown DELETE route: ${pathname}`);
  }

  // ── PATCH routes ──
  if (method === "PATCH") {
    const nodeUpdateMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)$/);
    if (nodeUpdateMatch) {
      const b = body as Record<string, unknown> | undefined;
      return rpc.request.updateNode({
        canvas_id: decodeURIComponent(nodeUpdateMatch[1]!),
        id: decodeURIComponent(nodeUpdateMatch[2]!),
        x: b?.x as number | undefined,
        y: b?.y as number | undefined,
        width: b?.width as number | undefined,
        height: b?.height as number | undefined,
        data: b?.data as Record<string, unknown> | undefined,
      });
    }
    throw new Error(`Unknown PATCH route: ${pathname}`);
  }

  // ── POST routes ──
  if (method === "POST") {
    // POST /api/canvases/:id/nodes — create node
    const nodeCreateMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/nodes$/);
    if (nodeCreateMatch) {
      const b = body as Record<string, unknown> | undefined;
      return rpc.request.createNode({
        canvas_id: decodeURIComponent(nodeCreateMatch[1]!),
        type: b?.type as string | undefined,
        x: b?.x as number | undefined,
        y: b?.y as number | undefined,
        width: b?.width as number | undefined,
        height: b?.height as number | undefined,
        asset_id: b?.asset_id as string | undefined,
        data: b?.data as Record<string, unknown> | undefined,
        creator_name: b?.creator_name as string | undefined,
      });
    }
    // POST /api/canvases — create canvas
    if (pathname === "/api/canvases") {
      return rpc.request.createCanvas(body as any);
    }
    // POST /api/assets — upload asset (handled separately in fetch interceptor)
    throw new Error(`Unknown POST route: ${pathname}`);
  }

  // ── GET: Exact matches ──
  if (pathname === "/api/world") return rpc.request.getWorld();
  if (pathname === "/api/system") return rpc.request.getSystem();
  if (pathname === "/api/entities") return rpc.request.getEntities();
  if (pathname === "/api/events") return rpc.request.getEvents(100);
  if (pathname === "/api/coordination/boards") return rpc.request.getBoards();
  if (pathname === "/api/coordination/tasks") return rpc.request.getTasks();
  if (pathname === "/api/coordination/channels")
    return rpc.request.getChannels();
  if (pathname === "/api/coordination/groups") return rpc.request.getGroups();
  if (pathname === "/api/coordination/projects")
    return rpc.request.getProjects();
  if (pathname === "/api/connectors") return rpc.request.getConnectors();
  if (pathname === "/api/commands") return rpc.request.getCommands();
  if (pathname === "/api/memory/pools") return rpc.request.getMemoryPools();
  if (pathname === "/api/canvases") return rpc.request.getCanvases();
  if (pathname === "/api/assets") return rpc.request.getAssets();

  // ── GET: Parameterized detail routes ──
  const taskDetailMatch = pathname.match(
    /^\/api\/coordination\/tasks\/(\d+)$/,
  );
  if (taskDetailMatch) {
    return rpc.request.getTaskDetail(Number(taskDetailMatch[1]));
  }

  const boardDetailMatch = pathname.match(
    /^\/api\/coordination\/boards\/(.+)$/,
  );
  if (boardDetailMatch) {
    return rpc.request.getBoardDetail(
      decodeURIComponent(boardDetailMatch[1]!),
    );
  }

  const groupDetailMatch = pathname.match(
    /^\/api\/coordination\/groups\/(.+)$/,
  );
  if (groupDetailMatch) {
    return rpc.request.getGroupDetail(
      decodeURIComponent(groupDetailMatch[1]!),
    );
  }

  const channelDetailMatch = pathname.match(
    /^\/api\/coordination\/channels\/(.+)$/,
  );
  if (channelDetailMatch) {
    return rpc.request.getChannelDetail(
      decodeURIComponent(channelDetailMatch[1]!),
    );
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/(.+)$/);
  if (roomMatch) {
    return rpc.request.getRoomDetail(decodeURIComponent(roomMatch[1]!));
  }

  const entityMatch = pathname.match(/^\/api\/entities\/(.+)$/);
  if (entityMatch) {
    return rpc.request.getEntityDetail(decodeURIComponent(entityMatch[1]!));
  }

  const memNotesMatch = pathname.match(/^\/api\/memory\/notes\/(.+)$/);
  if (memNotesMatch) {
    return rpc.request.getMemoryNotes(decodeURIComponent(memNotesMatch[1]!));
  }

  const memCoreMatch = pathname.match(/^\/api\/memory\/core\/(.+)$/);
  if (memCoreMatch) {
    return rpc.request.getMemoryCore(decodeURIComponent(memCoreMatch[1]!));
  }

  // GET /api/canvases/:id/nodes/:nodeId
  const nodeDetailMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)$/);
  if (nodeDetailMatch) {
    return rpc.request.getNode({
      canvas_id: decodeURIComponent(nodeDetailMatch[1]!),
      node_id: decodeURIComponent(nodeDetailMatch[2]!),
    });
  }

  // GET /api/canvases/:id
  const canvasDetailMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
  if (canvasDetailMatch) {
    return rpc.request.getCanvasDetail(decodeURIComponent(canvasDetailMatch[1]!));
  }

  // GET /api/assets/:id
  const assetDetailMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (assetDetailMatch) {
    return rpc.request.getAssetDetail(decodeURIComponent(assetDetailMatch[1]!));
  }

  throw new Error(`Unknown API route: ${pathname}`);
}

// ─── Game WebSocket Message Relay ──────────────────────────────────────────

const gameMessageHandlers: WsMessageHandler[] = [];

function dispatchGameMessage(data: unknown): void {
  const msgEvent = new MessageEvent("message", {
    data: JSON.stringify(data),
  });
  for (const handler of gameMessageHandlers) {
    handler(msgEvent);
  }
}

// ─── Canvas WebSocket Message Relay ───────────────────────────────────────

const canvasMessageHandlers: WsMessageHandler[] = [];

function dispatchCanvasMessage(data: unknown): void {
  const msgEvent = new MessageEvent("message", {
    data: JSON.stringify(data),
  });
  for (const handler of canvasMessageHandlers) {
    handler(msgEvent);
  }
}

// ─── WebSocket Interception ─────────────────────────────────────────────────

class RpcWebSocket extends EventTarget {
  readyState: number = OriginalWebSocket.OPEN;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  constructor(url: string, _protocols?: string | string[]) {
    super();
    this.url = url;

    const handler: WsMessageHandler = (ev) => {
      this.onmessage?.(ev);
      this.dispatchEvent(new MessageEvent("message", { data: ev.data }));
    };
    wsMessageHandlers.push(handler);

    if (rpcConnected) {
      rpc.send.ready();
    }

    // Simulate async open
    queueMicrotask(() => {
      const openEvent = new Event("open");
      this.onopen?.(openEvent);
      this.dispatchEvent(openEvent);
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // Dashboard WS is read-only
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = OriginalWebSocket.CLOSED;
    const closeEvent = new CloseEvent("close", {
      code: 1000,
      reason: "closed",
      wasClean: true,
    });
    this.onclose?.(closeEvent);
    this.dispatchEvent(closeEvent);
  }
}

/** Bidirectional game WebSocket — sends login/commands via RPC, receives perceptions */
class RpcGameWebSocket extends EventTarget {
  readyState: number = OriginalWebSocket.CONNECTING;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  constructor(url: string, _protocols?: string | string[]) {
    super();
    this.url = url;

    // Register for game perception messages from the bun side
    const handler: WsMessageHandler = (ev) => {
      this.onmessage?.(ev);
      this.dispatchEvent(new MessageEvent("message", { data: ev.data }));
    };
    gameMessageHandlers.push(handler);

    // Establish the virtual game connection on the bun side
    if (rpcConnected) {
      rpc.request
        .gameConnect()
        .then(() => {
          this.readyState = OriginalWebSocket.OPEN;
          queueMicrotask(() => {
            const openEvent = new Event("open");
            this.onopen?.(openEvent);
            this.dispatchEvent(openEvent);
          });
        })
        .catch((err) => {
          showToast(`Game connection failed: ${err instanceof Error ? err.message : String(err)}`);
          const errorEvent = new Event("error");
          this.onerror?.(errorEvent);
          this.dispatchEvent(errorEvent);
        });
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!rpcConnected || this.readyState !== OriginalWebSocket.OPEN) return;
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    rpc.request.gameSend(raw).catch((err) => {
      console.warn("[rpc-shim] gameSend failed:", err);
    });
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = OriginalWebSocket.CLOSED;
    if (rpcConnected) {
      rpc.request.gameDisconnect().catch(() => {});
    }
    const closeEvent = new CloseEvent("close", {
      code: 1000,
      reason: "closed",
      wasClean: true,
    });
    this.onclose?.(closeEvent);
    this.dispatchEvent(closeEvent);
  }
}

/** Read-only canvas WebSocket — receives canvas node change events via RPC push */
class RpcCanvasWebSocket extends EventTarget {
  readyState: number = OriginalWebSocket.OPEN;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  constructor(url: string, _protocols?: string | string[]) {
    super();
    this.url = url;

    const handler: WsMessageHandler = (ev) => {
      this.onmessage?.(ev);
      this.dispatchEvent(new MessageEvent("message", { data: ev.data }));
    };
    canvasMessageHandlers.push(handler);

    queueMicrotask(() => {
      const openEvent = new Event("open");
      this.onopen?.(openEvent);
      this.dispatchEvent(openEvent);
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // Canvas WS is read-only in the dashboard
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = OriginalWebSocket.CLOSED;
    const closeEvent = new CloseEvent("close", {
      code: 1000,
      reason: "closed",
      wasClean: true,
    });
    this.onclose?.(closeEvent);
    this.dispatchEvent(closeEvent);
  }
}

// Patch WebSocket — intercept dashboard-ws, canvas-ws, and game /ws connections
const patchedWebSocket = function WebSocket(
  url: string | URL,
  protocols?: string | string[],
): WebSocket {
  const urlStr = url.toString();
  if (urlStr.includes("/dashboard-ws")) {
    return new RpcWebSocket(urlStr, protocols) as unknown as WebSocket;
  }
  if (urlStr.includes("/canvas-ws")) {
    return new RpcCanvasWebSocket(urlStr, protocols) as unknown as WebSocket;
  }
  if (rpcConnected && urlStr.endsWith("/ws")) {
    return new RpcGameWebSocket(urlStr, protocols) as unknown as WebSocket;
  }
  return new OriginalWebSocket(urlStr, protocols);
} as unknown as typeof WebSocket;

// The readyState constants are readonly on `typeof WebSocket`; assign them
// through a writable view to mirror them onto the patched constructor.
const wsStatics = patchedWebSocket as unknown as {
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
};
wsStatics.CONNECTING = OriginalWebSocket.CONNECTING;
wsStatics.OPEN = OriginalWebSocket.OPEN;
wsStatics.CLOSING = OriginalWebSocket.CLOSING;
wsStatics.CLOSED = OriginalWebSocket.CLOSED;
patchedWebSocket.prototype = OriginalWebSocket.prototype;

window.WebSocket = patchedWebSocket;
