// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `audio` — speech-to-text and text-to-speech (`src/engine/media/audio.ts`).
 *
 *   audio transcribe <asset|node|url> [model:…] [language:…] [-- <context>]
 *   audio transcript <asset> [segments]
 *   audio speak [voice:…] [model:…] [format:mp3|wav|opus] [speed:…] [canvas:…] -- <text>
 *
 * A transcript is stored on the asset (`metadata.transcript`) when the caller
 * may change that asset (its owner, the creator of an owning agent, or an
 * operator); anyone who may read it may transcribe it for themselves. A URL is
 * kept as the caller's own asset (origin `tool`) so its transcript has a home.
 * Speech becomes an audio asset (origin `generated`, with provenance) and a
 * node on the caller's canvas, or `canvas:<name>`.
 */

import type { AssetRow } from "../../persistence/db-assets";
import { normalizeAssetMime } from "../../storage/asset-mime";
import type { CommandDef, Entity, EntityId } from "../../types";
import { canvasReaderFor, mayReadAsset } from "../canvas-access";
import { withoutRefusal } from "../command-response";
import type { Engine } from "../engine";
import { getErrorMessage } from "../errors";
import { ingestAsset } from "../media/asset-library";
import {
  AudioError,
  audioMaxBytes,
  type StoredTranscript,
  saveTranscript,
  speakText,
  transcribeAudio,
} from "../media/audio";
import { SPEECH_FORMATS, type SpeechFormat } from "../media/providers/audio-util";
import { loadVisualSource } from "../media/vision";
import { ownershipRefusal } from "../ownership";
import {
  type ModifierSpec,
  parseModifiers,
  splitOnTerminator,
  unknownSubcommand,
} from "../parse-input";
import { resolveMediaCanvas } from "./image";

/** Characters of a transcript shown in the reply (the rest: `audio transcript <asset>`). */
export const TRANSCRIPT_EXCERPT_CHARS = 1500;
/** Characters `audio transcript` prints before pointing at the asset API. */
const TRANSCRIPT_READ_CHARS = 12_000;
/** Speech formats the command stores (headerless pcm is HTTP-only). */
const STORED_FORMATS: readonly SpeechFormat[] = SPEECH_FORMATS.filter((f) => f !== "pcm");

const USAGE =
  "Usage: audio transcribe <asset|node|url> [model:<provider/model>] [language:<code>[,<code>]] [-- <context>] | audio transcript <asset> [segments] | audio speak [voice:<voice>] [model:<provider/model>] [format:mp3|wav|opus|aac|flac] [speed:<0.25-4>] [canvas:<name>] -- <text>";

const TRANSCRIBE_SPEC: ModifierSpec = {
  model: { type: "string" },
  language: { type: "string", aliases: ["lang", "languages"] },
};

const SPEAK_SPEC: ModifierSpec = {
  voice: { type: "string" },
  model: { type: "string" },
  format: { type: "string" },
  speed: { type: "number" },
  canvas: { type: "string" },
};

function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function money(usd: number | null): string {
  return usd ? ` ~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}.` : "";
}

