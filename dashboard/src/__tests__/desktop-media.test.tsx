// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadTray } from "../components/media/UploadControls";
import { resetUiConfigForTests, useUploads } from "../hooks/use-uploads";
import { clearToken, setToken } from "../lib/api";
import {
  clearAssetUrlCache,
  DESKTOP_BLOB_CACHE_SIZE,
  desktopAssetPath,
  resolveAssetUrl,
  useAssetUrl,
  useSignedAssetUrl,
} from "../lib/asset-url";
import type { DesktopBodyRequest } from "../lib/desktop-bridge";
import { uploadAsset, uploadTracksProgress } from "../lib/upload";

/**
 * The desktop shell (`views:`): asset bytes are read through the native
 * adapter into blob URLs (never signed — the operator credential never travels
 * as a URL), and uploads use the shell's bridge for real byte progress, or an
 * honest indeterminate state without it.
 */

const DESKTOP = { protocol: "views:", origin: "null", hostname: "" };
const ORIGIN = "http://marina.desktop.invalid";

let fetchMock: ReturnType<typeof vi.fn>;
let blobs: number;
let revoked: string[];

beforeEach(() => {
  clearAssetUrlCache();
  clearToken();
  resetUiConfigForTests();
  blobs = 0;
  revoked = [];
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/ui-config")) return Response.json({ maxUploadBytes: 5000 });
    if (String(url).includes("/missing")) return new Response("Not found", { status: 404 });
    // Bytes, not a jsdom Blob: Node 22's Response streams a Blob body via Blob.stream(),
    // which jsdom's Blob lacks.
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:views://dashboard/${++blobs}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => {
    revoked.push(u);
  });
});

afterEach(() => {
  clearAssetUrlCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.marinaDesktop;
  localStorage.clear();
});

describe("desktop asset bytes", () => {
  it("recognises only this server's /assets/<key> on the desktop shell", () => {
    expect(desktopAssetPath("/assets/a.png", DESKTOP)).toBe("/assets/a.png");
    expect(desktopAssetPath(`${ORIGIN}/assets/a.png?p=x&exp=1&sig=y`, DESKTOP)).toBe(
      "/assets/a.png",
    );
    expect(desktopAssetPath("https://cdn.example/assets/a.png", DESKTOP)).toBeUndefined();
    expect(desktopAssetPath("blob:views://dashboard/1", DESKTOP)).toBeUndefined();
    expect(desktopAssetPath("/api/assets/a", DESKTOP)).toBeUndefined();
    expect(
      desktopAssetPath("/assets/a.png", { protocol: "https:", origin: "https://m.example" }),
    ).toBeUndefined();
  });

  it("loads bytes through the adapter under the viewer's credential, once per asset, never signing", async () => {
    setToken("tok-resident");
    const { result } = renderHook(() => useAssetUrl("/assets/a.png", DESKTOP));
    // Nothing until the bytes are read (no doomed views:// request).
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe("blob:views://dashboard/1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/assets/a.png`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-resident" });

    // Cached: a second element, a signed spelling and resolveAssetUrl reuse it.
    const again = renderHook(() =>
      useSignedAssetUrl("/assets/a.png?p=x&exp=99999999999&sig=y", 99999999999, DESKTOP),
    );
    await waitFor(() => expect(again.result.current).toBe("blob:views://dashboard/1"));
    expect(await resolveAssetUrl("/assets/a.png", DESKTOP)).toBe("blob:views://dashboard/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/assets/sign"))).toBe(false);
  });

  it("falls back to the plain path when the read fails, and retries later", async () => {
    expect(await resolveAssetUrl("/assets/missing.png", DESKTOP)).toBe("/assets/missing.png");
    expect(await resolveAssetUrl("/assets/missing.png", DESKTOP)).toBe("/assets/missing.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps foreign URLs as given and bounds the blob cache, revoking the oldest", async () => {
    const { result } = renderHook(() => useAssetUrl("https://cdn.example/x.png", DESKTOP));
    expect(result.current).toBe("https://cdn.example/x.png");
    for (let i = 0; i <= DESKTOP_BLOB_CACHE_SIZE; i++) {
      await resolveAssetUrl(`/assets/${i}.png`, DESKTOP);
    }
    expect(revoked).toEqual(["blob:views://dashboard/1"]);
    clearAssetUrlCache();
    await waitFor(() => expect(revoked).toHaveLength(DESKTOP_BLOB_CACHE_SIZE + 1));
  });
});

