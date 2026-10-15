// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared contract for audio providers: speech-to-text (transcription) and
 * text-to-speech (speech). Dependency-free so providers and the registry can
 * import it without a cycle.
 */

import type { GeneratedAsset } from "./image-util";

/** One timed span of a transcript, in seconds from the start of the audio. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscribeOptions {
  apiKey: string;
  /** Full `provider/model` string. */
  model: string;
  data: Uint8Array;
  /** The audio's MIME type (sets the multipart file's type and extension). */
  mime: string;
  /** Language hints (ISO-639-1). A provider that takes one uses the first. */
  languages?: string[];
  /** Context for the model (names, spellings). */
  prompt?: string;
  temperature?: number;
  /** Ask for timed segments when the model can return them. */
  segments?: boolean;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  status: "succeeded" | "failed";
  text?: string;
  /** Detected (or hinted) language, when the provider reports one. */
  language?: string;
  segments?: TranscriptSegment[];
  /** Audio duration in seconds, when the provider reports it. */
  durationSec?: number;
  /** Billed usage the provider reported (tokens or seconds), for the price. */
  usage?: { inputTokens?: number; outputTokens?: number; seconds?: number };
  error?: string;
  /** HTTP status of a provider refusal (for passthrough error mapping). */
  httpStatus?: number;
}

export type Transcriber = (opts: TranscribeOptions) => Promise<TranscribeResult>;

/** Output container formats a speech provider may be asked for. */
export const SPEECH_FORMATS = ["mp3", "wav", "opus", "aac", "flac", "pcm"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export interface SpeakOptions {
  apiKey: string;
  model: string;
  input: string;
  /** A voice name, or a provider custom-voice object (`{ id }`). */
  voice?: string | { id: string };
  format: SpeechFormat;
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
}

export interface SpeakResult {
  status: "succeeded" | "failed";
  asset: GeneratedAsset | null;
  error?: string;
  httpStatus?: number;
}

export type Speaker = (opts: SpeakOptions) => Promise<SpeakResult>;

/** The MIME type of a speech output format (`pcm` is headerless 24 kHz s16le). */
export function speechMime(format: SpeechFormat): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "opus":
      // OpenAI and Kokoro-FastAPI return Opus in an Ogg container.
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    default:
      return "audio/pcm";
  }
}

/** The file extension to name an audio upload by its MIME type (providers sniff by name). */
export function audioExtension(mime: string): string {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/mpeg": "mpeg",
  };
  return map[m] ?? "bin";
}

/**
 * Segments as seconds. LocalAI's whisper backend reports segment times in
 * nanoseconds (its own docs show 9640000000 for 9.64 s); a time past a day
 * cannot be seconds of one request's audio, so such a set is rescaled.
 */
export function normalizeSegments(raw: unknown): TranscriptSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const start = Number(r.start);
    const end = Number(r.end);
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    out.push({
      start,
      end,
      text,
      ...(typeof r.speaker === "string" && r.speaker ? { speaker: r.speaker } : {}),
    });
  }
  if (out.length === 0) return undefined;
  const nanos = out.some((s) => s.end > 86_400);
  return nanos ? out.map((s) => ({ ...s, start: s.start / 1e9, end: s.end / 1e9 })) : out;
}
