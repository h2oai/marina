// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared contract for video-generation providers. Video is asynchronous: the
 * manager calls `start()`, then polls `poll(providerJobId)` until the asset is
 * ready. Reuses the image GeneratedAsset shape for the finished bytes.
 */

import type { GeneratedAsset } from "./image-util";

export interface VideoStartOptions {
  apiKey: string;
  /** Full "provider/model" string — providers strip the prefix via bareModel(). */
  model: string;
  prompt: string;
  duration?: number;
  fps?: number;
  referenceImage?: string;
  aspectRatio?: string;
  signal?: AbortSignal;
}

export interface VideoPollOptions {
  apiKey: string;
  /** Opaque provider job/operation id returned by start(). */
  providerJobId: string;
  signal?: AbortSignal;
}

export interface VideoResult {
  status: "running" | "succeeded" | "failed";
  /** Set while running so the manager can poll. */
  providerJobId?: string;
  /** 0–1 progress, when the provider reports it. */
  progress?: number;
  error?: string;
  asset?: GeneratedAsset;
}

export interface VideoProvider {
  start: (opts: VideoStartOptions) => Promise<VideoResult>;
  poll: (opts: VideoPollOptions) => Promise<VideoResult>;
}
