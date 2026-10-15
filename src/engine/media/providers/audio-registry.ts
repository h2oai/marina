// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio-provider registry: speech-to-text and text-to-speech by provider id.
 *   1. built-in `openai` (OPENAI_API_KEY)
 *   2. any OpenAI-compatible server configured via `<PROVIDER>_AUDIO_BASE_URL`
 *      (key-optional — local whisper / Kokoro / Piper servers are often keyless)
 *
 * Prices are OpenAI's published rates (https://developers.openai.com/api/docs/pricing,
 * checked 2026-10-15); a configured endpoint has no known price and is never
 * charged to the spend ledger.
 */

import type { Speaker, Transcriber } from "./audio-util";
import {
  isOpenAISpeechModel,
  isOpenAITranscribeModel,
  OPENAI_SPEECH_MAX_CHARS,
  OPENAI_TRANSCRIBE_MAX_BYTES,
  speakOpenAI,
  transcribeOpenAI,
} from "./openai-audio";
import {
  audioEndpointBaseUrl,
  configuredAudioEndpoints,
  speakOpenAICompatible,
  transcribeOpenAICompatible,
} from "./openai-compatible-audio";

/** Transcription model when none is named and OpenAI is configured. */
export const DEFAULT_TRANSCRIBE_MODEL = "openai/gpt-transcribe";
/** Speech model when none is named and OpenAI is configured. */
export const DEFAULT_SPEECH_MODEL = "openai/gpt-4o-mini-tts";
/** OpenAI's recommended voice for best quality ("marin or cedar"). */
export const DEFAULT_OPENAI_VOICE = "marin";

export interface AudioProvider {
  transcribe: Transcriber;
  speak: Speaker;
  /** Largest upload one transcription request takes (bytes); undefined = no known limit. */
  maxUploadBytes?: number;
  /** Longest text one speech request takes (characters); undefined = no known limit. */
  maxSpeechChars?: number;
  requiresKey: boolean;
}

const OPENAI: AudioProvider = {
  transcribe: transcribeOpenAI,
  speak: speakOpenAI,
  maxUploadBytes: OPENAI_TRANSCRIBE_MAX_BYTES,
  maxSpeechChars: OPENAI_SPEECH_MAX_CHARS,
  requiresKey: true,
};

const COMPATIBLE: AudioProvider = {
  transcribe: transcribeOpenAICompatible,
  speak: speakOpenAICompatible,
  requiresKey: false,
};

/** The provider part of `provider/model` (lower-cased), or "" for a bare id. */
export function audioProviderOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash).toLowerCase() : "";
}

/** The audio provider for an id, or undefined when it is neither built in nor configured. */
export function getAudioProvider(provider: string): AudioProvider | undefined {
  if (provider === "openai") return OPENAI;
  if (audioEndpointBaseUrl(provider)) return COMPATIBLE;
  return undefined;
}

export function knownAudioProviders(): string[] {
  return ["openai", ...configuredAudioEndpoints(), "<custom via *_AUDIO_BASE_URL>"];
}

/**
 * A model id as a request names it → `provider/model`. A bare OpenAI audio id
 * (what an OpenAI SDK sends, e.g. `gpt-4o-mini-tts`) is OpenAI's; any other
 * bare id is undefined (name the provider).
 */
export function qualifyAudioModel(
  model: string,
  kind: "transcribe" | "speech",
): string | undefined {
  const m = model.trim();
  if (!m) return undefined;
  if (audioProviderOf(m)) return m;
  const openai = kind === "transcribe" ? isOpenAITranscribeModel(m) : isOpenAISpeechModel(m);
  return openai ? `openai/${m}` : undefined;
}

type Env = Record<string, string | undefined>;

/**
 * The model for a request that names none: `MARINA_TRANSCRIBE_MODEL` /
 * `MARINA_SPEECH_MODEL` when set; else OpenAI's default when an OpenAI key
 * exists; else the first configured `<PROVIDER>_AUDIO_BASE_URL` server with
 * the OpenAI-compatible alias most local servers map (`whisper-1`, `tts-1` —
 * LocalAI's images, Kokoro-FastAPI); else OpenAI's default (which then reports
 * the missing key).
 */
