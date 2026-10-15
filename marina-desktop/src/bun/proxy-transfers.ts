// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary request and response bodies for the desktop webview's local API proxy.
 *
 * The Electrobun RPC carries JSON, so the webview sends an upload body to the
 * main process in bounded base64 chunks (which lets the dashboard show real
 * byte progress) and reads asset bytes back the same way. The main process
 * forwards the assembled request to the embedded HTTP server unchanged, so
 * authorization, upload caps, deduplication, MIME policy and asset events are
 * exactly the server's. Only `/api/*` requests and `GET /assets/<key>` are
 * accepted; transfers are capped in size and count, and idle ones expire.
 */

import { maxUploadBytes } from "../../../src/net/http-utils";

/** Bytes per RPC chunk (raw; base64 adds a third). */
export const TRANSFER_CHUNK_BYTES = 512 * 1024;
/** A transfer untouched for this long is dropped. */
export const TRANSFER_IDLE_MS = 120_000;
/** Most open transfers at once (uploads + downloads). */
export const MAX_OPEN_TRANSFERS = 16;
/** Multipart framing allowance above the server's upload cap. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** Largest asset body read back through the bridge. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export interface ProxyResult {
  status: number;
  contentType: string;
  body: string;
}

export interface UploadBeginParams {
  path: string;
  method: string;
  headers?: Record<string, string>;
  /** Total body bytes the webview will send. */
  size: number;
}

export interface UploadChunkParams {
  id: string;
  /** Byte offset of this chunk; chunks arrive in order. */
  offset: number;
  dataBase64: string;
}

export interface DownloadBeginParams {
  path: string;
  headers?: Record<string, string>;
}

export interface DownloadBeginResult {
  status: number;
  contentType: string;
  size: number;
  /** Present when more chunks must be read; absent when `bodyBase64` holds it all. */
  id?: string;
  /** The whole body when it fits in one chunk (or an error body). */
  bodyBase64?: string;
}

export interface DownloadChunkParams {
  id: string;
  offset: number;
}

/** Forwards a request to the embedded server with the native credential policy applied. */
export type LocalFetch = (
  path: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array<ArrayBuffer> | string;
  },
) => Promise<Response>;

interface Upload {
  kind: "upload";
  path: string;
  method: string;
  headers?: Record<string, string>;
  data: Uint8Array<ArrayBuffer>;
  received: number;
  touched: number;
}

interface Download {
  kind: "download";
  data: Uint8Array<ArrayBuffer>;
  touched: number;
}

/** True for a path the webview may proxy: the local `/api/*` surface only. */
export function isLocalApiPath(path: string): boolean {
  return path.startsWith("/api/") && !path.includes("://") && !path.includes("\\");
}

