// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * RPC Shim — Injected into the dashboard webview via the Electroview entry.
 *
 * Monkey-patches window.fetch and WebSocket so the dashboard SPA
 * (which expects HTTP/WS to localhost) transparently routes through
 * Electrobun's RPC instead.
 *
 * The dashboard is unaware of this shim except where `fetch` cannot express
 * what it needs: upload byte progress (`window.marinaDesktop`, see
 * dashboard/src/lib/desktop-bridge.ts) and asset bytes for elements, which
 * dashboard/src/lib/asset-url.ts reads through the patched `fetch` into blob
 * URLs. Asset APIs and bytes are forwarded to the embedded server under the
 * viewer's own credential (or the native operator credential, which never
 * reaches the webview), so the server's authorization and events apply.
 */

import { Electroview } from "electrobun/view";
import { apiOrigin } from "../../../../dashboard/src/lib/api-origin";
import type { DesktopBodyRequest } from "../../../../dashboard/src/lib/desktop-bridge";
import type {
  AgentSpawnParams,
  ApiKeyParams,
  CreateCanvasParams,
  DashboardRPCSchema,
} from "../../bun/rpc-schema";

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
  el.textContent += `${msg}\n`;
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
    // Native startup can queue several snapshots and a large capability catalog.
    // Use the same bounded window as other interactive desktop operations.
    maxRequestTime: 15_000,
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
const wsMessageHandlers = new Set<WsMessageHandler>();

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

/** Raw bytes per upload chunk sent over the RPC (base64 adds a third). */
const UPLOAD_CHUNK_BYTES = 512 * 1024;

