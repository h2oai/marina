// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MediaJobRow } from "../../persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { canvasReaderFor, mayReadCanvasRow } from "../canvas-access";
import type { Engine } from "../engine";
import { defaultImageModel } from "../media/providers/image-registry";
import { lookAndReply } from "../media/vision";
import { type ModifierSpec, parseModifiers } from "../parse-input";

interface GenerateOptions {
  prompt: string;
  model?: string;
  style?: string;
  width?: number;
  height?: number;
  canvas?: string;
}

export function imageCommand(engine: Engine): CommandDef {
  return {
    category: "Canvas & Media",
    usage: [
      "image generate <prompt...>",
      "image generate <prompt...> [model:<provider/model>] [style:<style>] [width:<px>] [height:<px>] [canvas:<name>]",
      "image generate <prompt...> [style:synthwave] [width:1024] [canvas:name]",
      "image describe <node|asset|url> [question...] [model:<provider/model>]",
    ],
    name: "image",
    help: "Generate or read images. Usage: image generate <prompt...> [model:<provider/model>] [style:<style>] [width:<px>] [height:<px>] [canvas:<name>] (also --width 1024) | image describe <node|asset|url> [question] [model:<provider/model>]",
    handler: async (ctx, input) => {
      const sub = input.tokens[0];
      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: image generate <prompt...> [style:synthwave] [width:1024] [canvas:name]",
        );
        return;
      }
      if (sub === "describe" || sub === "look") {
        const who = ctx.findEntity(input.entity);
        ctx.send(
          input.entity,
          await lookAndReply(
            engine,
            { entityId: input.entity, name: who?.name ?? String(input.entity) },
            input.tokens.slice(1),
            "image",
          ),
        );
        return;
      }
      if (sub !== "generate") {
        ctx.send(
          input.entity,
          "Unknown subcommand. Usage: image generate <prompt...> | image describe <node|asset|url> [question]",
        );
        return;
      }
      const parsed = parseImageGenerateArgs(input.tokens.slice(1));
      if ("error" in parsed) {
        ctx.send(input.entity, parsed.error);
        return;
      }
      if (!engine.db || !engine.storage) {
        ctx.send(
          input.entity,
          "Image generation requires persistent storage. Configure storage to enable this command.",
        );
        return;
      }

      const entity = ctx.findEntity(input.entity);
      if (!entity) {
        ctx.send(input.entity, "Couldn't find you in this space — reconnect and retry.");
        return;
      }

      if (!engine.mediaManager) {
        ctx.send(
          input.entity,
          "Media pipeline is not configured. Ensure storage and provider keys are set.",
        );
        return;
      }

      const defaultModel = defaultImageModel(engine.db?.getDefaultModel());
      const model = parsed.model ?? defaultModel;
      const canvas = resolveMediaCanvas(engine, parsed.canvas, input.entity);

      try {
        const job = await engine.mediaManager.startJob({
          type: "image",
          entityId: input.entity,
          entityName: entity.name,
          prompt: parsed.prompt,
          model,
          width: parsed.width,
          height: parsed.height,
          style: parsed.style,
          canvasId: canvas,
        });

        sendMediaJobStatus(ctx, input.entity, job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.send(input.entity, `Image generation failed: ${message}`);
      }
    },
  };
}

export function sendMediaJobStatus(ctx: RoomContext, entityId: EntityId, job: MediaJobRow): void {
  let statusMessage = `Media job ${job.id} `;
  switch (job.status) {
    case "succeeded":
      statusMessage += "completed and was published to the canvas.";
      break;
    case "running":
      statusMessage += "is rendering. You'll see updates in the activity feed.";
      break;
    case "blocked":
      statusMessage += `was blocked: ${job.error ?? "moderation policy violation"}.`;
      break;
    case "failed":
      statusMessage += `failed: ${job.error ?? "unknown error"}.`;
      break;
    default:
      statusMessage += "is queued.";
  }
  if (job.cost_estimate) {
    statusMessage += ` Estimated cost: ~$${job.cost_estimate.toFixed(3)}.`;
  }
  ctx.send(entityId, statusMessage);
}

/** `image generate` modifiers: `model:openai/gpt-image-2 style:synthwave width:1024 canvas:x`. */
const IMAGE_GENERATE_SPEC: ModifierSpec = {
  model: { type: "string" },
  style: { type: "string" },
  width: { type: "int", aliases: ["w"] },
  height: { type: "int", aliases: ["h"] },
  canvas: { type: "string" },
};

/**
 * Parse `image generate` arguments. Modifiers may appear anywhere (a prompt
 * rarely contains `width:`-shaped words; use `--` to protect one that does),
 * in any of the shared spellings — `width:1024`, `width=1024`, `--width 1024`,
 * `--width=1024`. Everything else is the prompt.
 */
export function parseImageGenerateArgs(
  tokens: readonly string[],
): GenerateOptions | { error: string } {
  const mods = parseModifiers(tokens, IMAGE_GENERATE_SPEC);
  if (mods.errors.length > 0) return { error: mods.errors.join("; ") };
  const prompt = mods.rest.join(" ").trim();
  if (!prompt) {
    return { error: "Provide a prompt: image generate <prompt...>" };
  }
  const width = typeof mods.values.width === "number" ? mods.values.width : undefined;
  const height = typeof mods.values.height === "number" ? mods.values.height : undefined;
  if (width !== undefined && width <= 0) return { error: "Width must be a positive number." };
  if (height !== undefined && height <= 0) return { error: "Height must be a positive number." };
  return {
    prompt,
    ...(typeof mods.values.model === "string" ? { model: mods.values.model } : {}),
    ...(typeof mods.values.style === "string" ? { style: mods.values.style } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(typeof mods.values.canvas === "string" ? { canvas: mods.values.canvas } : {}),
  };
}

/**
 * The target canvas for generated media, by name or id. A private canvas the
 * caller may not read is treated as missing (the output goes to the caller's
 * own canvas), so the reply never confirms it exists.
 */
export function resolveMediaCanvas(
  engine: Engine,
  canvas: string | undefined,
  entityId: EntityId,
): string | undefined {
  if (!canvas || !engine.db) return undefined;
  const row = engine.db.getCanvasByName(canvas) ?? engine.db.getCanvas(canvas);
  if (!row) return undefined;
  return mayReadCanvasRow(row, canvasReaderFor(engine, entityId), "media canvas")
    ? row.id
    : undefined;
}
