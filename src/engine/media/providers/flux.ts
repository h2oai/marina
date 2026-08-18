// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Flux image generation (Black Forest Labs native API). Models:
 * `flux/flux-pro-1.1`, `flux/flux-dev`, `flux/flux-pro-1.1-ultra`, … Key:
 * BFL_API_KEY (header `x-key`); base override `BFL_BASE_URL`.
 *
 * BFL is submit-then-poll, but image jobs use a synchronous generate() contract,
 * so we poll internally (respecting the abort signal) and return when the image
 * is ready — quick for Flux, and bounded by the manager's per-job timeout.
 */

import { Buffer } from "node:buffer";
import { bareModel, type ImageGenOptions, type ImageGenResult } from "./image-util";

const DEFAULT_BASE = "https://api.bfl.ml";
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 40;

function baseUrl(): string {
  return (process.env.BFL_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

function clampDimension(dim?: number): number {
  if (!dim || !Number.isFinite(dim)) return 1024;
  // BFL requires multiples of 32 in [256, 1440].
  const rounded = Math.round(dim / 32) * 32;
  return Math.min(Math.max(rounded, 256), 1440);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateFluxImage(opts: ImageGenOptions): Promise<ImageGenResult> {
  const key = opts.apiKey || process.env.BFL_API_KEY;
  if (!key) return { status: "failed", asset: null, error: "BFL_API_KEY is not set." };
  const bare = bareModel(opts.model);
  const model = bare && bare !== "flux" ? bare : "flux-pro-1.1";
  const base = baseUrl();
  const headers = { "Content-Type": "application/json", accept: "application/json", "x-key": key };

  try {
    const submit = await fetch(`${base}/v1/${model}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: opts.prompt,
        width: clampDimension(opts.width),
        height: clampDimension(opts.height),
      }),
      signal: opts.signal,
    });
    const submitJson = (await submit.json()) as { id?: string; detail?: string };
    if (!submit.ok || !submitJson.id) {
      return {
        status: "failed",
        asset: null,
        error: submitJson.detail ?? `Flux submit failed (${submit.status})`,
      };
    }

    for (let i = 0; i < MAX_POLLS; i++) {
      if (opts.signal?.aborted)
        return { status: "failed", asset: null, error: "Flux job aborted." };
      const res = await fetch(`${base}/v1/get_result?id=${encodeURIComponent(submitJson.id)}`, {
        headers,
        signal: opts.signal,
      });
      const json = (await res.json()) as { status?: string; result?: { sample?: string } };
      if (!res.ok) {
        return { status: "failed", asset: null, error: `Flux poll failed (${res.status})` };
      }
      if (json.status === "Ready") {
        const url = json.result?.sample;
        if (!url) return { status: "failed", asset: null, error: "Flux ready without a sample." };
        const dl = await fetch(url, { signal: opts.signal });
        if (!dl.ok) {
          return {
            status: "failed",
            asset: null,
            error: `Flux sample download failed (${dl.status})`,
          };
        }
        const mimeType = dl.headers.get("content-type") ?? "image/jpeg";
        const ext = mimeType.includes("png") ? "png" : "jpg";
        return {
          status: "succeeded",
          asset: {
            data: new Uint8Array(Buffer.from(await dl.arrayBuffer())),
            mimeType,
            filename: `image-${Date.now()}.${ext}`,
          },
        };
      }
      if (json.status && json.status !== "Pending") {
        return { status: "failed", asset: null, error: `Flux: ${json.status}` };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { status: "failed", asset: null, error: "Flux timed out waiting for the image." };
  } catch (error) {
    return {
      status: "failed",
      asset: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
