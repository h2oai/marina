// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio providers against a mocked network: OpenAI transcription (per-model
 * request shapes: `languages[]` for gpt-transcribe, `language` + json for the
 * gpt-4o family, verbose_json + segment timestamps for whisper-1,
 * diarized_json for the diarize model) and speech, any OpenAI-compatible
 * server via `<PROVIDER>_AUDIO_BASE_URL`, the registry's model/voice defaults,
 * availability and prices, and the agent tools' capability gating.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { GameStateManager } from "../src/agent/game-state";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { createProfileToolset, type ToolContext } from "../src/agent/tools";
import {
  audioAvailable,
  defaultAudioModel,
  defaultVoice,
  qualifyAudioModel,
  speechPriceUsd,
  transcriptionPriceUsd,
} from "../src/engine/media/providers/audio-registry";
import { normalizeSegments } from "../src/engine/media/providers/audio-util";
import {
  buildOpenAISpeechBody,
  buildOpenAITranscriptionForm,
  parseTranscriptionReply,
  speakOpenAI,
  transcribeOpenAI,
} from "../src/engine/media/providers/openai-audio";
import {
  configuredAudioEndpoints,
  speakOpenAICompatible,
  transcribeOpenAICompatible,
} from "../src/engine/media/providers/openai-compatible-audio";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import type { MarinaClient } from "../src/sdk/client";

