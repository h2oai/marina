// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio: speech-to-text and text-to-speech over the providers in
 * `providers/audio-registry.ts`. One path for every surface (the `audio`
 * command, the `marina_transcribe` / `marina_speak` tools, `POST
 * /v1/audio/{transcriptions,speech}`):
 *
 *  - Each call is a `media_jobs` row (`transcription` / `speech`), counted
 *    against the entity's rolling-24h cap (`MAX_TRANSCRIPTION_JOBS_PER_DAY`,
 *    `MAX_SPEECH_JOBS_PER_DAY`). A priced provider is refused once the world's
 *    daily spend cap is spent; the price is recorded ONCE, by the caller that
 *    moves the row out of `pending` (compare-and-set).
 *  - Video is transcribed from its audio track, extracted with `ffmpeg`
 *    (argument array, never a shell). Long audio is cut into
 *    `MARINA_AUDIO_CHUNK_SECONDS` pieces (16 kHz mono WAV, kept under the
 *    provider's upload limit) and the pieces' segments are merged with their
 *    offsets. Without ffmpeg, audio within the upload limit is sent as is;
 *    video and oversize files are refused with the reason.
 *  - A transcript is stored on its asset as `metadata.transcript =
 *    { text, language?, model, createdAt, segments? }` (`saveTranscript`).
 *
 * Events carry ids, model and numbers — never the transcript or spoken text.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarinaDB } from "../../persistence/database";
import type { AssetRow } from "../../persistence/db-assets";
import type { EngineEvent, EntityId } from "../../types";
import type { Engine } from "../engine";
import { getErrorMessage, logRejection } from "../errors";
import { Logger } from "../logger";
import { dailyCapRefusal, recordSpend } from "../spend-ledger";
import { setAssetText } from "./asset-library";
import { enforceMediaJobQuota } from "./manager";
import {
  audioProviderOf,
  defaultAudioModel,
  defaultVoice,
  estimateSpeechSeconds,
  getAudioProvider,
  knownAudioProviders,
  speechPriceUsd,
  transcriptionPriceUsd,
} from "./providers/audio-registry";
import {
  audioExtension,
  SPEECH_FORMATS,
  type SpeechFormat,
  type TranscribeResult,
  type TranscriptSegment,
} from "./providers/audio-util";
import { publishGeneratedAsset, storeGeneratedAsset } from "./publish";
import { hasTool, runTool } from "./vision";

const logger = new Logger();

type Env = Record<string, string | undefined>;

/** Default largest audio/video input (bytes) when `MARINA_AUDIO_MAX_BYTES` is unset. */
export const DEFAULT_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
/** Default longest input (seconds) when `MARINA_AUDIO_MAX_SECONDS` is unset. */
export const DEFAULT_AUDIO_MAX_SECONDS = 3600;
/** Default piece length (seconds) when `MARINA_AUDIO_CHUNK_SECONDS` is unset — OpenAI's own 10-minute example. */
export const DEFAULT_AUDIO_CHUNK_SECONDS = 600;
const MIN_CHUNK_SECONDS = 30;
/** Default longest speech input (characters) when `MARINA_SPEECH_MAX_CHARS` is unset. */
export const DEFAULT_SPEECH_MAX_CHARS = 4096;
/** One provider call (a piece or a speech request). */
const AUDIO_CALL_TIMEOUT_MS = 180_000;
/** One ffmpeg extraction. */
const FFMPEG_TIMEOUT_MS = 120_000;
/** Bytes per second of the 16 kHz mono s16le WAV pieces. */
const WAV_BYTES_PER_SEC = 32_000;
/** Assumed bitrate (bytes/s, 128 kbit/s) for pricing audio of unknown duration. */
const ASSUMED_BYTES_PER_SEC = 16_000;
/** Formats OpenAI transcription takes (its guide's list, by MIME). */
const OPENAI_INPUT_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/mpeg",
]);

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function audioMaxBytes(env: Env = process.env): number {
  return Math.floor(positive(env.MARINA_AUDIO_MAX_BYTES, DEFAULT_AUDIO_MAX_BYTES));
}
export function audioMaxSeconds(env: Env = process.env): number {
  return positive(env.MARINA_AUDIO_MAX_SECONDS, DEFAULT_AUDIO_MAX_SECONDS);
}
export function audioChunkSeconds(env: Env = process.env): number {
  return Math.max(
    MIN_CHUNK_SECONDS,
    positive(env.MARINA_AUDIO_CHUNK_SECONDS, DEFAULT_AUDIO_CHUNK_SECONDS),
  );
}
export function speechMaxChars(env: Env = process.env): number {
  return Math.floor(positive(env.MARINA_SPEECH_MAX_CHARS, DEFAULT_SPEECH_MAX_CHARS));
}

