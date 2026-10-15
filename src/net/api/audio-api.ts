// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible audio endpoints on the model API:
 *
 *  - `POST /v1/audio/transcriptions` (multipart: `file`, `model`, `language`
 *    or `languages[]`, `prompt`, `temperature`, `response_format` json | text
 *    | verbose_json | srt | vtt, `timestamp_granularities[]=segment`)
 *  - `POST /v1/audio/speech` (JSON: `model`, `input`, `voice`,
 *    `response_format`, `speed`, `instructions`, `stream_format: "audio"`)
 *
 * Both run Marina's audio path (`src/engine/media/audio.ts`) as the
 * AUTHENTICATED caller (`resolveCaller`, the same identity rule as
 * `/v1/media`): quotas, the daily spend cap and the job row belong to that
 * entity. Nothing is stored as an asset — these are compute endpoints; the
 * `audio` command and agent tools are the asset-making surfaces. A parameter
 * Marina cannot honor is `400 unsupported_parameter`, never dropped; every
 * error carries a string `code`.
 */

import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import {
  AudioError,
  type AudioHost,
  audioMaxBytes,
  speakText,
  type TranscriptOutcome,
  transcribeAudio,
} from "../../engine/media/audio";
import { qualifyAudioModel } from "../../engine/media/providers/audio-registry";
import { SPEECH_FORMATS, type SpeechFormat } from "../../engine/media/providers/audio-util";
import type { EntityId } from "../../types";
import { corsHeaders } from "../cors";
import { maxUploadBytes, readJsonBody } from "../http-utils";
import {
  type OpenAIErrorCode,
  openaiErrorBody,
  unsupportedParameterBody,
} from "../model/openai-errors";
import type { PassthruAuthResult } from "../model-api/shared";
import { resolveCaller } from "./media-api";

const AUDIO_CORS = corsHeaders(null, {
  methods: "POST, OPTIONS",
  headers: "Content-Type, Authorization",
  expose: "x-request-id, x-marina-media-job, x-marina-cost-usd",
});

