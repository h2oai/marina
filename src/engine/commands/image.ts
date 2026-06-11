import type { MediaJobRow } from "../../persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import type { Engine } from "../engine";

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
    name: "image",
    help: "Generate images. Usage: image generate <prompt...> [--model <provider/model>] [--style <style>] [--width <px>] [--height <px>] [--canvas <name>]",
    handler: async (ctx, input) => {
      const sub = input.tokens[0];
      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: image generate <prompt...> [--style synthwave] [--width 1024] [--canvas name]",
        );
        return;
      }
      if (sub !== "generate") {
        ctx.send(input.entity, "Unknown subcommand. Usage: image generate <prompt...>");
        return;
      }
      const parsed = parseGenerateArgs(input.tokens.slice(1));
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
        ctx.send(input.entity, "Entity not found.");
        return;
      }

      if (!engine.mediaManager) {
        ctx.send(
          input.entity,
          "Media pipeline is not configured. Ensure storage and provider keys are set.",
        );
        return;
      }

      const defaultModel = engine.db?.getDefaultModel() ?? "openai/gpt-image-1";
      const model = parsed.model ?? defaultModel;
      const canvas = resolveCanvas(engine, parsed.canvas);

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

function parseGenerateArgs(tokens: string[]): GenerateOptions | { error: string } {
  const promptParts: string[] = [];
  const opts: GenerateOptions = { prompt: "" };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const [flag, valueInline] = token.split("=", 2);
      let value = valueInline;
      if (!value) {
        value = tokens[i + 1];
        if (value && !value.startsWith("--")) {
          i++;
        } else {
          value = undefined;
        }
      }
      const key = flag!.slice(2).toLowerCase();
      switch (key) {
        case "model":
          if (value) opts.model = value;
          break;
        case "style":
          if (value) opts.style = value;
          break;
        case "width":
          if (value) opts.width = Number(value);
          break;
        case "height":
          if (value) opts.height = Number(value);
          break;
        case "canvas":
          if (value) opts.canvas = value;
          break;
        default:
          break;
      }
    } else {
      promptParts.push(token);
    }
    i++;
  }

  opts.prompt = promptParts.join(" ").trim();
  if (!opts.prompt) {
    return { error: "Provide a prompt: image generate <prompt...>" };
  }

  if (opts.width !== undefined && (!Number.isFinite(opts.width) || opts.width <= 0)) {
    return { error: "Width must be a positive number." };
  }
  if (opts.height !== undefined && (!Number.isFinite(opts.height) || opts.height <= 0)) {
    return { error: "Height must be a positive number." };
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