const realFetch = globalThis.fetch;
const ENV = [
  "LOCALAI_AUDIO_BASE_URL",
  "LOCALAI_API_KEY",
  "MARINA_TRANSCRIBE_MODEL",
  "MARINA_SPEECH_MODEL",
  "MARINA_SPEECH_VOICE",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  __setDnsResolverForTest(async () => ["93.184.216.34"]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setDnsResolverForTest(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Seen {
  url: string;
  init?: RequestInit;
}
function mockFetch(handler: (url: string, init?: RequestInit) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return seen;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]);

function fields(form: FormData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) {
    (out[k] ??= []).push(
      typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).type}`,
    );
  }
  return out;
}

describe("OpenAI transcription request shapes", () => {
  const base = { apiKey: "k", data: AUDIO, mime: "audio/mpeg" };

  it("gpt-transcribe sends languages[] (never language) and json", () => {
    const form = buildOpenAITranscriptionForm({
      ...base,
      model: "openai/gpt-transcribe",
      languages: ["en", "fr"],
      prompt: "harbour",
    }) as FormData;
    expect(fields(form)).toEqual({
      file: ["file:audio.mp3:audio/mpeg"],
      model: ["gpt-transcribe"],
      "languages[]": ["en", "fr"],
      prompt: ["harbour"],
      response_format: ["json"],
    });
  });

  it("gpt-4o family takes one language; two are refused, not dropped", () => {
    const f = fields(
      buildOpenAITranscriptionForm({
        ...base,
        model: "openai/gpt-4o-mini-transcribe",
        languages: ["de"],
      }) as FormData,
    );
    expect(f.language).toEqual(["de"]);
    expect(f["languages[]"]).toBeUndefined();
    expect(f.response_format).toEqual(["json"]);
    const refused = buildOpenAITranscriptionForm({
      ...base,
      model: "openai/gpt-4o-transcribe",
      languages: ["de", "fr"],
    });
    expect(typeof refused).toBe("string");
  });

  it("whisper-1 asks verbose_json with segment timestamps; diarize asks diarized_json and refuses a prompt", () => {
    const w = fields(
      buildOpenAITranscriptionForm({ ...base, model: "openai/whisper-1" }) as FormData,
    );
    expect(w.response_format).toEqual(["verbose_json"]);
    expect(w["timestamp_granularities[]"]).toEqual(["segment"]);
    const d = fields(
      buildOpenAITranscriptionForm({
        ...base,
        model: "openai/gpt-4o-transcribe-diarize",
      }) as FormData,
    );
    expect(d.response_format).toEqual(["diarized_json"]);
    expect(d.chunking_strategy).toEqual(["auto"]);
    expect(
      typeof buildOpenAITranscriptionForm({
        ...base,
        model: "openai/gpt-4o-transcribe-diarize",
        prompt: "x",
      }),
    ).toBe("string");
  });

  it("posts to the transcription endpoint with a bearer key and reads every reply shape", async () => {
    const seen = mockFetch(() =>
      json({
        text: " Bonjour ",
        languages: [{ code: "fr" }],
        usage: { type: "duration", seconds: 5 },
      }),
    );
    const r = await transcribeOpenAI({ ...base, model: "openai/gpt-transcribe" });
    expect(seen[0]!.url).toBe("https://93.184.216.34/v1/audio/transcriptions"); // pinned api.openai.com
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer k");
    expect(r).toEqual({
      status: "succeeded",
      text: "Bonjour",
      language: "fr",
      durationSec: 5,
      usage: { seconds: 5 },
    });

    expect(
      parseTranscriptionReply({
        text: "hi",
        usage: { type: "tokens", input_tokens: 47, output_tokens: 17 },
      }).usage,
    ).toEqual({ inputTokens: 47, outputTokens: 17 });
    const diarized = parseTranscriptionReply({
      text: "a b",
      segments: [
        { speaker: "A", start: 0, end: 1.5, text: "a" },
        { speaker: "B", start: 1.5, end: 3, text: "b" },
      ],
    });
    expect(diarized.segments).toEqual([
      { start: 0, end: 1.5, text: "a", speaker: "A" },
      { start: 1.5, end: 3, text: "b", speaker: "B" },
    ]);
  });

  it("reports an upstream refusal with its status and message", async () => {
    mockFetch(() => json({ error: { message: "Invalid file format." } }, 400));
    const r = await transcribeOpenAI({ ...base, model: "openai/gpt-transcribe" });
    expect(r.status).toBe("failed");
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain("Invalid file format.");
  });
});

describe("OpenAI speech", () => {
  it("builds the documented body; refuses what a model cannot do", () => {
    expect(
      buildOpenAISpeechBody({
        apiKey: "k",
        model: "openai/gpt-4o-mini-tts",
        input: "hi",
        format: "wav",
        instructions: "calm",
      }),
    ).toEqual({
      model: "gpt-4o-mini-tts",
      input: "hi",
      voice: "marin",
      response_format: "wav",
      instructions: "calm",
    });
    expect(
      buildOpenAISpeechBody({
        apiKey: "k",
        model: "openai/tts-1",
        input: "hi",
        voice: "marin",
        format: "mp3",
      }),
    ).toContain("does not offer voice");
    expect(
      buildOpenAISpeechBody({
        apiKey: "k",
        model: "openai/tts-1-hd",
        input: "hi",
        voice: "alloy",
        format: "mp3",
        instructions: "x",
      }),
    ).toContain("does not take instructions");
    expect(
      buildOpenAISpeechBody({
        apiKey: "k",
        model: "openai/gpt-4o-mini-tts",
        input: "x".repeat(4097),
        format: "mp3",
      }),
    ).toContain("4096");
    expect(
      buildOpenAISpeechBody({
        apiKey: "k",
        model: "openai/gpt-4o-mini-tts",
        input: "hi",
        voice: { id: "voice_1" },
        format: "mp3",
      }),
    ).toMatchObject({ voice: { id: "voice_1" } });
  });

  it("returns the audio bytes typed by format", async () => {
    const seen = mockFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/ogg" } }),
    );
    const r = await speakOpenAI({
      apiKey: "k",
      model: "openai/gpt-4o-mini-tts",
      input: "hi",
      format: "opus",
    });
    expect(seen[0]!.url).toBe("https://93.184.216.34/v1/audio/speech"); // pinned api.openai.com
    expect(JSON.parse(String(seen[0]!.init?.body))).toMatchObject({
      model: "gpt-4o-mini-tts",
      response_format: "opus",
    });
    expect(r.status).toBe("succeeded");
    expect(r.asset?.mimeType).toBe("audio/ogg");
    expect(r.asset?.filename).toEndWith(".opus");
  });
});

describe("OpenAI-compatible audio servers", () => {
  it("transcribes through <PROVIDER>_AUDIO_BASE_URL with its own key; falls back to json when verbose is refused", async () => {
    process.env.LOCALAI_AUDIO_BASE_URL = "http://127.0.0.1:8080/v1/";
    process.env.LOCALAI_API_KEY = "local-key";
    let calls = 0;
    const seen = mockFetch(() => {
      calls++;
      return calls === 1 ? new Response("bad format", { status: 400 }) : json({ text: "hello" });
    });
    const r = await transcribeOpenAICompatible({
      apiKey: "",
      model: "localai/whisper-1",
      data: AUDIO,
      mime: "audio/wav",
      languages: ["en"],
    });
    expect(r).toMatchObject({ status: "succeeded", text: "hello" });
    expect(seen.map((s) => s.url)).toEqual([
      "http://127.0.0.1:8080/v1/audio/transcriptions",
      "http://127.0.0.1:8080/v1/audio/transcriptions",
    ]);
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer local-key");
    expect(fields(seen[0]!.init?.body as FormData).response_format).toEqual(["verbose_json"]);
    expect(fields(seen[1]!.init?.body as FormData)).toMatchObject({
      response_format: ["json"],
      language: ["en"],
      model: ["whisper-1"],
    });
  });

  it("rescales LocalAI nanosecond segment times to seconds", () => {
    expect(normalizeSegments([{ start: 0, end: 9_640_000_000, text: " hi " }])).toEqual([
      { start: 0, end: 9.64, text: "hi" },
    ]);
    expect(normalizeSegments([{ start: 1, end: 2.5, text: "a" }])).toEqual([
      { start: 1, end: 2.5, text: "a" },
    ]);
  });

  it("speaks through the configured server and omits an unset voice", async () => {
    process.env.LOCALAI_AUDIO_BASE_URL = "http://127.0.0.1:8880/v1";
    const seen = mockFetch(() => new Response(new Uint8Array([9, 9])));
    const r = await speakOpenAICompatible({
      apiKey: "",
      model: "localai/kokoro",
      input: "hi",
      format: "wav",
    });
    expect(seen[0]!.url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      model: "kokoro",
      input: "hi",
      response_format: "wav",
    });
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBeNull();
    expect(r.asset?.mimeType).toBe("audio/wav");
  });

  it("reports a missing base URL instead of calling anything", async () => {
    const seen = mockFetch(() => json({}));
    const r = await transcribeOpenAICompatible({
      apiKey: "",
      model: "nowhere/x",
      data: AUDIO,
      mime: "audio/wav",
    });
    expect(r.error).toContain("NOWHERE_AUDIO_BASE_URL");
    expect(seen).toHaveLength(0);
  });
});

describe("audio registry", () => {
  it("qualifies bare OpenAI ids and leaves unknown bare ids unresolved", () => {
    expect(qualifyAudioModel("gpt-4o-mini-tts", "speech")).toBe("openai/gpt-4o-mini-tts");
    expect(qualifyAudioModel("whisper-1", "transcribe")).toBe("openai/whisper-1");
    expect(qualifyAudioModel("gpt-transcribe", "transcribe")).toBe("openai/gpt-transcribe");
    expect(qualifyAudioModel("kokoro", "speech")).toBeUndefined();
    expect(qualifyAudioModel("localai/kokoro", "speech")).toBe("localai/kokoro");
  });

  it("defaults: pin, then OpenAI with a key, then the first configured server", () => {
    expect(defaultAudioModel("transcribe", true, {})).toBe("openai/gpt-transcribe");
    expect(defaultAudioModel("speech", true, {})).toBe("openai/gpt-4o-mini-tts");
    const local = { SPEACHES_AUDIO_BASE_URL: "http://127.0.0.1:8000/v1" };
    expect(defaultAudioModel("transcribe", false, local)).toBe("speaches/whisper-1");
    expect(defaultAudioModel("speech", false, local)).toBe("speaches/tts-1");
    expect(defaultAudioModel("speech", true, { MARINA_SPEECH_MODEL: "speaches/kokoro" })).toBe(
      "speaches/kokoro",
    );
    expect(defaultVoice("openai/gpt-4o-mini-tts", {})).toBe("marin");
    expect(defaultVoice("speaches/kokoro", {})).toBeUndefined();
    expect(defaultVoice("speaches/kokoro", { MARINA_SPEECH_VOICE: "af_heart" })).toBe("af_heart");
    expect(configuredAudioEndpoints(local)).toEqual(["speaches"]);
  });

  it("is available with an OpenAI key or a configured server, and only with the media pipeline", () => {
    expect(audioAvailable({ configured: true, hasKey: () => false, env: {} })).toEqual({
      transcribe: false,
      speak: false,
    });
    expect(
      audioAvailable({ configured: true, hasKey: (p) => p === "openai", env: {} }).transcribe,
    ).toBe(true);
    expect(
      audioAvailable({
        configured: true,
        hasKey: () => false,
        env: { X_AUDIO_BASE_URL: "http://h" },
      }).speak,
    ).toBe(true);
    expect(audioAvailable({ configured: false, hasKey: () => true, env: {} })).toEqual({
      transcribe: false,
      speak: false,
    });
  });

  it("prices OpenAI audio at published rates; a configured server is unpriced", () => {
    expect(transcriptionPriceUsd("openai/gpt-transcribe", 60)).toBeCloseTo(0.0045, 6);
    expect(transcriptionPriceUsd("openai/gpt-4o-mini-transcribe", 120)).toBeCloseTo(0.006, 6);
    expect(transcriptionPriceUsd("openai/whisper-1", 30)).toBeCloseTo(0.003, 6);
    expect(transcriptionPriceUsd("openai/gpt-future-transcribe", 60)).toBeCloseTo(0.006, 6);
    expect(transcriptionPriceUsd("localai/whisper-1", 60)).toBeNull();
    expect(speechPriceUsd("openai/tts-1", 1_000_000, 0)).toBeCloseTo(15, 6);
    expect(speechPriceUsd("openai/tts-1-hd", 1000, 0)).toBeCloseTo(0.03, 6);
    expect(speechPriceUsd("openai/gpt-4o-mini-tts", 400, 60)).toBeCloseTo(0.00006 + 0.015, 6);
    expect(speechPriceUsd("localai/kokoro", 400, 60)).toBeNull();
  });
});

describe("audio tools are a provider capability", () => {
  const ctx: ToolContext = {
    client: { isConnected: () => true, command: async () => [] } as unknown as MarinaClient,
    gameState: new GameStateManager(),
  };
  const names = (opts: Parameters<typeof createProfileToolset>[4]) => {
    const set = createProfileToolset(
      ctx,
      {} as PlatformMemoryBackend,
      "full",
      { text: true },
      opts,
    );
    return [...set.resident, ...set.deferred].map((t: AgentTool) => t.name);
  };

  it("offers marina_transcribe / marina_speak only when an audio provider exists, deferred", () => {
    expect(names(undefined)).not.toContain("marina_transcribe");
    expect(names({ mediaGeneration: { image: true } })).not.toContain("marina_speak");
    const on = createProfileToolset(
      ctx,
      {} as PlatformMemoryBackend,
      "full",
      { text: true },
      {
        mediaGeneration: { transcribe: true, speak: true },
      },
    );
    expect(on.deferred.map((t) => t.name)).toEqual(
      expect.arrayContaining(["marina_transcribe", "marina_speak"]),
    );
    expect(on.resident.map((t) => t.name)).not.toContain("marina_transcribe");
  });

  it("maps tool calls onto the audio command", async () => {
    const commands: string[] = [];
    const c: ToolContext = {
      client: {
        isConnected: () => true,
        command: async (cmd: string) => {
          commands.push(cmd);
          return [];
        },
      } as unknown as MarinaClient,
      gameState: new GameStateManager(),
    };
    const set = createProfileToolset(
      c,
      {} as PlatformMemoryBackend,
      "full",
      { text: true },
      {
        mediaGeneration: { transcribe: true, speak: true },
      },
    );
    const tool = (n: string) => set.deferred.find((t) => t.name === n)!;
    await tool("marina_transcribe").execute("1", {
      source: "asset:a1",
      language: "en",
      context: "Harbour   names",
    });
    await tool("marina_speak").execute("2", {
      text: "Hello\nthere; world",
      voice: "cedar",
      format: "wav",
    });
    expect(commands).toEqual([
      "audio transcribe asset:a1 language:en -- Harbour names",
      "audio speak voice:cedar format:wav -- Hello there; world",
    ]);
    await expect(
      tool("marina_speak").execute("3", { text: "hi", voice: "two words" }),
    ).rejects.toThrow("single value");
  });
});
