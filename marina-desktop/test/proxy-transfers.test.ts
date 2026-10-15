// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  createProxyTransfers,
  isAssetBytesPath,
  isLocalApiPath,
  type LocalFetch,
  MAX_OPEN_TRANSFERS,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_IDLE_MS,
} from "../src/bun/proxy-transfers";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function recordingFetch(answer: (path: string) => Response = () => Response.json({ ok: true })) {
  const calls: {
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: unknown;
  }[] = [];
  const fetchLocal: LocalFetch = async (path, init) => {
    calls.push({ path, ...init });
    return answer(path);
  };
  return { calls, fetchLocal };
}

describe("proxy path rules", () => {
  test("only the local API and single asset keys are proxied", () => {
    expect(isLocalApiPath("/api/assets?view=library&kind=image")).toBe(true);
    expect(isLocalApiPath("/api/x://evil")).toBe(false);
    expect(isLocalApiPath("/health")).toBe(false);
    expect(isAssetBytesPath("/assets/abc.png")).toBe(true);
    expect(isAssetBytesPath("/assets/abc.png?p=a&exp=1&sig=x")).toBe(true);
    expect(isAssetBytesPath("/assets/../marina.db")).toBe(false);
    expect(isAssetBytesPath("/assets/a/b.png")).toBe(false);
    expect(isAssetBytesPath("/assets/..")).toBe(false);
    expect(isAssetBytesPath("/api/assets/a")).toBe(false);
  });
});

describe("chunked uploads", () => {
  test("reassembles chunks in order and forwards one request with the caller's headers", async () => {
    const { calls, fetchLocal } = recordingFetch(() =>
      Response.json({ id: "a1", deduplicated: true }, { status: 200 }),
    );
    const t = createProxyTransfers(fetchLocal, { uploadCap: () => 10_000_000 });
    const data = new Uint8Array(TRANSFER_CHUNK_BYTES + 10).map((_, i) => i % 251);
    const begin = t.uploadBegin({
      path: "/api/assets",
      method: "post",
      headers: { "content-type": "multipart/form-data; boundary=x", authorization: "Bearer r" },
      size: data.byteLength,
    });
    if (!("id" in begin)) throw new Error("begin refused");
    expect(
      t.uploadChunk({
        id: begin.id,
        offset: 0,
        dataBase64: b64(data.subarray(0, TRANSFER_CHUNK_BYTES)),
      }),
    ).toEqual({ received: TRANSFER_CHUNK_BYTES });
    expect(
      t.uploadChunk({
        id: begin.id,
        offset: TRANSFER_CHUNK_BYTES,
        dataBase64: b64(data.subarray(TRANSFER_CHUNK_BYTES)),
      }),
    ).toEqual({ received: data.byteLength });
    const result = await t.uploadFinish(begin.id);
    // The server's own answer passes through: 200 + deduplicated.
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: "a1", deduplicated: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      "content-type": "multipart/form-data; boundary=x",
      authorization: "Bearer r",
    });
    expect(Buffer.from(calls[0]!.body as Uint8Array).equals(Buffer.from(data))).toBe(true);
    expect(t.size).toBe(0);
  });

  test("refuses bad paths, methods, oversize bodies, gaps, overflow and incomplete finishes", async () => {
    const { calls, fetchLocal } = recordingFetch();
    const t = createProxyTransfers(fetchLocal, { uploadCap: () => 100 });
    expect(t.uploadBegin({ path: "/assets/x", method: "POST", size: 1 })).toMatchObject({
      error: { status: 400 },
    });
    expect(t.uploadBegin({ path: "/api/assets", method: "GET", size: 1 })).toMatchObject({
      error: { status: 405 },
    });
    expect(t.uploadBegin({ path: "/api/assets", method: "POST", size: 101 })).toMatchObject({
      error: { status: 413 },
    });
    expect(t.uploadBegin({ path: "/api/assets", method: "POST", size: -1 })).toMatchObject({
      error: { status: 400 },
    });

    const gap = t.uploadBegin({ path: "/api/assets", method: "POST", size: 10 }) as { id: string };
    expect(t.uploadChunk({ id: gap.id, offset: 5, dataBase64: b64(new Uint8Array(5)) })).toEqual({
      error: "Out-of-order upload chunk",
    });
    expect(t.uploadChunk({ id: gap.id, offset: 0, dataBase64: "" })).toEqual({
      error: "Unknown upload",
    });

    const over = t.uploadBegin({ path: "/api/assets", method: "POST", size: 4 }) as { id: string };
    expect(t.uploadChunk({ id: over.id, offset: 0, dataBase64: b64(new Uint8Array(5)) })).toEqual({
      error: "Upload exceeds its declared size",
    });

    const short = t.uploadBegin({ path: "/api/assets", method: "POST", size: 4 }) as {
      id: string;
    };
    t.uploadChunk({ id: short.id, offset: 0, dataBase64: b64(new Uint8Array(2)) });
    expect((await t.uploadFinish(short.id)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(t.size).toBe(0);
  });

  test("abort drops a transfer; open transfers are capped and idle ones expire", () => {
    let now = 1_000;
    const { fetchLocal } = recordingFetch();
    const t = createProxyTransfers(fetchLocal, { now: () => now, uploadCap: () => 100 });
    const one = t.uploadBegin({ path: "/api/assets", method: "POST", size: 1 }) as { id: string };
    t.abort(one.id);
    expect(t.size).toBe(0);
    for (let i = 0; i < MAX_OPEN_TRANSFERS; i++) {
      expect("id" in t.uploadBegin({ path: "/api/assets", method: "POST", size: 1 })).toBe(true);
    }
    expect(t.uploadBegin({ path: "/api/assets", method: "POST", size: 1 })).toMatchObject({
      error: { status: 429 },
    });
    now += TRANSFER_IDLE_MS + 1;
    expect("id" in t.uploadBegin({ path: "/api/assets", method: "POST", size: 1 })).toBe(true);
    expect(t.size).toBe(1);
  });
});

