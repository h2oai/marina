// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Video-provider registry — provider id → { start, poll }. Add a provider in one
 * line. (Note: `google` resolves to Veo here and to Imagen in the image
 * registry; the media type selects the right registry.)
 */

import { pollLumaVideoJob, startLumaVideoJob } from "./luma";
import { pollRunwayVideoJob, startRunwayVideoJob } from "./runway";
import { pollVeoVideoJob, startVeoVideoJob } from "./veo";
import type { VideoProvider } from "./video-util";

const VIDEO_PROVIDERS: Record<string, VideoProvider> = {
  runway: { start: startRunwayVideoJob, poll: pollRunwayVideoJob },
  google: { start: startVeoVideoJob, poll: pollVeoVideoJob },
  luma: { start: startLumaVideoJob, poll: pollLumaVideoJob },
};

/** The provider for a video provider id, or undefined if unsupported. */
export function getVideoProvider(provider: string): VideoProvider | undefined {
  return VIDEO_PROVIDERS[provider];
}

/** Provider ids with video generation support (for error messages / discovery). */
export function knownVideoProviders(): string[] {
  return Object.keys(VIDEO_PROVIDERS);
}
