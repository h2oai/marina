// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The webview half of the asset library bridge: every asset route the
 * dashboard calls reaches the embedded server through the proxy (query,
 * method and body intact), binary bodies and asset bytes cross in chunks, and
 * asset events reach the dashboard socket.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { MarinaDesktopBridge } from "../../dashboard/src/lib/desktop-bridge";

type Call = { name: string; params: unknown };
const calls: Call[] = [];
let messages: Record<string, (data: unknown) => void> = {};
let uploaded = new Uint8Array(0);
let finishAnswer = { status: 201, contentType: "application/json", body: '{"id":"a1"}' };
const download = new Uint8Array(700 * 1024).map((_, i) => i % 7);
const DOWNLOAD_CHUNK = 512 * 1024;
const networkFetch = mock(async () => new Response("external"));

const windowStub = {
  WebSocket,
  fetch: networkFetch as unknown as typeof fetch,
  location: { protocol: "views:", origin: "null" },
} as unknown as Window & typeof globalThis & { marinaDesktop?: MarinaDesktopBridge };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function record<T>(name: string, answer: (params: never) => T) {
  return async (params: unknown) => {
    calls.push({ name, params });
    return answer(params as never);
  };
}

beforeAll(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  mock.module("electrobun/view", () => ({
    Electroview: class {
      static defineRPC(options: { handlers: { messages: typeof messages } }) {
        messages = options.handlers.messages;
        return {
          request: {
            proxyApi: record("proxyApi", (p: { path: string; method: string }) => ({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ proxied: p.path, method: p.method }),
            })),
            proxyUploadBegin: record("proxyUploadBegin", (p: { size: number }) => {
              uploaded = new Uint8Array(p.size);
              return { id: "u1" };
            }),
            proxyUploadChunk: record(
              "proxyUploadChunk",
              (p: { offset: number; dataBase64: string }) => {
                const bytes = Buffer.from(p.dataBase64, "base64");
                uploaded.set(bytes, p.offset);
                return { received: p.offset + bytes.byteLength };
              },
            ),
            proxyUploadFinish: record("proxyUploadFinish", () => finishAnswer),
            proxyTransferAbort: record("proxyTransferAbort", () => undefined),
            proxyDownloadBegin: record("proxyDownloadBegin", (p: { path: string }) =>
              p.path.startsWith("/assets/big")
                ? { status: 200, contentType: "video/mp4", size: download.byteLength, id: "d1" }
                : {
                    status: 200,
                    contentType: "image/png",
                    size: 3,
                    bodyBase64: Buffer.from([1, 2, 3]).toString("base64"),
                  },
            ),
            proxyDownloadChunk: record("proxyDownloadChunk", (p: { offset: number }) => ({
              dataBase64: Buffer.from(
                download.subarray(p.offset, p.offset + DOWNLOAD_CHUNK),
              ).toString("base64"),
            })),
            // Native routes that must no longer see asset traffic.
            getAssets: record("getAssets", () => []),
            getAssetDetail: record("getAssetDetail", () => ({})),
            deleteAsset: record("deleteAsset", () => ({})),
            uploadAsset: record("uploadAsset", () => ({})),
          },
          send: { ready: () => {} },
        };
      }
      constructor(readonly options: unknown) {}
    },
  }));
  // A distinct specifier: a fresh shim instance even when rpc-shim.test.ts
  // already evaluated the module in this process.
  const shim = "../src/views/dashboard/rpc-shim?assets";
  await import(shim);
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  mock.restore();
});

const origin = "http://marina.desktop.invalid";
const named = (name: string) => calls.filter((c) => c.name === name);

