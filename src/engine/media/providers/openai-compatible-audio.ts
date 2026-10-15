// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Any OpenAI-compatible audio server, configured by the operator with
 * `<PROVIDER>_AUDIO_BASE_URL` (+ optional `<PROVIDER>_API_KEY`) and addressed
 * as `<provider>/<model>`: LocalAI (`/v1/audio/transcriptions`,
 * `/v1/audio/speech`), speaches (faster-whisper STT; Kokoro/Piper TTS),
 * Kokoro-FastAPI (`/v1/audio/speech`, default `http://localhost:8880/v1`),
 * whisper.cpp's server started with `--inference-path /v1/audio/transcriptions`.
 *
 * The base URL is operator configuration (often loopback), so — like the
 * image endpoints — it is fetched directly, not through the SSRF guard that
 * protects caller-supplied URLs. Keyless unless the server requires a key.
 */

import {
  audioExtension,
  type SpeakOptions,
  type SpeakResult,
  speechMime,
  type TranscribeOptions,
  type TranscribeResult,
} from "./audio-util";
import { bareModel } from "./image-util";
import { parseTranscriptionReply } from "./openai-audio";

function envPrefix(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(0, slash) : model;
}

/** `<PROVIDER>_AUDIO_BASE_URL` for a provider id (trailing slashes trimmed), or undefined. */
export function audioEndpointBaseUrl(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[`${envPrefix(provider)}_AUDIO_BASE_URL`]?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/** Providers with an audio endpoint configured (lower-cased ids). */
export function configuredAudioEndpoints(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /^[A-Z0-9_]+_AUDIO_BASE_URL$/.test(key) && !!value?.trim())
    .map(([key]) => key.slice(0, -"_AUDIO_BASE_URL".length).toLowerCase())
    .sort();
}

function headersFor(provider: string, fallbackKey: string): Record<string, string> {
  const key = process.env[`${envPrefix(provider)}_API_KEY`] ?? fallbackKey;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function missing(provider: string): string {
  return `No audio endpoint for "${provider}" — set ${envPrefix(provider)}_AUDIO_BASE_URL.`;
}

function form(opts: TranscribeOptions, verbose: boolean): FormData {
  const f = new FormData();
  f.append(
    "file",
    new File([opts.data as Uint8Array<ArrayBuffer>], `audio.${audioExtension(opts.mime)}`, {
      type: opts.mime || "application/octet-stream",
    }),
  );
  f.append("model", bareModel(opts.model));
  const lang = opts.languages?.find(Boolean);
  if (lang) f.append("language", lang);
  if (opts.prompt) f.append("prompt", opts.prompt);
  if (typeof opts.temperature === "number") f.append("temperature", String(opts.temperature));
  if (verbose) {
    f.append("response_format", "verbose_json");
    f.append("timestamp_granularities[]", "segment");
  } else {
    f.append("response_format", "json");
  }
  return f;
}

/**
 * Transcribe through the configured server. Asks `verbose_json` (segments)
 * first; a server that refuses it with a 400/422 is asked once more for plain
 * `json`.
 */
export async function transcribeOpenAICompatible(
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const provider = providerOf(opts.model);
  const base = audioEndpointBaseUrl(provider);
  if (!base) return { status: "failed", error: missing(provider) };
  const send = (verbose: boolean) =>
    fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: headersFor(provider, opts.apiKey),
      body: form(opts, verbose),
      signal: opts.signal,
    });
  try {
    let res = await send(opts.segments !== false);
    if (!res.ok && (res.status === 400 || res.status === 422) && opts.segments !== false) {
      res = await send(false);
    }
    if (!res.ok) {
      return {
        status: "failed",
        error: `Transcription request to ${provider} failed: ${res.status} ${(await res.text()).slice(0, 2000)}`,
        httpStatus: res.status,
      };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      // A server that answers plain text despite the requested format.
      const text = (await res.text()).trim();
      return text
        ? { status: "succeeded", text }
        : { status: "failed", error: "Transcription reply had no text." };
    }
    return parseTranscriptionReply(await res.json());
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function speakOpenAICompatible(opts: SpeakOptions): Promise<SpeakResult> {
  const provider = providerOf(opts.model);
  const base = audioEndpointBaseUrl(provider);
  if (!base) return { status: "failed", asset: null, error: missing(provider) };
  try {
    const res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headersFor(provider, opts.apiKey) },
      body: JSON.stringify({
        model: bareModel(opts.model),
        input: opts.input,
        ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
        response_format: opts.format,
        ...(typeof opts.speed === "number" ? { speed: opts.speed } : {}),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        asset: null,
        error: `Speech request to ${provider} failed: ${res.status} ${(await res.text()).slice(0, 2000)}`,
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
