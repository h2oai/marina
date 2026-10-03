// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Media generation tools (`marina_generate_image`, `marina_generate_video`),
// filtered by the agent's `AgentSupports` in `createProfileToolset`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { execCommand, type ToolContext } from "./shared";

const imageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Describe the image to generate" }),
  model: Type.Optional(
    Type.String({
      description: "Provider/model ID (default openai/gpt-image-2)",
    }),
  ),
  style: Type.Optional(Type.String({ description: "Style hint (e.g. synthwave, watercolor)" })),
  width: Type.Optional(
    Type.Number({
      description: "Image width in pixels (256-2048)",
      minimum: 256,
      maximum: 2048,
    }),
  ),
  height: Type.Optional(
    Type.Number({
      description: "Image height in pixels (256-2048)",
      minimum: 256,
      maximum: 2048,
    }),
  ),
  canvas: Type.Optional(
    Type.String({
      description: "Canvas name or id to publish the result to",
    }),
  ),
});

const videoGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Describe the video to generate" }),
  model: Type.Optional(
    Type.String({
      description: "Provider/model ID (default runway/gen3-alpha)",
    }),
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Video duration in seconds (1-60)",
      minimum: 1,
      maximum: 60,
    }),
  ),
  fps: Type.Optional(
    Type.Number({
      description: "Frames per second (8-60)",
      minimum: 8,
      maximum: 60,
    }),
  ),
  reference: Type.Optional(
    Type.String({
      description: "Optional reference image asset id or URL",
    }),
  ),
  aspect: Type.Optional(
    Type.String({
      description: "Aspect ratio (e.g. 16:9, 9:16)",
    }),
  ),
  canvas: Type.Optional(
    Type.String({
      description: "Canvas name or id to publish the result to",
    }),
  ),
});

const lookSchema = Type.Object({
  source: Type.String({
    description: "Canvas node id, asset id, or http(s) URL of an image, PDF, video or text",
  }),
  question: Type.Optional(Type.String({ description: "What to look for or answer" })),
});

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

export function createMediaTools(ctx: ToolContext): AgentTool[] {
  return [
    {
      name: "marina_generate_image",
      label: "Generate Image",
      description:
        "Create an image from a text prompt. Requires storage + image-capable model API keys.",
      parameters: imageGenerateSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as Static<typeof imageGenerateSchema>;
        const prompt = sanitizePrompt(p.prompt);
        if (!prompt) {
          throw new Error("Prompt is required to generate an image.");
        }
        let command = `image generate ${prompt}`;
        if (p.model) command += ` --model ${p.model}`;
        if (p.style) command += ` --style ${p.style}`;
        if (typeof p.width === "number") command += ` --width ${Math.round(p.width)}`;
        if (typeof p.height === "number") command += ` --height ${Math.round(p.height)}`;
        if (p.canvas) command += ` --canvas ${p.canvas}`;
        return execCommand(ctx, command, signal);
      },
    },
    {
      name: "marina_generate_video",
      label: "Generate Video",
      description:
        "Create a short video from a text prompt. Requires storage + video-capable provider keys.",
      parameters: videoGenerateSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as Static<typeof videoGenerateSchema>;
        const prompt = sanitizePrompt(p.prompt);
        if (!prompt) {
          throw new Error("Prompt is required to generate a video.");
        }
        let command = `video generate ${prompt}`;
        if (p.model) command += ` --model ${p.model}`;
        if (typeof p.duration === "number") command += ` --duration ${Math.round(p.duration)}`;
        if (typeof p.fps === "number") command += ` --fps ${Math.round(p.fps)}`;
        if (p.reference) command += ` --reference ${p.reference}`;
        if (p.aspect) command += ` --aspect ${p.aspect}`;
        if (p.canvas) command += ` --canvas ${p.canvas}`;
        return execCommand(ctx, command, signal);
      },
    },
    {
      name: "marina_see",
      label: "See",
      description:
        "See an image, PDF page, video keyframes or text on the canvas (or at a URL) and answer a question about it; canvas results are written back as a linked node.",
      parameters: lookSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as Static<typeof lookSchema>;
        const source = p.source.trim();
        if (!source || /\s/.test(source)) throw new Error("source must be one id or URL.");
        const question = sanitizePrompt(p.question ?? "");
        return execCommand(ctx, `canvas look ${source}${question ? ` ${question}` : ""}`, signal);
      },
    },
  ];
}