/** A refusal with the HTTP status and OpenAI error code a surface should answer with. */
export class AudioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | "invalid_request_error"
      | "payload_too_large"
      | "rate_limit_exceeded"
      | "spend_cap_reached"
      | "model_not_found"
      | "upstream_error"
      | "server_error",
  ) {
    super(message);
  }
}

/** What the audio path needs (the media manager supplies it). */
export interface AudioHost {
  engine: Engine;
  db: MarinaDB;
  resolveApiKey: (provider: string) => string | undefined;
  logEvent: (event: EngineEvent) => void;
}

// ─── Media preparation ───────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "marina-audio-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(
      logRejection(logger, "media", "temp dir cleanup failed"),
    );
  }
}

/** Duration (s) and whether there is an audio stream, from ffprobe; undefined without it. */
async function probeMedia(
  file: string,
): Promise<{ seconds?: number; hasAudio: boolean } | undefined> {
  if (!hasTool("ffprobe")) return undefined;
  const r = await runTool([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    file,
  ]);
  if (!r.ok) return undefined;
  try {
    const parsed = JSON.parse(r.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    const seconds = Number(parsed.format?.duration);
    return {
      ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
    };
  } catch {
    return undefined;
  }
}

/** One piece of input audio as sent to the provider, at `offset` seconds into the source. */
interface AudioPiece {
  data: Uint8Array;
  mime: string;
  offset: number;
  seconds?: number;
}

/** Cut `[start, start+length)` of `file` to 16 kHz mono WAV (no shell). */
async function extractWav(
  file: string,
  out: string,
  start?: number,
  length?: number,
): Promise<Uint8Array> {
  const r = await runTool(
    [
      "ffmpeg",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      ...(start !== undefined ? ["-ss", String(start)] : []),
      ...(length !== undefined ? ["-t", String(length)] : []),
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      out,
    ],
    { timeoutMs: FFMPEG_TIMEOUT_MS },
  );
  if (!r.ok) {
    throw new AudioError(
      r.timedOut
        ? "ffmpeg timed out extracting audio."
        : "ffmpeg could not read an audio track from this file.",
      400,
      "invalid_request_error",
    );
  }
  return new Uint8Array(await readFile(out));
}

/**
 * The pieces to send: the input as is when the provider takes it whole, else
 * WAV pieces cut by ffmpeg (video, oversize, too long, or a format the
 * provider does not take).
 */
export async function prepareAudioPieces(
  data: Uint8Array,
  mime: string,
  opts: { provider: string; maxUploadBytes?: number; env?: Env },
): Promise<{ pieces: AudioPiece[]; seconds?: number }> {
  const env = opts.env ?? process.env;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  const isVideo = base.startsWith("video/");
  return withTempDir(async (dir) => {
    const file = join(dir, `input.${audioExtension(base)}`);
    await writeFile(file, data);
    const probe = await probeMedia(file);
    const seconds = probe?.seconds;
    if (probe && !probe.hasAudio) {
      throw new AudioError("This file has no audio track.", 400, "invalid_request_error");
    }
    const maxSeconds = audioMaxSeconds(env);
    if (seconds !== undefined && seconds > maxSeconds) {
      throw new AudioError(
        `Audio is ${Math.round(seconds)} s long; the limit is ${maxSeconds} s (MARINA_AUDIO_MAX_SECONDS).`,
        413,
        "payload_too_large",
      );
    }
    const limit = opts.maxUploadBytes;
    // A piece must fit the provider's upload limit (with headroom).
    const fitSeconds = limit ? Math.floor((limit * 0.95) / WAV_BYTES_PER_SEC) : Infinity;
    const chunk = Math.max(MIN_CHUNK_SECONDS, Math.min(audioChunkSeconds(env), fitSeconds));
    const oversize = limit !== undefined && data.byteLength > limit;
    const tooLong = seconds !== undefined && seconds > chunk;
    const unaccepted = opts.provider === "openai" && !OPENAI_INPUT_MIMES.has(base);
    if (!isVideo && !oversize && !tooLong && !unaccepted) {
      return {
        pieces: [{ data, mime: base, offset: 0, ...(seconds ? { seconds } : {}) }],
        seconds,
      };
    }
    if (!hasTool("ffmpeg")) {
      const why = isVideo
        ? "Transcribing video needs ffmpeg to extract its audio track"
        : oversize
          ? `Audio is ${data.byteLength} bytes, over the provider's ${limit}-byte upload limit; splitting it needs ffmpeg`
          : undefined;
      // Too long, or a format the provider's docs do not list, but within the
      // upload limit: send it whole and let the provider decide.
      if (!why) return { pieces: [{ data, mime: base, offset: 0 }], seconds };
      throw new AudioError(`${why} — install ffmpeg on the server.`, 400, "invalid_request_error");
    }
    const pieces: AudioPiece[] = [];
    if (seconds === undefined) {
      // No duration (no ffprobe): one extraction; refuse if it still does not fit.
      const wav = await extractWav(file, join(dir, "piece-0.wav"));
      if (limit !== undefined && wav.byteLength > limit) {
        throw new AudioError(
          "Audio is too long to send in one piece and its duration is unknown — install ffprobe to split it.",
          413,
          "payload_too_large",
        );
      }
      pieces.push({ data: wav, mime: "audio/wav", offset: 0 });
      return { pieces };
    }
    for (let start = 0, i = 0; start < seconds; start += chunk, i++) {
      const length = Math.min(chunk, seconds - start);
      if (length < 0.05) break;
      const wav = await extractWav(file, join(dir, `piece-${i}.wav`), start, length);
      pieces.push({ data: wav, mime: "audio/wav", offset: start, seconds: length });
    }
    return { pieces, seconds };
  });
}

// ─── Transcription ───────────────────────────────────────────────────────────

export interface TranscribeRequest {
  entityId: EntityId;
  entityName: string;
  data: Uint8Array;
  mime: string;
  /** What the input is (asset filename, URL, upload name) — recorded on the job, never content. */
  label: string;
  model?: string;
  languages?: string[];
  prompt?: string;
  temperature?: number;
  assetId?: string;
}

export interface TranscriptOutcome {
  jobId: string;
  model: string;
  text: string;
  language?: string;
  segments?: TranscriptSegment[];
  durationSec?: number;
  pieces: number;
  costUsd: number | null;
}

function resolveModel(host: AudioHost, model: string | undefined, kind: "transcribe" | "speech") {
  const chosen = model?.trim() || defaultAudioModel(kind, !!host.resolveApiKey("openai"));
  const provider = audioProviderOf(chosen);
  const impl = provider ? getAudioProvider(provider) : undefined;
  if (!impl) {
    throw new AudioError(
      `Model "${chosen}" has no audio provider. Name it as <provider>/<model>; providers: ${knownAudioProviders().join(", ")}.`,
      404,
      "model_not_found",
    );
  }
  const apiKey = host.resolveApiKey(provider) ?? "";
  if (impl.requiresKey && !apiKey) {
    throw new AudioError(
      `No API key configured for provider "${provider}".`,
      400,
      "invalid_request_error",
    );
  }
  return { model: chosen, provider, impl, apiKey };
}

function quota(host: AudioHost, entityName: string, type: "transcription" | "speech"): void {
  try {
    enforceMediaJobQuota(host.db, entityName, type);
  } catch (error) {
    throw new AudioError(getErrorMessage(error), 429, "rate_limit_exceeded");
  }
}

function spendGate(priced: boolean, what: string): void {
  if (!priced) return;
  const capped = dailyCapRefusal();
  if (capped) throw new AudioError(`${what} refused: ${capped}`, 429, "spend_cap_reached");
}

function feed(
  host: AudioHost,
  kind: string,
  entityId: EntityId,
  jobId: string,
  summary: string,
  payload: Record<string, unknown>,
): void {
  host.logEvent({
    type: "feed_event",
    kind,
    entity: entityId,
    ref: jobId,
    summary,
    payload: { jobId, ...payload },
    timestamp: Date.now(),
  });
}

/** Seconds a piece was billed for: what the provider reported, else its probe, else a bitrate guess. */
function billedSeconds(piece: AudioPiece, result: TranscribeResult): number {
  return (
    result.usage?.seconds ??
    result.durationSec ??
    piece.seconds ??
    piece.data.byteLength / (piece.mime === "audio/wav" ? WAV_BYTES_PER_SEC : ASSUMED_BYTES_PER_SEC)
  );
}

/** Transcribe audio (or a video's audio track). Throws {@link AudioError}. */
export async function transcribeAudio(
  host: AudioHost,
  req: TranscribeRequest,
): Promise<TranscriptOutcome> {
  const max = audioMaxBytes();
  if (req.data.byteLength === 0) throw new AudioError("Empty audio.", 400, "invalid_request_error");
  if (req.data.byteLength > max) {
    throw new AudioError(
      `Audio is ${req.data.byteLength} bytes; the limit is ${max} (MARINA_AUDIO_MAX_BYTES).`,
      413,
      "payload_too_large",
    );
  }
  const { model, provider, impl, apiKey } = resolveModel(host, req.model, "transcribe");
  quota(host, req.entityName, "transcription");
  const { pieces, seconds } = await prepareAudioPieces(req.data, req.mime, {
    provider,
    ...(impl.maxUploadBytes ? { maxUploadBytes: impl.maxUploadBytes } : {}),
  });
  const estimate = seconds !== undefined ? transcriptionPriceUsd(model, seconds) : null;
  spendGate(transcriptionPriceUsd(model, 1) !== null, "Transcription");

  const jobId = crypto.randomUUID();
  host.db.createMediaJob({
    id: jobId,
    type: "transcription",
    entityName: req.entityName,
    entityId: req.entityId,
    provider,
    model,
    prompt: req.label.slice(0, 500),
    options: {
      ...(req.assetId ? { assetId: req.assetId } : {}),
      ...(req.languages?.length ? { languages: req.languages } : {}),
      pieces: pieces.length,
    },
    costEstimate: estimate,
    metadata: null,
  });

  const texts: string[] = [];
  const segments: TranscriptSegment[] = [];
  let language: string | undefined;
  let billed = 0;
  let duration = 0;
  try {
    for (const piece of pieces) {
      const result = await impl.transcribe({
        apiKey,
        model,
        data: piece.data,
        mime: piece.mime,
        ...(req.languages?.length ? { languages: req.languages } : {}),
        ...(req.prompt ? { prompt: req.prompt } : {}),
        ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
        segments: true,
        signal: AbortSignal.timeout(AUDIO_CALL_TIMEOUT_MS),
      });
      if (result.status !== "succeeded") {
        const status = result.httpStatus && result.httpStatus < 500 ? 400 : 502;
        throw new AudioError(
          result.error ?? "Transcription failed.",
          status,
          status === 400 ? "invalid_request_error" : "upstream_error",
        );
      }
      const pieceSeconds = billedSeconds(piece, result);
      billed += pieceSeconds;
      duration += piece.seconds ?? result.durationSec ?? pieceSeconds;
      if (result.text) texts.push(result.text);
      language ??= result.language;
      for (const s of result.segments ?? []) {
        segments.push({ ...s, start: s.start + piece.offset, end: s.end + piece.offset });
      }
    }
  } catch (error) {
    // Pieces already transcribed were charged by the provider.
    const charged = billed > 0 ? transcriptionPriceUsd(model, billed) : null;
    if (
      host.db.transitionMediaJob(jobId, "pending", {
        status: "failed",
        error: getErrorMessage(error),
        completedAt: Date.now(),
      }) &&
      charged
    ) {
      recordSpend("media", charged);
    }
    feed(
      host,
      "audio_transcribe_failed",
      req.entityId,
      jobId,
      `${req.entityName} transcription (${model}): failed`,
      { model },
    );
    if (error instanceof AudioError) throw error;
    throw new AudioError(getErrorMessage(error), 502, "upstream_error");
  }

  const costUsd = transcriptionPriceUsd(model, billed);
  const claimed = host.db.transitionMediaJob(jobId, "pending", {
    status: "succeeded",
    ...(req.assetId ? { assetId: req.assetId } : {}),
    completedAt: Date.now(),
    metadata: { seconds: Math.round(duration * 10) / 10, ...(costUsd !== null ? { costUsd } : {}) },
  });
  if (claimed) recordSpend("media", costUsd ?? undefined);
  feed(
    host,
    "audio_transcribed",
    req.entityId,
    jobId,
    `${req.entityName} transcribed ${Math.round(duration)} s of audio (${model})`,
    { model, ...(req.assetId ? { assetId: req.assetId } : {}), seconds: Math.round(duration) },
  );
  return {
    jobId,
    model,
    text: texts.join(pieces.length > 1 ? "\n" : " ").trim(),
    ...(language ? { language } : {}),
    ...(segments.length ? { segments } : {}),
    ...(duration > 0 ? { durationSec: Math.round(duration * 10) / 10 } : {}),
    pieces: pieces.length,
    costUsd,
  };
}

/** The `metadata.transcript` record (the contract shared with memory-over-media). */
export interface StoredTranscript {
  text: string;
  language?: string;
  model: string;
  createdAt: number;
  segments?: TranscriptSegment[];
  /** Set when the text was cut at {@link TRANSCRIPT_MAX_CHARS}. */
  truncated?: true;
}

/** Longest transcript text stored on an asset (the memory-over-media contract's cap). */
export const TRANSCRIPT_MAX_CHARS = 100_000;

/**
 * Store a transcript on its asset as `metadata.transcript` through the asset
 * library's `setAssetText` (bumps `updated_at` for the memory index, emits
 * `asset_updated`). The caller has already decided the actor may change the asset.
 */
export function saveTranscript(
  engine: Engine,
  asset: AssetRow,
  outcome: Pick<TranscriptOutcome, "text" | "language" | "model" | "segments">,
  actor?: EntityId,
): StoredTranscript {
  const truncated = outcome.text.length > TRANSCRIPT_MAX_CHARS;
  const transcript: StoredTranscript = {
    text: truncated ? outcome.text.slice(0, TRANSCRIPT_MAX_CHARS) : outcome.text,
    ...(outcome.language ? { language: outcome.language } : {}),
    model: outcome.model,
    createdAt: Date.now(),
    ...(outcome.segments?.length ? { segments: outcome.segments } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
  setAssetText(
    engine,
    asset.id,
    "transcript",
    transcript.text,
    {
      model: transcript.model,
      ...(transcript.language ? { language: transcript.language } : {}),
      ...(transcript.segments ? { segments: transcript.segments } : {}),
    },
    actor,
  );
  return transcript;
}

// ─── Speech ──────────────────────────────────────────────────────────────────

export interface SpeakRequest {
  entityId: EntityId;
  entityName: string;
  text: string;
  model?: string;
  voice?: string | { id: string };
  format?: SpeechFormat;
  speed?: number;
  instructions?: string;
  /** Store the audio as an asset (origin `generated`) and publish it to a canvas. */
  store?: { canvasId?: string; publish: boolean };
}

export interface SpeechOutcome {
  jobId: string;
  model: string;
  voice?: string;
  format: SpeechFormat;
  data: Uint8Array;
  mime: string;
  costUsd: number | null;
  assetId?: string;
  canvasId?: string;
  nodeId?: string;
}

/** Speak text. Throws {@link AudioError}. */
export async function speakText(host: AudioHost, req: SpeakRequest): Promise<SpeechOutcome> {
  const text = req.text.trim();
  if (!text) throw new AudioError("Text to speak is required.", 400, "invalid_request_error");
  const format = req.format ?? "mp3";
  if (!(SPEECH_FORMATS as readonly string[]).includes(format)) {
    throw new AudioError(
      `Unknown format "${format}"; use ${SPEECH_FORMATS.join(", ")}.`,
      400,
      "invalid_request_error",
    );
  }
  if (req.store && format === "pcm") {
    throw new AudioError(
      "Headerless pcm cannot be stored as an asset; use wav.",
      400,
      "invalid_request_error",
    );
  }
  if (typeof req.speed === "number" && !(req.speed >= 0.25 && req.speed <= 4)) {
    throw new AudioError("speed must be between 0.25 and 4.", 400, "invalid_request_error");
  }
  const { model, provider, impl, apiKey } = resolveModel(host, req.model, "speech");
  const cap = Math.min(speechMaxChars(), impl.maxSpeechChars ?? Infinity);
  if (text.length > cap) {
    throw new AudioError(
      `Text is ${text.length} characters; the limit is ${cap}${impl.maxSpeechChars === cap ? ` (${provider})` : " (MARINA_SPEECH_MAX_CHARS)"}.`,
      413,
      "payload_too_large",
    );
  }
  quota(host, req.entityName, "speech");
  const costUsd = speechPriceUsd(model, text.length, estimateSpeechSeconds(text.length));
  spendGate(costUsd !== null, "Speech");
  const voice = req.voice ?? defaultVoice(model);

  const jobId = crypto.randomUUID();
  host.db.createMediaJob({
    id: jobId,
    type: "speech",
    entityName: req.entityName,
    entityId: req.entityId,
    provider,
    model,
    // The job row records the size of the request, never the text.
    prompt: `${text.length} characters`,
    options: {
      format,
      ...(typeof voice === "string" ? { voice } : voice ? { voice: "custom" } : {}),
      ...(typeof req.speed === "number" ? { speed: req.speed } : {}),
      ...(req.store?.canvasId ? { canvasId: req.store.canvasId } : {}),
    },
    costEstimate: costUsd,
    metadata: null,
  });

  const fail = (message: string, status: number, code: AudioError["code"]): never => {
    host.db.transitionMediaJob(jobId, "pending", {
      status: "failed",
      error: message,
      completedAt: Date.now(),
    });
    feed(
      host,
      "audio_speech_failed",
      req.entityId,
      jobId,
      `${req.entityName} speech (${model}): failed`,
      { model },
    );
    throw new AudioError(message, status, code);
  };

  const result = await impl
    .speak({
      apiKey,
      model,
      input: text,
      ...(voice !== undefined ? { voice } : {}),
      format,
      ...(typeof req.speed === "number" ? { speed: req.speed } : {}),
      ...(req.instructions ? { instructions: req.instructions } : {}),
      signal: AbortSignal.timeout(AUDIO_CALL_TIMEOUT_MS),
    })
    .catch((error: unknown) => ({
      status: "failed" as const,
      asset: null,
      error: getErrorMessage(error),
      httpStatus: undefined,
    }));
  if (result.status !== "succeeded" || !result.asset) {
    const bad = result.httpStatus !== undefined && result.httpStatus < 500;
    return fail(
      result.error ?? "Speech generation failed.",
      bad ? 400 : 502,
      bad ? "invalid_request_error" : "upstream_error",
    );
  }

  let assetId: string | undefined;
  let canvasId: string | undefined;
  let nodeId: string | undefined;
  if (req.store) {
    try {
      const stored = await storeGeneratedAsset({
        engine: host.engine,
        entityName: req.entityName,
        filename: result.asset.filename,
        mimeType: result.asset.mimeType,
        data: result.asset.data,
        prompt: text,
        model,
        metadata: {
          provider,
          jobId,
          format,
          ...(typeof voice === "string" ? { voice } : {}),
          ...(costUsd !== null ? { costUsd } : {}),
        },
        id: crypto.randomUUID(),
      });
      assetId = stored.id;
    } catch (error) {
      // The speech was made (and paid for); only keeping it failed.
      if (
        host.db.transitionMediaJob(jobId, "pending", {
          status: "failed",
          error: `Speech generated but storing it failed: ${getErrorMessage(error)}`,
          completedAt: Date.now(),
        })
      )
        recordSpend("media", costUsd ?? undefined);
      throw new AudioError(
        `Speech generated but storing it failed: ${getErrorMessage(error)}`,
        500,
        "server_error",
      );
    }
  }

  const claimed = host.db.transitionMediaJob(jobId, "pending", {
    status: "succeeded",
    ...(assetId ? { assetId } : {}),
    completedAt: Date.now(),
  });
  if (claimed) recordSpend("media", costUsd ?? undefined);

  if (assetId && req.store?.publish) {
    const target =
      (req.store.canvasId && host.db.getCanvas(req.store.canvasId)?.id) ??
      host.db.ensureEntityCanvas(req.entityId, req.entityName, req.entityName).id;
    const published = publishGeneratedAsset({
      engine: host.engine,
      entityId: req.entityId,
      entityName: req.entityName,
      assetId,
      nodeType: "audio",
      prompt: text,
      model,
      canvasId: target,
      summary: `${req.entityName} generated speech.`,
    });
    canvasId = published.canvasId;
    nodeId = published.nodeId;
  }
  // A published node already announced itself (`audio_generated`).
  if (!nodeId)
    feed(
      host,
      "audio_spoken",
      req.entityId,
      jobId,
      `${req.entityName} generated speech (${model})`,
      { model, format, ...(assetId ? { assetId } : {}), chars: text.length },
    );
  return {
    jobId,
    model,
    ...(typeof voice === "string" ? { voice } : {}),
    format,
    data: result.asset.data,
    mime: result.asset.mimeType,
    costUsd,
    ...(assetId ? { assetId } : {}),
    ...(canvasId ? { canvasId } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}