/** True for one stored asset's bytes: `/assets/<key>` with an optional query. */
export function isAssetBytesPath(path: string): boolean {
  return /^\/assets\/[^/?#\\]+(\?[^#]*)?$/.test(path) && !path.includes("..");
}

function jsonError(status: number, error: string): ProxyResult {
  return { status, contentType: "application/json", body: JSON.stringify({ error }) };
}

/** An error answer to a download, inline. */
function downloadError(status: number, error: string): DownloadBeginResult {
  const body = Buffer.from(JSON.stringify({ error }));
  return {
    status,
    contentType: "application/json",
    size: body.byteLength,
    bodyBase64: body.toString("base64"),
  };
}

export function createProxyTransfers(
  localFetch: LocalFetch,
  opts: { now?: () => number; uploadCap?: () => number } = {},
) {
  const now = opts.now ?? Date.now;
  const uploadCap = opts.uploadCap ?? (() => maxUploadBytes() + MULTIPART_OVERHEAD_BYTES);
  const transfers = new Map<string, Upload | Download>();

  function sweep(): void {
    const cutoff = now() - TRANSFER_IDLE_MS;
    for (const [id, t] of transfers) if (t.touched < cutoff) transfers.delete(id);
  }

  function open(t: Upload | Download): string | undefined {
    sweep();
    if (transfers.size >= MAX_OPEN_TRANSFERS) return undefined;
    const id = crypto.randomUUID();
    transfers.set(id, t);
    return id;
  }

  return {
    /** Open transfers (tests). */
    get size(): number {
      return transfers.size;
    },

    uploadBegin(params: UploadBeginParams): { id: string } | { error: ProxyResult } {
      const method = params.method.toUpperCase();
      if (!isLocalApiPath(params.path)) return { error: jsonError(400, "Invalid local API path") };
      if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
        return { error: jsonError(405, "Upload bodies are POST, PUT or PATCH") };
      }
      if (!Number.isSafeInteger(params.size) || params.size < 0) {
        return { error: jsonError(400, "Invalid upload size") };
      }
      const cap = uploadCap();
      if (params.size > cap) {
        return {
          error: jsonError(413, `File too large. Maximum ${Math.floor(cap / 1024 / 1024)}MB.`),
        };
      }
      const id = open({
        kind: "upload",
        path: params.path,
        method,
        headers: params.headers,
        data: new Uint8Array(params.size),
        received: 0,
        touched: now(),
      });
      if (!id) return { error: jsonError(429, "Too many transfers in progress") };
      return { id };
    },

    uploadChunk(params: UploadChunkParams): { received: number } | { error: string } {
      const t = transfers.get(params.id);
      if (t?.kind !== "upload") return { error: "Unknown upload" };
      if (params.offset !== t.received) {
        transfers.delete(params.id);
        return { error: "Out-of-order upload chunk" };
      }
      const bytes = Buffer.from(params.dataBase64, "base64");
      if (t.received + bytes.byteLength > t.data.byteLength) {
        transfers.delete(params.id);
        return { error: "Upload exceeds its declared size" };
      }
      t.data.set(bytes, t.received);
      t.received += bytes.byteLength;
      t.touched = now();
      return { received: t.received };
    },

    async uploadFinish(id: string): Promise<ProxyResult> {
      const t = transfers.get(id);
      if (t?.kind !== "upload") return jsonError(400, "Unknown upload");
      transfers.delete(id);
      if (t.received !== t.data.byteLength) return jsonError(400, "Upload incomplete");
      const response = await localFetch(t.path, {
        method: t.method,
        headers: t.headers,
        body: t.data,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: await response.text(),
      };
    },

    /** Drop an upload or download (cancel). */
    abort(id: string): void {
      transfers.delete(id);
    },

    async downloadBegin(params: DownloadBeginParams): Promise<DownloadBeginResult> {
      if (!isAssetBytesPath(params.path)) return downloadError(400, "Invalid asset path");
      const response = await localFetch(params.path, { method: "GET", headers: params.headers });
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > MAX_DOWNLOAD_BYTES) {
        return downloadError(413, "Asset too large for the desktop bridge");
      }
      const base = { status: response.status, contentType, size: data.byteLength };
      if (data.byteLength <= TRANSFER_CHUNK_BYTES) {
        return { ...base, bodyBase64: Buffer.from(data).toString("base64") };
      }
      const id = open({ kind: "download", data, touched: now() });
      if (!id) return downloadError(429, "Too many transfers in progress");
      return { ...base, id };
    },

    downloadChunk(params: DownloadChunkParams): { dataBase64: string } | { error: string } {
      const t = transfers.get(params.id);
      if (t?.kind !== "download") return { error: "Unknown download" };
      if (!Number.isSafeInteger(params.offset) || params.offset < 0) {
        return { error: "Invalid offset" };
      }
      const end = Math.min(params.offset + TRANSFER_CHUNK_BYTES, t.data.byteLength);
      const chunk = t.data.subarray(params.offset, end);
      t.touched = now();
      if (end >= t.data.byteLength) transfers.delete(params.id);
      return { dataBase64: Buffer.from(chunk).toString("base64") };
    },
  };
}

export type ProxyTransfers = ReturnType<typeof createProxyTransfers>;