describe("asset byte downloads", () => {
  test("small bodies come back inline with the server's status and type", async () => {
    const { calls, fetchLocal } = recordingFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const t = createProxyTransfers(fetchLocal);
    const begin = await t.downloadBegin({
      path: "/assets/a.png",
      headers: { authorization: "Bearer r" },
    });
    expect(begin).toEqual({
      status: 200,
      contentType: "image/png",
      size: 3,
      bodyBase64: b64(new Uint8Array([1, 2, 3])),
    });
    expect(calls[0]).toMatchObject({
      path: "/assets/a.png",
      method: "GET",
      headers: { authorization: "Bearer r" },
    });
    expect(t.size).toBe(0);
  });

  test("large bodies stream in chunks and the transfer closes after the last one", async () => {
    const data = new Uint8Array(TRANSFER_CHUNK_BYTES * 2 + 7).map((_, i) => i % 13);
    const { fetchLocal } = recordingFetch(
      () => new Response(data, { headers: { "content-type": "video/mp4" } }),
    );
    const t = createProxyTransfers(fetchLocal);
    const begin = await t.downloadBegin({ path: "/assets/v.mp4" });
    expect(begin.bodyBase64).toBeUndefined();
    expect(begin.size).toBe(data.byteLength);
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < begin.size) {
      const chunk = t.downloadChunk({ id: begin.id!, offset });
      if ("error" in chunk) throw new Error(chunk.error);
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      parts.push(bytes);
      offset += bytes.byteLength;
    }
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts).equals(Buffer.from(data))).toBe(true);
    expect(t.size).toBe(0);
    expect(t.downloadChunk({ id: begin.id!, offset: 0 })).toEqual({ error: "Unknown download" });
  });

  test("a path outside /assets/<key> is refused without a request", async () => {
    const { calls, fetchLocal } = recordingFetch();
    const t = createProxyTransfers(fetchLocal);
    const begin = await t.downloadBegin({ path: "/api/keys" });
    expect(begin.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