export function defaultAudioModel(
  kind: "transcribe" | "speech",
  hasOpenAIKey: boolean,
  env: Env = process.env,
): string {
  const pinned = (
    kind === "transcribe" ? env.MARINA_TRANSCRIBE_MODEL : env.MARINA_SPEECH_MODEL
  )?.trim();
  if (pinned) return qualifyAudioModel(pinned, kind) ?? pinned;
  const fallback = kind === "transcribe" ? DEFAULT_TRANSCRIBE_MODEL : DEFAULT_SPEECH_MODEL;
  if (hasOpenAIKey) return fallback;
  const local = configuredAudioEndpoints(env).find((p) => p !== "openai");
  if (local) return `${local}/${kind === "transcribe" ? "whisper-1" : "tts-1"}`;
  return fallback;
}

/** The voice for a speech request that names none. */
export function defaultVoice(model: string, env: Env = process.env): string | undefined {
  const pinned = env.MARINA_SPEECH_VOICE?.trim();
  if (pinned) return pinned;
  return audioProviderOf(model) === "openai" ? DEFAULT_OPENAI_VOICE : undefined;
}

/** Whether this installation can transcribe / speak (an OpenAI key or a configured server). */
export function audioAvailable(opts: {
  configured: boolean;
  hasKey: (provider: string) => boolean;
  env?: Env;
}): { transcribe: boolean; speak: boolean } {
  if (!opts.configured) return { transcribe: false, speak: false };
  const any = opts.hasKey("openai") || configuredAudioEndpoints(opts.env).length > 0;
  return { transcribe: any, speak: any };
}

// ─── Prices ──────────────────────────────────────────────────────────────────

/** OpenAI transcription, USD per audio minute (published estimates). */
const TRANSCRIBE_USD_PER_MIN: Record<string, number> = {
  "gpt-transcribe": 0.0045,
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003,
  "gpt-4o-transcribe-diarize": 0.006,
  "whisper-1": 0.006,
};

/**
 * The price of transcribing `seconds` of audio with `model`, or null when the
 * model has no known price (a configured endpoint). An unlisted OpenAI id is
 * priced at the highest listed rate so a new model is never free.
 */
export function transcriptionPriceUsd(model: string, seconds: number): number | null {
  if (audioProviderOf(model) !== "openai") return null;
  const id = model.slice(model.indexOf("/") + 1).toLowerCase();
  const rate =
    TRANSCRIBE_USD_PER_MIN[id] ??
    Object.entries(TRANSCRIBE_USD_PER_MIN).find(([k]) => id.startsWith(`${k}-`))?.[1] ??
    Math.max(...Object.values(TRANSCRIBE_USD_PER_MIN));
  return Number(((Math.max(0, seconds) / 60) * rate).toFixed(6));
}

/**
 * The price of speaking `chars` characters (about `seconds` of audio):
 *  - `tts-1` $15 and `tts-1-hd` $30 per 1M characters;
 *  - `gpt-4o-mini-tts` $0.60 per 1M text tokens (≈ chars / 4) plus audio
 *    output at $12 per 1M tokens, estimated at OpenAI's earlier published
 *    ≈ $0.015 per minute of speech (the reply carries no usage).
 * Null for a configured endpoint. An unlisted OpenAI id is priced like
 * `gpt-4o-mini-tts`.
 */
export function speechPriceUsd(model: string, chars: number, seconds: number): number | null {
  if (audioProviderOf(model) !== "openai") return null;
  const id = model.slice(model.indexOf("/") + 1).toLowerCase();
  if (id === "tts-1") return Number(((chars / 1e6) * 15).toFixed(6));
  if (id === "tts-1-hd") return Number(((chars / 1e6) * 30).toFixed(6));
  const text = (Math.ceil(chars / 4) / 1e6) * 0.6;
  const audio = (Math.max(0, seconds) / 60) * 0.015;
  return Number((text + audio).toFixed(6));
}

/** Speech runs about 15 characters per second (150 words a minute); used when no probe is available. */
export function estimateSpeechSeconds(chars: number): number {
  return chars / 15;
}
