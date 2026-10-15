// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One asset upload (`POST /api/assets`, multipart `file`), with progress and
 * cancel. XHR reports upload progress in a browser; the desktop shell
 * (`views:`) routes HTTP through its native adapter, whose bridge
 * (`desktop-bridge.ts`) reports the bytes handed to the native process. Without
 * either, the upload goes through `authFetch` and reports no byte progress
 * (`uploadTracksProgress()` is false — show an indeterminate state). The
 * server answers 201 for a new asset and 200 + `deduplicated: true` when the
 * same owner already stored the same bytes.
 */

import { authFetch, getToken } from "./api";
import { apiOrigin } from "./api-origin";
import { desktopBridge, type MarinaDesktopBridge } from "./desktop-bridge";

export interface UploadedAsset {
  id: string;
  url: string;
  filename: string;
  mime_type?: string;
  size?: number;
  deduplicated?: boolean;
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** The page location (tests); defaults to `window.location`. */
  location?: Pick<Location, "protocol" | "origin">;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/** A readable reason for a failed upload response. */
export function uploadErrorMessage(status: number, body: unknown, maxBytes?: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 413) {
    return typeof error === "string"
      ? error
      : `File too large${maxBytes ? ` (max ${formatMb(maxBytes)})` : ""}.`;
  }
  if (status === 401) return "Sign in to upload.";
  if (status === 429) return "Too many uploads — try again in a moment.";
  if (typeof error === "string" && error) return error;
  return status === 0 ? "Network error." : `Upload failed (${status}).`;
}

export function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether `uploadAsset` reports byte progress on this page (else: indeterminate). */
export function uploadTracksProgress(
  location: Pick<Location, "protocol"> = window.location,
): boolean {
  if (location.protocol === "views:") return !!desktopBridge(location);
  return typeof XMLHttpRequest !== "undefined";
}

export function uploadAsset(file: File, opts: UploadOptions = {}): Promise<UploadedAsset> {
  const location = opts.location ?? window.location;
  const url = `${apiOrigin(location)}/api/assets`;
  const form = new FormData();
  form.append("file", file, file.name);
  if (location.protocol === "views:") {
    const bridge = desktopBridge(location);
    return bridge ? uploadWithBridge(bridge, url, form, opts) : uploadWithFetch(url, form, opts);
  }
  if (typeof XMLHttpRequest === "undefined") return uploadWithFetch(url, form, opts);
  return new Promise<UploadedAsset>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new UploadError("Cancelled.", 0, true));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === "object") {
        opts.onProgress?.(1);
        resolve(body as UploadedAsset);
      } else {
        reject(new UploadError(uploadErrorMessage(xhr.status, body), xhr.status));
      }
    };
    xhr.onerror = () => reject(new UploadError(uploadErrorMessage(0, null), 0));
    xhr.onabort = () => reject(new UploadError("Cancelled.", 0, true));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

function uploadWithFetch(url: string, form: FormData, opts: UploadOptions): Promise<UploadedAsset> {
  return settle(() => authFetch(url, { method: "POST", body: form, signal: opts.signal }), opts);
}

/** The desktop shell's native upload: real byte progress and cancel. */
function uploadWithBridge(
  bridge: MarinaDesktopBridge,
  url: string,
  form: FormData,
  opts: UploadOptions,
): Promise<UploadedAsset> {
  const token = getToken();
  return settle(
    () =>
      bridge.sendBody({
        url,
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
        onProgress: opts.onProgress,
        signal: opts.signal,
      }),
    opts,
  );
}

async function settle(send: () => Promise<Response>, opts: UploadOptions): Promise<UploadedAsset> {
  if (opts.signal?.aborted) throw new UploadError("Cancelled.", 0, true);
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    if (opts.signal?.aborted) throw new UploadError("Cancelled.", 0, true);
    throw new UploadError(err instanceof Error ? err.message : "Network error.", 0);
  }
  const body = parse(await res.text());
  if (!res.ok || !body || typeof body !== "object") {
    throw new UploadError(uploadErrorMessage(res.status, body), res.status);
  }
  opts.onProgress?.(1);
  return body as UploadedAsset;
}

/** Files on a clipboard paste (pasted screenshots get a timestamped name). */
export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (!file.name || file.name === "image.png") {
      const ext = (file.type.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      files.push(new File([file], `pasted-${stamp}.${ext}`, { type: file.type }));
    } else files.push(file);
  }
  if (files.length === 0 && data.files?.length) files.push(...Array.from(data.files));
  return files;
}