/** The local path (`/api/...` or `/assets/...` with query) for a reserved-origin URL. */
function localPath(url: string): { pathname: string; apiPath: string } | undefined {
  try {
    const parsed = new URL(url, apiOrigin());
    if (parsed.origin !== apiOrigin()) return undefined;
    return { pathname: parsed.pathname, apiPath: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { pathname: url, apiPath: url };
  }
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A Response for a proxied answer (null-body statuses carry no body). */
function proxyResponse(result: { status: number; contentType: string; body: string }): Response {
  const nullBody = [101, 103, 204, 205, 304].includes(result.status);
  return new Response(nullBody ? null : result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
}

/**
 * Send a binary request body to the embedded server in chunks, reporting the
 * fraction of bytes handed to the native process. The server sees one ordinary
 * request, so its caps, dedupe answer (200 `deduplicated`) and errors pass
 * through unchanged.
 */
async function uploadBytes(
  path: string,
  method: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw abortError();
  const begin = await rpc.request.proxyUploadBegin({
    path,
    method,
    headers,
    size: bytes.byteLength,
  });
  if ("error" in begin) return proxyResponse(begin.error);
  const id = begin.id;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
      if (signal?.aborted) throw abortError();
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
      const sent = await rpc.request.proxyUploadChunk({
        id,
        offset,
        dataBase64: toBase64(chunk),
      });
      if ("error" in sent) throw new Error(sent.error);
      onProgress?.(sent.received / bytes.byteLength);
    }
    if (signal?.aborted) throw abortError();
    return proxyResponse(await rpc.request.proxyUploadFinish(id));
  } catch (err) {
    rpc.request.proxyTransferAbort(id).catch(() => {});
    throw err;
  }
}

/** Serialize any fetch body (FormData, Blob, buffers) with the headers a browser would send. */
async function serializeBody(
  method: string,
  body: BodyInit,
  headers: HeadersInit | undefined,
): Promise<{ headers: Record<string, string>; bytes: Uint8Array }> {
  const request = new Request(`${apiOrigin()}/`, { method, body, headers });
  return {
    headers: headerRecord(request.headers),
    bytes: new Uint8Array(await request.arrayBuffer()),
  };
}

/** `window.marinaDesktop.sendBody` — uploads with byte progress and cancel. */
async function sendBody(request: DesktopBodyRequest): Promise<Response> {
  const local = localPath(request.url);
  if (!local?.pathname.startsWith("/api/") || !rpcConnected) {
    throw new TypeError(`Not a local API URL: ${request.url}`);
  }
  const method = request.method.toUpperCase();
  const { headers, bytes } = await serializeBody(method, request.body, request.headers);
  return uploadBytes(local.apiPath, method, headers, bytes, request.onProgress, request.signal);
}

/** Read `GET /assets/<key>` bytes through the native adapter, in chunks. */
async function downloadAsset(apiPath: string, init?: RequestInit): Promise<Response> {
  const begin = await rpc.request.proxyDownloadBegin({
    path: apiPath,
    headers: headerRecord(init?.headers),
  });
  const parts: Uint8Array<ArrayBuffer>[] = [];
  if (begin.bodyBase64 !== undefined) parts.push(fromBase64(begin.bodyBase64));
  else if (begin.id) {
    let offset = 0;
    while (offset < begin.size) {
      if (init?.signal?.aborted) {
        rpc.request.proxyTransferAbort(begin.id).catch(() => {});
        throw abortError();
      }
      const chunk = await rpc.request.proxyDownloadChunk({ id: begin.id, offset });
      if ("error" in chunk) throw new Error(chunk.error);
      const bytes = fromBase64(chunk.dataBase64);
      if (bytes.byteLength === 0) throw new Error("Asset read ended early");
      parts.push(bytes);
      offset += bytes.byteLength;
    }
  }
  const nullBody = [101, 103, 204, 205, 304].includes(begin.status);
  return new Response(nullBody ? null : new Blob(parts, { type: begin.contentType }), {
    status: begin.status,
    headers: { "Content-Type": begin.contentType },
  });
}

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
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  // Only intercept the reserved origin's /api/* and /assets/* when RPC is connected.
  const local = localPath(url);
  if (!local || !rpcConnected) return originalFetch(input, init);
  const { pathname, apiPath } = local;
  const isAssetBytes = pathname.startsWith("/assets/");
  if (!pathname.startsWith("/api/") && !isAssetBytes) return originalFetch(input, init);

  const method = (
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
  ).toUpperCase();

  try {
    // Stored asset bytes (elements get them as blob: URLs, see asset-url.ts).
    if (isAssetBytes) {
      if (method !== "GET" && method !== "HEAD") {
        return proxyResponse({
          status: 405,
          contentType: "application/json",
          body: JSON.stringify({ error: "Method not allowed" }),
        });
      }
      return await downloadAsset(apiPath, init);
    }

    // Binary bodies (multipart uploads, blobs, buffers) go to the server as-is.
    const rawBody = init?.body;
    if (rawBody != null && typeof rawBody !== "string") {
      const { headers, bytes } = await serializeBody(method, rawBody, init?.headers);
      return await uploadBytes(
        apiPath,
        method,
        headers,
        bytes,
        undefined,
        init?.signal ?? undefined,
      );
    }

    // Parse JSON body for POST/PATCH/PUT requests; other text passes through.
    let body: unknown;
    let text: string | undefined;
    if ((method === "POST" || method === "PATCH" || method === "PUT") && rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        text = rawBody;
      }
    }

    const data =
      text !== undefined
        ? await proxyApiRequest(apiPath, method, undefined, init, text)
        : await routeApiRequest(pathname, method, body, init, apiPath);
    if (data instanceof Response) return data;
    const failed =
      !!data && typeof data === "object" && "error" in data && typeof data.error === "string";
    return new Response(JSON.stringify(data), {
      status: failed ? 400 : 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // A cancelled request rejects like fetch does.
    if (init?.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      throw err;
    }
    // Silently return 503 — React Query handles retries/error states.
    // RPC timeouts are expected when native dialogs block the event loop.
    console.warn(
      `[rpc-shim] RPC request failed: ${pathname}`,
      err instanceof Error ? err.message : String(err),
    );
    return new Response(JSON.stringify({ error: "RPC unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
};

// Native helpers the dashboard reaches for where `fetch` cannot express them
// (dashboard/src/lib/desktop-bridge.ts).
if (rpcConnected) window.marinaDesktop = { sendBody };

async function routeApiRequest(
  pathname: string,
  method: string,
  body?: unknown,
  init?: RequestInit,
  apiPath = pathname,
): Promise<unknown | Response> {
  // ── DELETE routes ──
  if (method === "DELETE") {
    if (pathname === "/api/default-model") return rpc.request.clearDefaultModel();
    const keyDeleteMatch = pathname.match(/^\/api\/keys\/(.+)$/);
    if (keyDeleteMatch) return rpc.request.deleteKey(decodeURIComponent(keyDeleteMatch[1]!));
    const entityDeleteMatch = pathname.match(/^\/api\/entities\/([^/]+)$/);
    if (entityDeleteMatch) {
      return rpc.request.deleteEntity(decodeURIComponent(entityDeleteMatch[1]!));
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
    // Assets (DELETE /api/assets/:id) go to the server: it authorizes the
    // caller, removes derivatives and emits `asset_deleted`.
    return proxyApiRequest(apiPath, method, body, init);
  }

  // ── PUT routes ──
  if (method === "PUT") {
    if (pathname === "/api/default-model") {
      return rpc.request.setDefaultModel((body as { model?: string } | undefined)?.model ?? "");
    }
    return proxyApiRequest(apiPath, method, body, init);
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
    return proxyApiRequest(apiPath, method, body, init);
  }

  // ── POST routes ──
  if (method === "POST") {
    if (pathname === "/api/keys") return rpc.request.addKey(body as ApiKeyParams);
    const keyTestMatch = pathname.match(/^\/api\/keys\/(.+)\/test$/);
    if (keyTestMatch) return rpc.request.testKey(decodeURIComponent(keyTestMatch[1]!));
    if (pathname === "/api/agents/spawn") return rpc.request.spawnAgent(body as AgentSpawnParams);
    const agentStopMatch = pathname.match(/^\/api\/agents\/(.+)\/stop$/);
    if (agentStopMatch) return rpc.request.stopAgent(decodeURIComponent(agentStopMatch[1]!));
    const attentionMatch = pathname.match(/^\/api\/agents\/(.+)\/attention$/);
    if (attentionMatch) {
      return rpc.request.sendAgentAttention({
        name: decodeURIComponent(attentionMatch[1]!),
        message: (body as { message?: string } | undefined)?.message ?? "",
      });
    }
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
      return rpc.request.createCanvas(body as CreateCanvasParams);
    }
    // POST /api/assets (uploads arrive as binary bodies) and /api/assets/sign
    // go to the server unchanged.
    return proxyApiRequest(apiPath, method, body, init);
  }

  // ── GET: Exact matches ──
  if (pathname === "/api/world") return rpc.request.getWorld();
  if (pathname === "/api/system") return rpc.request.getSystem();
  if (pathname === "/api/entities") return rpc.request.getEntities();
  if (pathname === "/api/events") return rpc.request.getEvents(100);
  if (pathname === "/api/coordination/boards") return rpc.request.getBoards();
  if (pathname === "/api/coordination/tasks") return rpc.request.getTasks();
  if (pathname === "/api/coordination/channels") return rpc.request.getChannels();
  if (pathname === "/api/coordination/groups") return rpc.request.getGroups();
  if (pathname === "/api/coordination/projects") return rpc.request.getProjects();
  if (pathname === "/api/connectors") return rpc.request.getConnectors();
  if (pathname === "/api/commands") return rpc.request.getCommands();
  if (pathname === "/api/memory/pools") return rpc.request.getMemoryPools();
  if (pathname === "/api/canvases") return rpc.request.getCanvases();
  if (pathname === "/api/keys") return rpc.request.getKeys();
  if (pathname === "/api/models") return rpc.request.getModels();
  if (pathname === "/api/default-model") return rpc.request.getDefaultModel();
  if (pathname === "/api/roles") return rpc.request.getRoles();
  if (pathname === "/api/agents") return rpc.request.getAgents();

  // ── GET: Parameterized detail routes ──
  const taskDetailMatch = pathname.match(/^\/api\/coordination\/tasks\/(\d+)$/);
  if (taskDetailMatch) {
    return rpc.request.getTaskDetail(Number(taskDetailMatch[1]));
  }

  const boardDetailMatch = pathname.match(/^\/api\/coordination\/boards\/(.+)$/);
  if (boardDetailMatch) {
    return rpc.request.getBoardDetail(decodeURIComponent(boardDetailMatch[1]!));
  }

  const groupDetailMatch = pathname.match(/^\/api\/coordination\/groups\/(.+)$/);
  if (groupDetailMatch) {
    return rpc.request.getGroupDetail(decodeURIComponent(groupDetailMatch[1]!));
  }

  const channelDetailMatch = pathname.match(/^\/api\/coordination\/channels\/(.+)$/);
  if (channelDetailMatch) {
    return rpc.request.getChannelDetail(decodeURIComponent(channelDetailMatch[1]!));
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch) {
    return rpc.request.getRoomDetail(decodeURIComponent(roomMatch[1]!));
  }

  const entityMatch = pathname.match(/^\/api\/entities\/([^/]+)$/);
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

  // Every /api/assets read (the library view with its filters, cursor and
  // facets, the legacy list, detail) is the server's, read under the viewer's
  // own credential.
  return proxyApiRequest(apiPath, method, body, init);
}

/** Forward APIs that need no native adaptation to the embedded HTTP server. */
async function proxyApiRequest(
  path: string,
  method: string,
  body: unknown,
  init?: RequestInit,
  text?: string,
): Promise<Response> {
  const headers = headerRecord(init?.headers);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const result = await rpc.request.proxyApi({
    path,
    method,
    headers,
    body: text ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return proxyResponse(result);
}

// ─── Game WebSocket Message Relay ──────────────────────────────────────────

const gameMessageHandlers = new Set<WsMessageHandler>();

function dispatchGameMessage(data: unknown): void {
  const msgEvent = new MessageEvent("message", {
    data: JSON.stringify(data),
  });
  for (const handler of gameMessageHandlers) {
    handler(msgEvent);
  }
}

// ─── Canvas WebSocket Message Relay ───────────────────────────────────────

const canvasMessageHandlers = new Set<WsMessageHandler>();

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
  private detach: () => void = () => {};

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
    wsMessageHandlers.add(handler);
    this.detach = () => wsMessageHandlers.delete(handler);

    if (rpcConnected) {
      rpc.send.ready();
    }

    // Simulate async open
    queueMicrotask(() => {
      if (this.readyState === OriginalWebSocket.CLOSED) return;
      const openEvent = new Event("open");
      this.onopen?.(openEvent);
      this.dispatchEvent(openEvent);
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // Dashboard WS is read-only
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === OriginalWebSocket.CLOSED) return;
    this.detach();
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
  private detach: () => void = () => {};

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
    gameMessageHandlers.add(handler);
    this.detach = () => gameMessageHandlers.delete(handler);

    // Establish the virtual game connection on the bun side
    if (rpcConnected) {
      rpc.request
        .gameConnect()
        .then(() => {
          if (this.readyState === OriginalWebSocket.CLOSED) return;
          this.readyState = OriginalWebSocket.OPEN;
          queueMicrotask(() => {
            if (this.readyState === OriginalWebSocket.CLOSED) return;
            const openEvent = new Event("open");
            this.onopen?.(openEvent);
            this.dispatchEvent(openEvent);
          });
        })
        .catch((err) => {
          if (this.readyState === OriginalWebSocket.CLOSED) return;
          showToast(`Game connection failed: ${err instanceof Error ? err.message : String(err)}`);
          const errorEvent = new Event("error");
          this.onerror?.(errorEvent);
          this.dispatchEvent(errorEvent);
          // The shared chat reconnect loop listens for close. A timeout must
          // not strand the virtual socket in CONNECTING forever.
          this.close();
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
    if (this.readyState === OriginalWebSocket.CLOSED) return;
    this.detach();
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
  private detach: () => void = () => {};

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
    canvasMessageHandlers.add(handler);
    this.detach = () => canvasMessageHandlers.delete(handler);

    queueMicrotask(() => {
      if (this.readyState === OriginalWebSocket.CLOSED) return;
      const openEvent = new Event("open");
      this.onopen?.(openEvent);
      this.dispatchEvent(openEvent);
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // Canvas WS is read-only in the dashboard
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === OriginalWebSocket.CLOSED) return;
    this.detach();
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
