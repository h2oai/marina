// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI audio: transcription (`POST /v1/audio/transcriptions`, multipart) and
 * speech (`POST /v1/audio/speech`, JSON → audio bytes). Per OpenAI's current
 * guides and reference (checked 2026-10-15):
 * https://developers.openai.com/api/docs/guides/speech-to-text,
 * https://developers.openai.com/api/docs/guides/text-to-speech,
 * https://developers.openai.com/api/reference/resources/audio
 *
 * Transcription
 * - `gpt-transcribe` is the recommended file model: language hints go as
 *   `languages[]` (it replaces the singular `language` — never send both); the
 *   JSON reply carries `text` and `languages: [{ code }]`.
 * - `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` take one `language` and
 *   reply `json` (`text` + `usage`).
 * - `gpt-4o-transcribe-diarize` replies `diarized_json` (segments with
 *   `speaker`, `start`, `end`, `text`), needs `chunking_strategy` for audio
 *   over 30 s, and takes no `prompt`.
 * - `whisper-1` replies `verbose_json` with `segment` timestamps.
 * - Files up to 25 MB; mp3, mp4, mpeg, mpga, m4a, wav, webm.
 *
 * Speech
 * - Models `gpt-4o-mini-tts` (recommended; `instructions` steer the voice),
 *   `tts-1`, `tts-1-hd`; `input` up to 4096 characters; voices alloy, ash,
 *   ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
 *   (tts-1/-hd take a smaller set) or a custom voice `{ id }`; formats mp3
 *   (default), opus, aac, flac, wav, pcm; `speed` 0.25–4.
 */

import { guardedFetch } from "../../../net/url-guard";
import {
  audioExtension,
  normalizeSegments,
  type SpeakOptions,
  type SpeakResult,
  speechMime,
  type TranscribeOptions,
  type TranscribeResult,
} from "./audio-util";
import { bareModel } from "./image-util";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

/** OpenAI's per-file upload limit for transcription. */
export const OPENAI_TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
/** OpenAI's `input` limit for speech. */
export const OPENAI_SPEECH_MAX_CHARS = 4096;

/** The subset `tts-1` / `tts-1-hd` support. */
const LEGACY_TTS_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
]);

/** How a bare OpenAI transcription model id is asked. */
export type OpenAITranscribeKind = "languages" | "json" | "diarize" | "verbose";
export function openAITranscribeKind(model: string): OpenAITranscribeKind {
  const id = model.toLowerCase();
  if (id === "whisper-1") return "verbose";
  if (id.includes("diarize")) return "diarize";
  if (/^gpt-transcribe([.-]|$)/.test(id)) return "languages";
  return "json";
}

/** True for a bare id OpenAI serves on `/v1/audio/transcriptions`. */
export function isOpenAITranscribeModel(model: string): boolean {
  return /^(whisper-1|gpt-transcribe|gpt-[\w.-]*transcribe)/i.test(model);
}

/** True for a bare id OpenAI serves on `/v1/audio/speech`. */
export function isOpenAISpeechModel(model: string): boolean {
  return /^(tts-1|gpt-[\w.-]*tts)/i.test(model);
}

/** The multipart body for one transcription request (exported for tests). */
export function buildOpenAITranscriptionForm(opts: TranscribeOptions): FormData | string {
  const model = bareModel(opts.model);
  const kind = openAITranscribeKind(model);
  if (kind === "diarize" && opts.prompt) {
    return `${model} does not take a prompt; omit it or use another transcription model.`;
  }
  const form = new FormData();
  const ext = audioExtension(opts.mime);
  form.append(
    "file",
    new File([opts.data as Uint8Array<ArrayBuffer>], `audio.${ext}`, {
      type: opts.mime || "application/octet-stream",
    }),
  );
  form.append("model", model);
  const langs = (opts.languages ?? []).filter(Boolean);
  if (kind === "languages") {
    for (const l of langs) form.append("languages[]", l);
  } else if (langs.length > 0) {
    if (langs.length > 1) return `${model} takes one language hint; got ${langs.join(", ")}.`;
    form.append("language", langs[0]!);
  }
  if (opts.prompt && kind !== "diarize") form.append("prompt", opts.prompt);
  if (typeof opts.temperature === "number") form.append("temperature", String(opts.temperature));
  if (kind === "verbose") {
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
  } else if (kind === "diarize") {
    form.append("response_format", "diarized_json");
    form.append("chunking_strategy", "auto");
  } else {
    form.append("response_format", "json");
  }
  return form;
}

