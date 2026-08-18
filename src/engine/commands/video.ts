// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef } from "../../types";
import type { Engine } from "../engine";
import { sendMediaJobStatus } from "./image";

export function videoCommand(_engine: Engine): CommandDef {
  return {
    name: "video",
    help: "Generate videos. Usage: video generate <prompt...> [--model provider/model] [--duration <s>] [--fps <frames>] [--reference <asset>] [--canvas <name>]",
    handler: async (ctx, input) => {
      const engine = _engine;
      const sub = input.tokens[0];
      if (sub !== "generate") {
        ctx.send(input.entity, "Usage: video generate <prompt...>");
        return;
      }
      if (!engine.db || !engine.storage) {
        ctx.send(
          input.entity,
          "Video generation requires persistent storage. Configure storage to enable this command.",
        );
        return;
      }
      if (!engine.mediaManager) {
        ctx.send(
          input.entity,
          "Media pipeline is not configured. Ensure storage and provider keys are set.",
        );
        return;
      }

      const parsed = parseVideoArgs(input.tokens.slice(1));
      if ("error" in parsed) {
        ctx.send(input.entity, parsed.error);
        return;
      }

      const entity = ctx.findEntity(input.entity);
      if (!entity) {
        ctx.send(input.entity, "Entity not found.");
        return;
      }

      const model = parsed.model ?? "runway/gen3-alpha";
      const canvas = resolveCanvas(engine, parsed.canvas);

      try {
        const job = await engine.mediaManager.startJob({
          type: "video",
          entityId: input.entity,
          entityName: entity.name,
          prompt: parsed.prompt,
          model,
          duration: parsed.duration,
          fps: parsed.fps,
          referenceImage: parsed.referenceImage,
          canvasId: canvas,
          aspectRatio: parsed.aspectRatio,
        });
        sendMediaJobStatus(ctx, input.entity, job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.send(input.entity, `Video generation failed: ${message}`);
      }
    },
  };
}

interface VideoOptions {
  prompt: string;
  model?: string;
  duration?: number;
  fps?: number;
  referenceImage?: string;
  canvas?: string;
  aspectRatio?: string;
}

function parseVideoArgs(tokens: string[]): VideoOptions | { error: string } {
  const opts: VideoOptions = { prompt: "" };
  const promptParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2).toLowerCase();
      let value: string | undefined;
      if (token.includes("=")) {
        value = token.split("=", 2)[1];
      } else {
        value = tokens[i + 1];
        if (value && !value.startsWith("--")) {
          i++;
        } else {
          value = undefined;
        }
      }
      switch (key) {
        case "model":
          if (value) opts.model = value;
          break;
        case "duration":
          if (value) opts.duration = Number(value);
          break;
        case "fps":
          if (value) opts.fps = Number(value);
          break;
        case "reference":
          if (value) opts.referenceImage = value;
          break;
        case "canvas":
          if (value) opts.canvas = value;
          break;
        case "aspect":
        case "ratio":
        case "aspect_ratio":
          if (value) opts.aspectRatio = value;
          break;
        default:
          break;
      }
    } else {
      promptParts.push(token);
    }
  }

  opts.prompt = promptParts.join(" ").trim();
  if (!opts.prompt) {
    return { error: "Provide a prompt: video generate <prompt...>" };
  }

  if (opts.duration !== undefined && (!Number.isFinite(opts.duration) || opts.duration <= 0)) {
    return { error: "Duration must be a positive number of seconds." };
  }
  if (opts.fps !== undefined && (!Number.isFinite(opts.fps) || opts.fps <= 0)) {
    return { error: "FPS must be a positive number." };
  }

  return opts;
}

function resolveCanvas(engine: Engine, canvas?: string): string | undefined {
  if (!canvas || !engine.db) return undefined;
  const byName = engine.db.getCanvasByName(canvas);
  if (byName) return byName.id;
  const byId = engine.db.getCanvas(canvas);
  return byId?.id ?? undefined;
}