describe("desktop uploads", () => {
  const png = () => new File([new Uint8Array(10)], "a.png", { type: "image/png" });

  it("uses the shell bridge: real progress, the session bearer and the dedupe answer", async () => {
    setToken("tok-resident");
    const sendBody = vi.fn(async (req: DesktopBodyRequest) => {
      req.onProgress?.(0.5);
      req.onProgress?.(1);
      return Response.json({ id: "a1", url: "/assets/a1.png", deduplicated: true });
    });
    window.marinaDesktop = { sendBody };
    expect(uploadTracksProgress(DESKTOP)).toBe(true);
    const progress: number[] = [];
    const asset = await uploadAsset(png(), {
      location: DESKTOP,
      onProgress: (f) => progress.push(f),
    });
    expect(asset).toMatchObject({ id: "a1", deduplicated: true });
    expect(progress).toEqual([0.5, 1, 1]);
    const req = sendBody.mock.calls[0]![0];
    expect(req).toMatchObject({
      url: `${ORIGIN}/api/assets`,
      method: "POST",
      headers: { Authorization: "Bearer tok-resident" },
    });
    expect((req.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("surfaces bridge errors and cancellation like any upload", async () => {
    window.marinaDesktop = {
      sendBody: async () =>
        Response.json({ error: "File too large. Maximum 0MB." }, { status: 413 }),
    };
    await expect(uploadAsset(png(), { location: DESKTOP })).rejects.toMatchObject({
      status: 413,
      message: "File too large. Maximum 0MB.",
    });
    const controller = new AbortController();
    window.marinaDesktop = {
      sendBody: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    };
    await expect(
      uploadAsset(png(), { location: DESKTOP, signal: controller.signal }),
    ).rejects.toMatchObject({ cancelled: true });
  });

  it("without the bridge, uploads through fetch and shows an indeterminate state, not a fake percentage", async () => {
    expect(uploadTracksProgress(DESKTOP)).toBe(false);
    let finish: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/ui-config")) return Response.json({ maxUploadBytes: 5000 });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const { result } = renderHook(() => useUploads({ maxBytes: 5000, location: DESKTOP }));
    act(() => {
      result.current.upload([png()]);
    });
    await waitFor(() =>
      expect(result.current.entries[0]).toMatchObject({
        status: "uploading",
        indeterminate: true,
        progress: 0,
      }),
    );
    const upload = fetchMock.mock.calls.find(([u]) => String(u) === `${ORIGIN}/api/assets`);
    expect((upload![1] as RequestInit).body).toBeInstanceOf(FormData);

    render(
      <UploadTray entries={result.current.entries} onCancel={() => {}} onDismiss={() => {}} />,
    );
    const bar = screen.getByRole("progressbar", { name: "Uploading a.png" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuetext")).toMatch(/progress unavailable/);

    act(() => finish(Response.json({ id: "a1", url: "/assets/a1.png" }, { status: 201 })));
    await waitFor(() =>
      expect(result.current.entries[0]).toMatchObject({ status: "done", indeterminate: false }),
    );
  });

  it("with the bridge, the queue shows determinate progress", async () => {
    let report: (f: number) => void = () => {};
    let finish: (r: Response) => void = () => {};
    window.marinaDesktop = {
      sendBody: (req) =>
        new Promise<Response>((resolve) => {
          report = (f) => req.onProgress?.(f);
          finish = resolve;
        }),
    };
    const { result } = renderHook(() => useUploads({ maxBytes: 5000, location: DESKTOP }));
    act(() => {
      result.current.upload([png()]);
    });
    await waitFor(() =>
      expect(result.current.entries[0]).toMatchObject({
        status: "uploading",
        indeterminate: false,
      }),
    );
    act(() => report(0.25));
    expect(result.current.entries[0]?.progress).toBe(0.25);
    act(() => finish(Response.json({ id: "a1", url: "/assets/a1.png" }, { status: 201 })));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("done"));
  });
});
