// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real audio waveforms for the media viewer: the file is decoded once with an
 * `OfflineAudioContext` (no audio output, no autoplay policy) and reduced to
 * `buckets` peak values in [0, 1]. Results are cached per asset path, so
 * re-opening or paging back is free. Anything that cannot be decoded — no
 * WebAudio, an unsupported codec, a file over the size cap — resolves to
 * null and the viewer shows the plain player.
 */

import { assetAuthHeaders, stripSignature } from "./asset-url";

/** Do not download more than this just to draw a waveform. */
export const WAVEFORM_MAX_BYTES = 40 * 1024 * 1024;
export const WAVEFORM_BUCKETS = 160;

const cache = new Map<string, Promise<number[] | null>>();

/** Peak amplitude per bucket across all channels, normalized so the loudest bucket is 1. */
export function computePeaks(channels: readonly Float32Array[], buckets: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || buckets <= 0) return [];
  const size = Math.max(1, Math.floor(length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    if (start >= length) break;
    const end = Math.min(length, start + size);
    let peak = 0;
    for (const data of channels) {
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i] as number);
        if (v > peak) peak = v;
      }
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks, 0);
  return max > 0 ? peaks.map((p) => p / max) : peaks;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => BaseAudioContext;

function offlineContext(): OfflineCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
}

async function decode(url: string, buckets: number): Promise<number[] | null> {
  const Ctor = offlineContext();
  if (!Ctor) return null;
  try {
    const res = await fetch(url, { headers: assetAuthHeaders(url) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > WAVEFORM_MAX_BYTES) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > WAVEFORM_MAX_BYTES) return null;
    const ctx = new Ctor(1, 1, 44_100);
    const audio = await ctx.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    return computePeaks(channels, buckets);
  } catch {
    return null;
  }
}

/** Peaks for `url` (cached by its unsigned path); null when it cannot be decoded. */
export function loadWaveform(url: string, buckets = WAVEFORM_BUCKETS): Promise<number[] | null> {
  const key = `${stripSignature(url)}#${buckets}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = decode(url, buckets);
    cache.set(key, pending);
  }
  return pending;
}