/** Read an OpenAI-shaped transcription reply (json, verbose_json, diarized_json). */
export function parseTranscriptionReply(json: unknown): TranscribeResult {
  if (!json || typeof json !== "object") {
    return { status: "failed", error: "Transcription reply was not JSON." };
  }
  const r = json as Record<string, unknown>;
  if (typeof r.text !== "string") {
    return { status: "failed", error: "Transcription reply had no text." };
  }
  const langs = Array.isArray(r.languages) ? (r.languages as Array<{ code?: unknown }>) : [];
  const language =
    typeof r.language === "string" && r.language
      ? r.language
      : typeof langs[0]?.code === "string"
        ? (langs[0].code as string)
        : undefined;
  const usage = r.usage && typeof r.usage === "object" ? (r.usage as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const duration = num(r.duration) ?? num(usage.seconds);
  const segments = normalizeSegments(r.segments);
  const u = {
    ...(num(usage.input_tokens) !== undefined ? { inputTokens: num(usage.input_tokens) } : {}),
    ...(num(usage.output_tokens) !== undefined ? { outputTokens: num(usage.output_tokens) } : {}),
    ...(num(usage.seconds) !== undefined ? { seconds: num(usage.seconds) } : {}),
  };
  return {
    status: "succeeded",
    text: r.text.trim(),
    ...(language ? { language } : {}),
    ...(segments ? { segments } : {}),
    ...(duration !== undefined ? { durationSec: duration } : {}),
    ...(Object.keys(u).length ? { usage: u } : {}),
  };
}

/** An upstream error body's message, else its text (bounded). */
async function upstreamError(res: Response, label: string): Promise<string> {
  // allow-empty-catch: the error body is optional detail; the status is reported regardless
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return `${label} failed: ${res.status} ${parsed.error.message}`;
  } catch {
    // allow-empty-catch: a non-JSON error body is reported as text
  }
  return `${label} failed: ${res.status} ${text}`;
}

export async function transcribeOpenAI(opts: TranscribeOptions): Promise<TranscribeResult> {
  const form = buildOpenAITranscriptionForm(opts);
  if (typeof form === "string") return { status: "failed", error: form, httpStatus: 400 };
  try {
    const res = await guardedFetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        error: await upstreamError(res, "OpenAI transcription"),
        httpStatus: res.status,
      };
    }
    return parseTranscriptionReply(await res.json());
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The JSON body for one speech request (exported for tests), or why it is refused. */
export function buildOpenAISpeechBody(opts: SpeakOptions): Record<string, unknown> | string {
  const model = bareModel(opts.model);
  const legacy = /^tts-1/i.test(model);
  if (opts.input.length > OPENAI_SPEECH_MAX_CHARS) {
    return `Text is ${opts.input.length} characters; OpenAI speech takes at most ${OPENAI_SPEECH_MAX_CHARS}.`;
  }
  const voice = opts.voice ?? "marin";
  if (typeof voice === "string" && legacy && !LEGACY_TTS_VOICES.has(voice)) {
    return `${model} does not offer voice "${voice}"; use one of ${[...LEGACY_TTS_VOICES].join(", ")}.`;
  }
  if (legacy && opts.instructions) {
    return `${model} does not take instructions; use gpt-4o-mini-tts.`;
  }
  return {
    model,
    input: opts.input,
    voice,
    response_format: opts.format,
    ...(typeof opts.speed === "number" ? { speed: opts.speed } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  };
}

export async function speakOpenAI(opts: SpeakOptions): Promise<SpeakResult> {
  const body = buildOpenAISpeechBody(opts);
  if (typeof body === "string")
    return { status: "failed", asset: null, error: body, httpStatus: 400 };
  try {
    const res = await guardedFetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        asset: null,
        error: await upstreamError(res, "OpenAI speech"),
        httpStatus: res.status,
      };
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength === 0)
      return { status: "failed", asset: null, error: "No audio returned." };
    return {
      status: "succeeded",
      asset: {
        data,
        mimeType: speechMime(opts.format),
        filename: `speech-${Date.now()}.${opts.format}`,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      asset: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