/** Multipart fields `/v1/audio/transcriptions` honors. */
const TRANSCRIBE_FIELDS = new Set([
  "file",
  "model",
  "language",
  "languages[]",
  "languages",
  "prompt",
  "temperature",
  "response_format",
  "timestamp_granularities[]",
  "timestamp_granularities",
  "stream",
]);
const TRANSCRIBE_FORMATS = new Set(["json", "text", "verbose_json", "srt", "vtt"]);
/** JSON fields `/v1/audio/speech` honors. */
const SPEECH_FIELDS = new Set([
  "model",
  "input",
  "voice",
  "response_format",
  "speed",
  "instructions",
  "stream_format",
]);

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    ...AUDIO_CORS,
    "x-request-id": `req-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

function error(status: number, message: string, code?: OpenAIErrorCode, param?: string): Response {
  return Response.json(
    openaiErrorBody(status, message, { ...(code ? { code } : {}), ...(param ? { param } : {}) }),
    {
      status,
      headers: headers(),
    },
  );
}

function unsupported(param: string, detail?: string): Response {
  return Response.json(unsupportedParameterBody(param, detail), {
    status: 400,
    headers: headers(),
  });
}

function fromAudioError(e: unknown): Response {
  if (e instanceof AudioError) return error(e.status, e.message, e.code);
  return error(500, getErrorMessage(e), "server_error");
}

export async function handleAudioApi(
  url: URL,
  method: string,
  req: Request,
  engine: Engine,
  auth?: PassthruAuthResult,
): Promise<Response> {
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: AUDIO_CORS });
  const route = url.pathname.replace(/\/+$/, "");
  if (route !== "/v1/audio/transcriptions" && route !== "/v1/audio/speech") {
    return error(404, `Not found: ${url.pathname}`, "not_found");
  }
  if (method !== "POST") return error(404, `Not found: ${method} ${url.pathname}`, "not_found");
  const manager = engine.mediaManager;
  if (!manager)
    return error(503, "Audio needs persistent storage and the media pipeline.", "server_error");
  const caller = resolveCaller(engine, req, auth);
  const who = { entityId: caller.entityId, entityName: caller.entityName };
  return route === "/v1/audio/transcriptions"
    ? transcriptions(req, manager.audioHost(), who)
    : speech(req, manager.audioHost(), who);
}

type Who = { entityId: EntityId; entityName: string };

/** The upload ceiling for this route: the audio cap within the server's upload cap. */
export function audioUploadCap(): number {
  return Math.min(audioMaxBytes(), maxUploadBytes());
}

async function transcriptions(req: Request, host: AudioHost, who: Who): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) {
    return error(400, "Send multipart/form-data with a `file` field.", "invalid_request_error");
  }
  const cap = audioUploadCap();
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap + 64 * 1024) {
    return error(413, `Upload is larger than ${cap} bytes.`, "payload_too_large");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return error(400, "Malformed multipart body.", "invalid_request_error");
  }
  for (const key of new Set(form.keys())) {
    if (!TRANSCRIBE_FIELDS.has(key)) return unsupported(key);
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return error(400, "Missing `file`.", "invalid_request_error", "file");
  if (file.size > cap)
    return error(413, `Upload is larger than ${cap} bytes.`, "payload_too_large");
  const rawModel = form.get("model");
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    return error(400, "Missing `model`.", "invalid_request_error", "model");
  }
  const model = qualifyAudioModel(rawModel, "transcribe");
  if (!model) {
    return error(
      404,
      `Model "${rawModel}" is not a known transcription model; name a configured server as <provider>/<model>.`,
      "model_not_found",
      "model",
    );
  }
  const stream = form.get("stream");
  if (typeof stream === "string" && stream.trim().toLowerCase() === "true") {
    return unsupported("stream", "Streaming transcription is not served; omit it.");
  }
  const format = String(form.get("response_format") ?? "json").trim() || "json";
  if (!TRANSCRIBE_FORMATS.has(format)) {
    return unsupported("response_format", `Use one of ${[...TRANSCRIBE_FORMATS].join(", ")}.`);
  }
  const granularities = [
    ...form.getAll("timestamp_granularities[]"),
    ...form.getAll("timestamp_granularities"),
  ].map(String);
  if (granularities.some((g) => g !== "segment")) {
    return unsupported("timestamp_granularities[]", "Only segment timestamps are served.");
  }
  const single = form.get("language");
  const many = [...form.getAll("languages[]"), ...form.getAll("languages")].map(String);
  if (typeof single === "string" && single && many.length) {
    return error(400, "Send `language` or `languages[]`, not both.", "invalid_request_error");
  }
  const languages = (many.length ? many : typeof single === "string" && single ? [single] : [])
    .map((l) => l.trim())
    .filter(Boolean);
  const temperatureRaw = form.get("temperature");
  const temperature =
    typeof temperatureRaw === "string" && temperatureRaw.trim()
      ? Number(temperatureRaw)
      : undefined;
  if (temperature !== undefined && !(temperature >= 0 && temperature <= 1)) {
    return error(
      400,
      "temperature must be between 0 and 1.",
      "invalid_request_error",
      "temperature",
    );
  }
  const prompt = form.get("prompt");
  let out: TranscriptOutcome;
  try {
    out = await transcribeAudio(host, {
      ...who,
      data: new Uint8Array(await file.arrayBuffer()),
      mime: file.type || mimeFromName(file.name),
      label: `upload:${file.name || "audio"}`.slice(0, 200),
      model,
      ...(languages.length ? { languages } : {}),
      ...(typeof prompt === "string" && prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    });
  } catch (e) {
    return fromAudioError(e);
  }
  const extra = {
    "x-marina-media-job": out.jobId,
    ...(out.costUsd !== null ? { "x-marina-cost-usd": String(out.costUsd) } : {}),
  };
  if (format === "text") {
    return new Response(out.text, {
      headers: headers({ ...extra, "Content-Type": "text/plain; charset=utf-8" }),
    });
  }
  if (format === "srt" || format === "vtt") {
    if (!out.segments?.length) {
      return error(
        400,
        `${model} returned no timestamps, so ${format} cannot be made; use json or a model with segments (whisper-1).`,
        "invalid_request_error",
        "response_format",
      );
    }
    return new Response(subtitles(out.segments, format), {
      headers: headers({
        ...extra,
        "Content-Type":
          format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
      }),
    });
  }
  const usage =
    out.durationSec !== undefined
      ? { usage: { type: "duration", seconds: Math.ceil(out.durationSec) } }
      : {};
  if (format === "verbose_json") {
    return Response.json(
      {
        task: "transcribe",
        ...(out.language ? { language: out.language } : {}),
        ...(out.durationSec !== undefined ? { duration: out.durationSec } : {}),
        text: out.text,
        segments: (out.segments ?? []).map((s, id) => ({ id, ...s })),
        ...usage,
      },
      { headers: headers(extra) },
    );
  }
  return Response.json(
    {
      text: out.text,
      ...(out.language ? { languages: [{ code: out.language }] } : {}),
      ...usage,
    },
    { headers: headers(extra) },
  );
}

async function speech(req: Request, host: AudioHost, who: Who): Promise<Response> {
  const read = await readJsonBody(req, {
    errorResponse: (status, _code, message) =>
      error(status, message, status === 413 ? "payload_too_large" : "invalid_request_error"),
  });
  if (!read.ok) return read.response;
  const body = read.body;
  for (const key of Object.keys(body)) {
    if (!SPEECH_FIELDS.has(key)) return unsupported(key);
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return error(400, "Missing `input`.", "invalid_request_error", "input");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return error(400, "Missing `model`.", "invalid_request_error", "model");
  }
  const model = qualifyAudioModel(body.model, "speech");
  if (!model) {
    return error(
      404,
      `Model "${body.model}" is not a known speech model; name a configured server as <provider>/<model>.`,
      "model_not_found",
      "model",
    );
  }
  const voice = body.voice;
  const voiceOk =
    voice === undefined ||
    (typeof voice === "string" && voice.trim() !== "") ||
    (!!voice && typeof voice === "object" && typeof (voice as { id?: unknown }).id === "string");
  if (!voiceOk) return error(400, "`voice` is a name or { id }.", "invalid_request_error", "voice");
  const format = (body.response_format ?? "mp3") as string;
  if (!(SPEECH_FORMATS as readonly string[]).includes(format)) {
    return unsupported("response_format", `Use one of ${SPEECH_FORMATS.join(", ")}.`);
  }
  if (body.stream_format !== undefined && body.stream_format !== "audio") {
    return unsupported("stream_format", "Only `audio` is served (the whole file).");
  }
  if (body.speed !== undefined && typeof body.speed !== "number") {
    return error(400, "speed must be a number.", "invalid_request_error", "speed");
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    return error(400, "instructions must be a string.", "invalid_request_error", "instructions");
  }
  try {
    const out = await speakText(host, {
      ...who,
      text: body.input,
      model,
      format: format as SpeechFormat,
      ...(voice !== undefined ? { voice: voice as string | { id: string } } : {}),
      ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
      ...(typeof body.instructions === "string" && body.instructions
        ? { instructions: body.instructions }
        : {}),
    });
    return new Response(out.data as Uint8Array<ArrayBuffer>, {
      headers: headers({
        "Content-Type": out.mime,
        "x-marina-media-job": out.jobId,
        ...(out.costUsd !== null ? { "x-marina-cost-usd": String(out.costUsd) } : {}),
      }),
    });
  } catch (e) {
    return fromAudioError(e);
  }
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    mpga: "audio/mpeg",
    mpeg: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
  };
  return map[ext] ?? "application/octet-stream";
}

/** SRT / WebVTT from timed segments. */
export function subtitles(
  segments: readonly { start: number; end: number; text: string }[],
  format: "srt" | "vtt",
): string {
  const stamp = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const f = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${s}${format === "srt" ? "," : "."}${f}`;
  };
  const cues = segments.map(
    (seg, i) =>
      `${format === "srt" ? `${i + 1}\n` : ""}${stamp(seg.start)} --> ${stamp(seg.end)}\n${seg.text}\n`,
  );
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues.join("\n")}`;
}
