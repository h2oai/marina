// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio player with the file's real waveform (decoded once, cached — see
 * lib/waveform.ts). The bars show playback progress and seek on click or
 * with the arrow keys (the waveform is a slider). When the file cannot be
 * decoded the native player stands alone with a short note.
 */

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../../lib/asset-library";
import { loadWaveform } from "../../lib/waveform";

export function AudioWaveform({
  src,
  title,
  durationMs,
}: {
  src: string | undefined;
  title: string;
  durationMs?: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null | undefined>(undefined);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState((durationMs ?? 0) / 1000);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setPeaks(undefined);
    void loadWaveform(src).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const seek = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.min(duration, Math.max(0, fraction * duration));
    setTime(audio.currentTime);
  };
  const progress = duration ? time / duration : 0;

  return (
    <div className="flex w-[min(720px,92%)] flex-col gap-3 rounded-md border border-border bg-bg-card p-4">
      {peaks === undefined && src && (
        <div
          role="status"
          className="h-24 animate-pulse rounded bg-bg-hover motion-reduce:animate-none"
          aria-label="Loading waveform"
        />
      )}
      {peaks && peaks.length > 0 && (
        <div
          role="slider"
          tabIndex={0}
          aria-label={`Seek in ${title}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatDuration(time * 1000)} of ${formatDuration(duration * 1000)}`}
          className="flex h-24 cursor-pointer items-center gap-px rounded outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width > 0) seek((e.clientX - rect.left) / rect.width);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              e.stopPropagation();
              const step = e.key === "ArrowRight" ? 5 : -5;
              seek(((audioRef.current?.currentTime ?? 0) + step) / (duration || 1));
            }
          }}
        >
          {peaks.map((p, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and fixed per file.
              key={i}
              className="flex-1 rounded-sm"
              style={{
                height: `${Math.max(4, p * 100)}%`,
                background:
                  i / peaks.length <= progress ? "var(--color-primary)" : "var(--color-text-dim)",
                opacity: i / peaks.length <= progress ? 1 : 0.45,
              }}
            />
          ))}
        </div>
      )}
      {peaks === null && (
        <p className="text-[11px] text-text-dim">Waveform unavailable for this file.</p>
      )}
      {src && (
        <audio
          ref={audioRef}
          src={src}
          controls
          preload="metadata"
          className="w-full"
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          }}
        >
          <track kind="captions" />
        </audio>
      )}
    </div>
  );
}