test("asset library reads, edits, signing and ui-config go to the server with query and body intact", async () => {
  calls.length = 0;
  const library = "/api/assets?view=library&type=image&tag=a&tag=b&limit=60&cursor=c1&facets=1";
  expect(await (await windowStub.fetch(`${origin}${library}`)).json()).toEqual({
    proxied: library,
    method: "GET",
  });
  await windowStub.fetch(`${origin}/api/assets?limit=5`);
  await windowStub.fetch(`${origin}/api/assets/a%201`);
  const patch = await windowStub.fetch(`${origin}/api/assets/a1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer r" },
    body: JSON.stringify({ caption: "c", addTags: ["x"] }),
  });
  expect(patch.status).toBe(200);
  await windowStub.fetch(`${origin}/api/assets/a1`, { method: "DELETE" });
  await windowStub.fetch(`${origin}/api/assets/sign`, {
    method: "POST",
    body: JSON.stringify({ urls: ["/assets/a1.png"] }),
  });
  await windowStub.fetch("/api/ui-config");

  const proxied = named("proxyApi").map((c) => c.params as Record<string, unknown>);
  expect(proxied.map((p) => [p.method, p.path])).toEqual([
    ["GET", library],
    ["GET", "/api/assets?limit=5"],
    ["GET", "/api/assets/a%201"],
    ["PATCH", "/api/assets/a1"],
    ["DELETE", "/api/assets/a1"],
    ["POST", "/api/assets/sign"],
    ["GET", "/api/ui-config"],
  ]);
  expect(proxied[3]).toMatchObject({
    body: JSON.stringify({ caption: "c", addTags: ["x"] }),
    headers: { "content-type": "application/json", authorization: "Bearer r" },
  });
  expect(JSON.parse(proxied[5]!.body as string)).toEqual({ urls: ["/assets/a1.png"] });
  for (const native of ["getAssets", "getAssetDetail", "deleteAsset", "uploadAsset"]) {
    expect(named(native)).toHaveLength(0);
  }
});

test("a multipart fetch upload crosses as chunks and returns the server's dedupe answer", async () => {
  calls.length = 0;
  finishAnswer = {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "a1", deduplicated: true }),
  };
  const form = new FormData();
  form.append("file", new File([new Uint8Array([9, 8, 7])], "x.png", { type: "image/png" }));
  const res = await windowStub.fetch(`${origin}/api/assets`, {
    method: "POST",
    headers: { Authorization: "Bearer r" },
    body: form,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "a1", deduplicated: true });
  const begin = named("proxyUploadBegin")[0]!.params as {
    path: string;
    headers: Record<string, string>;
  };
  expect(begin.path).toBe("/api/assets");
  expect(begin.headers["content-type"]).toStartWith("multipart/form-data; boundary=");
  expect(begin.headers.authorization).toBe("Bearer r");
  // The server parses exactly what a browser would have sent.
  const parsed = await new Response(uploaded, {
    headers: { "content-type": begin.headers["content-type"]! },
  }).formData();
  const file = parsed.get("file") as File;
  expect(file.name).toBe("x.png");
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([9, 8, 7]);
  expect(named("proxyApi")).toHaveLength(0);
});

test("the desktop bridge reports real byte progress and cancels mid-upload", async () => {
  calls.length = 0;
  finishAnswer = { status: 201, contentType: "application/json", body: '{"id":"big"}' };
  const bridge = windowStub.marinaDesktop!;
  expect(bridge).toBeDefined();
  const big = new File([new Uint8Array(1300 * 1024)], "big.bin");
  const form = new FormData();
  form.append("file", big, big.name);
  const progress: number[] = [];
  const res = await bridge.sendBody({
    url: `${origin}/api/assets`,
    method: "POST",
    body: form,
    onProgress: (f) => progress.push(f),
  });
  expect(res.status).toBe(201);
  expect(progress.length).toBe(named("proxyUploadChunk").length);
  expect(progress.length).toBeGreaterThanOrEqual(3);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect(progress.at(-1)).toBe(1);

  calls.length = 0;
  const controller = new AbortController();
  const cancelled = bridge.sendBody({
    url: `${origin}/api/assets`,
    method: "POST",
    body: form,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(named("proxyUploadChunk")).toHaveLength(1);
  expect(named("proxyUploadFinish")).toHaveLength(0);
  expect(named("proxyTransferAbort")).toEqual([{ name: "proxyTransferAbort", params: "u1" }]);
  // Only the local API is reachable through the bridge.
  await expect(
    bridge.sendBody({ url: "https://example.org/api/assets", method: "POST", body: form }),
  ).rejects.toThrow("Not a local API URL");
});

test("asset bytes come back as a blob with the server's type, inline or chunked", async () => {
  calls.length = 0;
  const small = await windowStub.fetch(`${origin}/assets/a1.png`, {
    headers: { Authorization: "Bearer r" },
  });
  expect(small.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await small.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(named("proxyDownloadBegin")[0]!.params).toEqual({
    path: "/assets/a1.png",
    headers: { authorization: "Bearer r" },
  });

  const big = await windowStub.fetch("/assets/big.mp4");
  const bytes = new Uint8Array(await (await big.blob()).arrayBuffer());
  expect(bytes.byteLength).toBe(download.byteLength);
  expect(Buffer.from(bytes).equals(Buffer.from(download))).toBe(true);
  expect(named("proxyDownloadChunk")).toHaveLength(2);

  // Writes to asset bytes are refused locally; other origins are untouched.
  expect((await windowStub.fetch(`${origin}/assets/a1.png`, { method: "PUT" })).status).toBe(405);
  expect(await (await windowStub.fetch("https://example.org/assets/a1.png")).text()).toBe(
    "external",
  );
});

test("asset events reach the dashboard socket for live invalidation", () => {
  const socket = new windowStub.WebSocket("ws://desktop.invalid/dashboard-ws");
  const received: unknown[] = [];
  socket.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
  for (const type of ["asset_created", "asset_updated", "asset_deleted"]) {
    messages.event!({ type, assetId: "a1", owner: "system", mime: "image/png" });
  }
  socket.close();
  expect(received).toEqual(
    ["asset_created", "asset_updated", "asset_deleted"].map((type) => ({
      type: "event",
      data: { type, assetId: "a1", owner: "system", mime: "image/png" },
    })),
  );
});
