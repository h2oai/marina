// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken, setToken } from "../lib/api";
import {
  assetAuthHeaders,
  clearAssetUrlCache,
  REFRESH_MARGIN_MS,
  signablePath,
  useAssetUrl,
} from "../lib/asset-url";

/**
 * Signed asset URLs: a remote viewer with a session loads `/assets/<key>`
 * through a short-lived URL signed for it (batched, re-signed before expiry);
 * loopback, the desktop shell, sessionless pages and foreign URLs are unchanged.
 */

const REMOTE = { protocol: "https:", origin: "https://marina.example", hostname: "marina.example" };
const LOOPBACK = { protocol: "http:", origin: "http://127.0.0.1:3300", hostname: "127.0.0.1" };

describe("signablePath / assetAuthHeaders", () => {
  it("signs only this server's asset paths, for a remote viewer with a session", () => {
    expect(signablePath("/assets/a.png", REMOTE, "tok")).toBe("/assets/a.png");
    expect(signablePath("https://marina.example/assets/a.png?p=x&sig=y", REMOTE, "tok")).toBe(
      "/assets/a.png",
    );
    expect(signablePath("/assets/a.png", REMOTE, null)).toBeUndefined();
    expect(signablePath("/assets/a.png", LOOPBACK, "tok")).toBeUndefined();
    expect(signablePath("/assets/a.png", { ...REMOTE, protocol: "views:" }, "tok")).toBeUndefined();
    expect(signablePath("https://cdn.example/assets/a.png", REMOTE, "tok")).toBeUndefined();
    expect(signablePath("/api/assets/a", REMOTE, "tok")).toBeUndefined();
    expect(signablePath("", REMOTE, "tok")).toBeUndefined();
  });

  it("sends the bearer only to this server's assets", () => {
    expect(assetAuthHeaders("/assets/a.pdf", REMOTE, "tok")).toEqual({
      Authorization: "Bearer tok",
    });
    expect(assetAuthHeaders("/assets/a.pdf", LOOPBACK, "tok")).toEqual({
      Authorization: "Bearer tok",
    });
    expect(assetAuthHeaders("https://elsewhere.example/a.pdf", REMOTE, "tok")).toEqual({});
    expect(assetAuthHeaders("/assets/a.pdf", REMOTE, null)).toEqual({});
  });
});

describe("useAssetUrl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    clearAssetUrlCache();
    setToken("tok-remote");
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
      const out: Record<string, { url: string; expiresAt: number | null }> = {};
      for (const u of urls) {
        out[u] = u.includes("public")
          ? { url: u, expiresAt: null }
          : {
              url: `${u}?p=e_1&exp=${now() + 600}&sig=s${fetchMock.mock.calls.length}`,
              expiresAt: now() + 600,
            };
      }
      return new Response(JSON.stringify({ urls: out }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearToken();
    clearAssetUrlCache();
  });

  it("leaves loopback viewers unchanged and never asks the server", () => {
    const { result } = renderHook(() => useAssetUrl("/assets/a.png", LOOPBACK));
    expect(result.current).toBe("/assets/a.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a sessionless viewer and foreign URLs unchanged", () => {
    clearToken();
    expect(renderHook(() => useAssetUrl("/assets/a.png", REMOTE)).result.current).toBe(
      "/assets/a.png",
    );
    setToken("tok-remote");
    expect(renderHook(() => useAssetUrl("https://cdn.example/x.png", REMOTE)).result.current).toBe(
      "https://cdn.example/x.png",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is pending, then signed; concurrent asks share one authenticated request", async () => {
    const a = renderHook(() => useAssetUrl("/assets/a.png", REMOTE));
    const b = renderHook(() => useAssetUrl("/assets/public.png", REMOTE));
    expect(a.result.current).toBeUndefined();
    await waitFor(() => expect(a.result.current).toContain("/assets/a.png?p=e_1"));
    await waitFor(() => expect(b.result.current).toMatch(/\/assets\/public\.png$/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/assets\/sign$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-remote");
    expect(JSON.parse(String(init.body)).urls.sort()).toEqual([
      "/assets/a.png",
      "/assets/public.png",
    ]);
    // A later mount reuses the cached signature synchronously.
    const c = renderHook(() => useAssetUrl("/assets/a.png", REMOTE));
    expect(c.result.current).toBe(a.result.current);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-signs before the signature expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useAssetUrl("/assets/a.png", REMOTE));
    await waitFor(() => expect(result.current).toContain("sig="));
    const first = result.current;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000 - REFRESH_MARGIN_MS + 1_000);
    });
    await waitFor(() => expect(result.current).not.toBe(first));
    expect(result.current).toContain("sig=");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the plain URL when signing fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAssetUrl("/assets/a.png", REMOTE));
    await waitFor(() => expect(result.current).toBe("/assets/a.png"));
  });
});