/** The transcript stored on an asset, if any. */
export function storedTranscript(asset: Pick<AssetRow, "metadata">): StoredTranscript | undefined {
  try {
    const meta = JSON.parse(asset.metadata || "{}") as { transcript?: unknown };
    const t = meta.transcript as StoredTranscript | undefined;
    return t && typeof t === "object" && typeof t.text === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

function mayChangeAsset(engine: Engine, entity: Entity, asset: AssetRow): boolean {
  // A probe, not the command's answer: a "no" here only skips saving the
  // transcript, so it never fails the transcription.
  return (
    withoutRefusal(() =>
      ownershipRefusal(
        entity,
        {
          owners: [asset.entity_name],
          creatorOf: (name) => engine.db?.getAgentConfig(name)?.spawned_by || undefined,
        },
        "",
      ),
    ) === undefined
  );
}

async function transcribe(engine: Engine, entity: Entity, args: string) {
  const [head, context] = splitOnTerminator(args);
  const mods = parseModifiers(head.split(/\s+/).filter(Boolean), TRANSCRIBE_SPEC);
  if (mods.errors.length) return mods.errors.join("; ");
  const ref = mods.rest[0];
  if (!ref || mods.rest.length > 1) {
    return "Usage: audio transcribe <asset|node|url> [model:<provider/model>] [language:<code>] [-- <context>]";
  }
  const manager = engine.mediaManager;
  if (!manager || !engine.db) {
    return "Audio needs persistent storage and the media pipeline (configure storage).";
  }
  const reader = canvasReaderFor(engine, entity.id, { inWorld: true });
  let src: Awaited<ReturnType<typeof loadVisualSource>>;
  try {
    // The audio size cap, not the vision one, bounds what is read.
    src = await loadVisualSource(engine, ref, reader, {
      ...process.env,
      MARINA_VISION_MAX_BYTES: String(audioMaxBytes()),
    });
  } catch (error) {
    return getErrorMessage(error).replace(
      "vision size cap",
      "audio size cap (MARINA_AUDIO_MAX_BYTES)",
    );
  }
  const mime = src.mime.split(";")[0]!.trim().toLowerCase();
  if (!mime.startsWith("audio/") && !mime.startsWith("video/")) {
    return `"${ref}" is ${mime || "of unknown type"}, not audio or video.`;
  }
  let asset: AssetRow | undefined = src.assetId ? engine.db.getAsset(src.assetId) : undefined;
  if (!asset && /^https?:\/\//i.test(ref)) {
    try {
      const name = new URL(ref).pathname.split("/").pop() || "audio";
      const ingested = await ingestAsset(engine, {
        owner: entity.name,
        filename: name.slice(0, 120),
        mime: normalizeAssetMime(mime, src.data),
        data: src.data,
        origin: "tool",
        provenance: { source: ref },
        actor: entity.id,
        dedupe: true,
      });
      asset = ingested.asset;
    } catch (error) {
      return `Could not keep the downloaded audio: ${getErrorMessage(error)}`;
    }
  }
  const languages =
    typeof mods.values.language === "string"
      ? mods.values.language
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean)
      : undefined;
  try {
    const out = await transcribeAudio(manager.audioHost(), {
      entityId: entity.id,
      entityName: entity.name,
      data: src.data,
      mime,
      label: asset ? `asset:${asset.id}` : src.label,
      ...(typeof mods.values.model === "string" ? { model: mods.values.model } : {}),
      ...(languages?.length ? { languages } : {}),
      ...(context ? { prompt: context } : {}),
      ...(asset ? { assetId: asset.id } : {}),
    });
    let saved = "";
    if (asset) {
      if (mayChangeAsset(engine, entity, asset)) {
        saveTranscript(engine, asset, out, entity.id);
        saved = ` Saved on asset ${asset.id} (metadata.transcript); full text: audio transcript ${asset.id}`;
      } else {
        saved = ` Not saved on asset ${asset.id}: only its owner or an operator can change it.`;
      }
    }
    const facts = [
      out.model,
      out.durationSec !== undefined ? `${clock(out.durationSec)}` : undefined,
      out.language,
      out.pieces > 1 ? `${out.pieces} pieces` : undefined,
    ].filter(Boolean);
    const body = out.text ? excerpt(out.text, TRANSCRIPT_EXCERPT_CHARS) : "(no speech recognized)";
    return `Transcript [${facts.join(", ")}]${asset ? ` asset:${asset.id}` : ""}:\n${body}\n${saved.trim()}${money(out.costUsd)}`.trimEnd();
  } catch (error) {
    return `Transcription failed: ${getErrorMessage(error)}`;
  }
}

function readTranscript(engine: Engine, entity: Entity, tokens: string[]): string {
  const ref = tokens[0]?.replace(/^asset:/, "");
  if (!ref || !engine.db) return "Usage: audio transcript <asset> [segments]";
  const asset = engine.db.getAsset(ref);
  const reader = canvasReaderFor(engine, entity.id, { inWorld: true });
  // Same read rule as `asset show`; an unreadable asset is "not found".
  if (!asset || !mayReadAsset(engine, asset, reader, "audio transcript")) {
    return `Asset "${ref}" not found.`;
  }
  const t = storedTranscript(asset);
  if (!t) return `Asset ${asset.id} has no transcript. Make one: audio transcribe ${asset.id}`;
  const head = `Transcript of ${asset.filename} [${[t.model, t.language, new Date(t.createdAt).toISOString().slice(0, 16)].filter(Boolean).join(", ")}]:`;
  if (tokens[1] === "segments") {
    if (!t.segments?.length)
      return `${head}\n(no timed segments — the model returned plain text)\n${excerpt(t.text, TRANSCRIPT_READ_CHARS)}`;
    const lines = t.segments.map(
      (s) => `[${clock(s.start)}–${clock(s.end)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`,
    );
    return `${head}\n${excerpt(lines.join("\n"), TRANSCRIPT_READ_CHARS)}`;
  }
  return `${head}\n${excerpt(t.text, TRANSCRIPT_READ_CHARS)}`;
}

async function speak(engine: Engine, entity: Entity, args: string) {
  const [head, tail] = splitOnTerminator(args);
  const mods = parseModifiers(head.split(/\s+/).filter(Boolean), SPEAK_SPEC);
  if (mods.errors.length) return mods.errors.join("; ");
  const text = (tail ?? mods.rest.join(" ")).replace(/\s+/g, " ").trim();
  if (!text) {
    return "Usage: audio speak [voice:<voice>] [model:<provider/model>] [format:mp3|wav|opus] -- <text>";
  }
  const format = (
    typeof mods.values.format === "string" ? mods.values.format.toLowerCase() : "mp3"
  ) as SpeechFormat;
  if (!STORED_FORMATS.includes(format)) {
    return `format must be one of ${STORED_FORMATS.join(", ")}.`;
  }
  const manager = engine.mediaManager;
  if (!manager || !engine.db) {
    return "Audio needs persistent storage and the media pipeline (configure storage).";
  }
  const canvasId = resolveMediaCanvas(
    engine,
    typeof mods.values.canvas === "string" ? mods.values.canvas : undefined,
    entity.id,
  );
  try {
    const out = await speakText(manager.audioHost(), {
      entityId: entity.id,
      entityName: entity.name,
      text,
      format,
      ...(typeof mods.values.model === "string" ? { model: mods.values.model } : {}),
      ...(typeof mods.values.voice === "string" ? { voice: mods.values.voice } : {}),
      ...(typeof mods.values.speed === "number" ? { speed: mods.values.speed } : {}),
      store: { ...(canvasId ? { canvasId } : {}), publish: true },
    });
    const facts = [out.model, out.voice, out.format].filter(Boolean).join(", ");
    const where = out.nodeId ? ` Published to canvas ${out.canvasId} (node ${out.nodeId}).` : "";
    return `Speech ready: asset:${out.assetId} [${facts}].${where}${money(out.costUsd)}`;
  } catch (error) {
    return `Speech failed: ${error instanceof AudioError ? error.message : getErrorMessage(error)}`;
  }
}

export function audioCommand(engine: Engine): CommandDef {
  return {
    name: "audio",
    category: "Canvas & Media",
    help: `Speech to text and text to speech. ${USAGE}`,
    usage: [
      {
        syntax: "audio transcribe <source> [model:<provider/model>] [language:<code>]",
        effect: "write",
      },
      {
        syntax: "audio transcribe <source> [model:<provider/model>] [language:<code>] -- <context>",
        effect: "write",
      },
      { syntax: "audio transcript <asset> [segments]", effect: "read" },
      {
        syntax:
          "audio speak [voice:<voice>] [model:<provider/model>] [format:mp3|wav|opus|aac|flac] [speed:<number>] [canvas:<name>] -- <text>",
        effect: "write",
      },
    ],
    readOnlyForm: (input) => input.tokens[0]?.toLowerCase() === "transcript",
    handler: async (ctx, input) => {
      const sub = input.tokens[0]?.toLowerCase();
      const entity = engine.entities.get(input.entity);
      if (!sub) {
        ctx.send(input.entity, USAGE);
        return;
      }
      if (!entity) {
        ctx.send(input.entity, "Couldn't find you in this space — reconnect and retry.");
        return;
      }
      const rest = input.args.replace(/^\s*\S+\s*/, "");
      let reply: string;
      if (sub === "transcribe" || sub === "stt") {
        reply = await transcribe(engine, entity, rest);
      } else if (sub === "transcript") {
        reply = readTranscript(engine, entity, input.tokens.slice(1));
      } else if (sub === "speak" || sub === "say" || sub === "tts") {
        reply = await speak(engine, entity, rest);
      } else {
        reply = unknownSubcommand("audio", sub, USAGE);
      }
      ctx.send(input.entity as EntityId, reply);
    },
  };
}
