import { Buffer } from "node:buffer";
import { bareModel } from "./image-util";

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";

interface OpenAIImageOptions {
  apiKey: string;
  prompt: string;
  model: string;
  width?: number;
  height?: number;
  style?: string;
  signal?: AbortSignal;
}

interface ModerationOptions {
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface ModerationResult {
  blocked: boolean;
  reason?: string;
}

export interface GeneratedAsset {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface OpenAIImageResult {
  status: "succeeded" | "failed";
  asset: GeneratedAsset | null;
  error?: string;
}

export async function moderateOpenAIText(
  opts: ModerationOptions,
): Promise<ModerationResult | null> {
  try {
    const res = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: opts.prompt,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
    };
    const flagged = json.results?.[0]?.flagged ?? false;
    if (!flagged) return { blocked: false };
    const categories = Object.entries(json.results?.[0]?.categories ?? {})
      .filter(([, val]) => val)
      .map(([cat]) => cat);
    return {
      blocked: true,
      reason: categories.length > 0 ? `Flagged categories: ${categories.join(", ")}` : undefined,
    };
  } catch {
    return null;
  }
}

export async function generateOpenAIImage(opts: OpenAIImageOptions): Promise<OpenAIImageResult> {
  const size = formatSize(opts.width, opts.height);
  try {
    const res = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: bareModel(opts.model),
        prompt: opts.prompt,
        size,
        style: opts.style ?? undefined,
        response_format: "b64_json",
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        status: "failed",
        asset: null,
        error: `OpenAI image request failed: ${res.status} ${text}`,
      };
    }
    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      return { status: "failed", asset: null, error: "No image data returned." };
    }
    const buffer = Buffer.from(b64, "base64");
    const filename = `image-${Date.now()}.png`;
    return {
      status: "succeeded",
      asset: {
        data: new Uint8Array(buffer),
        mimeType: "image/png",
        filename,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", asset: null, error: msg };
  }
}

function formatSize(width?: number, height?: number): string {
  const w = clampDimension(width);
  const h = clampDimension(height);
  return `${w}x${h}`;
}

function clampDimension(dim?: number): number {
  if (!dim || !Number.isFinite(dim)) return 1024;
  const rounded = Math.round(dim);
  return Math.min(Math.max(rounded, 256), 2048);
}
