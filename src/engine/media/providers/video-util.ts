// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared contract for video-generation providers. Video is asynchronous: the
 * manager calls `start()`, then polls `poll(providerJobId)` until the asset is
 * ready. Reuses the image GeneratedAsset shape for the finished bytes.
 */

import type { GeneratedAsset } from "./image-util";

/**
 * Built-in video model when a request names none: Runway's `gen4.5` (text- and
 * image-to-video on Runway's developer API, https://docs.dev.runwayml.com/api/).
 */
export const DEFAULT_VIDEO_MODEL = "runway/gen4.5";

export interface VideoStartOptions {
  apiKey: string;
  /** Full "provider/model" string — providers strip the prefix via bareModel(). */
  model: string;
  prompt: string;
  duration?: number;
  /** Requested frame rate. No current provider API takes one; providers ignore it. */
  fps?: number;
  /**
   * First-frame image, already resolved by the manager: an `https://` URL or a
   * `data:image/…;base64,` URI — never a Marina asset id.
   */
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
  /**
   * With `status: "running"`: this poll hit a transient failure (network,
   * throttle, server error, a paid output that failed to download). The job
   * stays running and is polled again; its overall deadline bounds retries.
   */
  retryable?: boolean;
  /** The provider's own final charge in USD, when it reports one (recorded instead of the estimate). */
  costUsd?: number;
  asset?: GeneratedAsset;
}

export interface VideoProvider {
  start: (opts: VideoStartOptions) => Promise<VideoResult>;
  poll: (opts: VideoPollOptions) => Promise<VideoResult>;
}
