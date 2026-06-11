import { Buffer } from "node:buffer";

const RUNWAY_ENDPOINT = "https://api.runwayml.com/v1/generations";

interface RunwayBaseOptions {
  apiKey: string;
}

interface RunwayStartOptions extends RunwayBaseOptions {
  model: string;
  prompt: string;
  duration?: number;
  fps?: number;
  referenceImage?: string;
  aspectRatio?: string;
}

interface RunwayPollOptions extends RunwayBaseOptions {
  providerJobId: string;
}

interface RunwayAsset {
  url: string;
  mimeType: string;
  filename: string;
}

export interface RunwayStartResult {
  status: "running" | "succeeded" | "failed";
  providerJobId?: string;
  progress?: number;
  error?: string;
  asset?: { data: Uint8Array; mimeType: string; filename: string };
}

export interface RunwayPollResult {
  status: "running" | "succeeded" | "failed";
  progress?: number;
  error?: string;
  asset?: { data: Uint8Array; mimeType: string; filename: string };
}

export async function startRunwayVideoJob(opts: RunwayStartOptions): Promise<RunwayStartResult> {
  try {
    const res = await fetch(RUNWAY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        mode: "text-to-video",
        parameters: {
          duration: opts.duration ?? 10,
          fps: opts.fps ?? 24,
          aspect_ratio: opts.aspectRatio ?? "16:9",
          reference_image: opts.referenceImage ?? null,
        },
      }),
    });
    const json = (await res.json()) as RunwayGenerationResponse;
    if (!res.ok) {
      return {
        status: "failed",
        error: json.error?.message ?? `Runway start failed (${res.status})`,
      };
    }
    if (json.status === "SUCCEEDED") {
      const asset = await fetchRunwayAsset(json.outputs?.[0]);
      if (!asset) {
        return { status: "failed", error: "Runway returned success without asset." };
      }
      return {
        status: "succeeded",
        asset,
      };
    }
    return {
      status: "running",
      providerJobId: json.id,
      progress: json.progress ?? 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: msg };
  }
}

export async function pollRunwayVideoJob(opts: RunwayPollOptions): Promise<RunwayPollResult> {
  try {
    const res = await fetch(`${RUNWAY_ENDPOINT}/${opts.providerJobId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
    });
    const json = (await res.json()) as RunwayGenerationResponse;
    if (!res.ok) {
      return {
        status: "failed",
        error: json.error?.message ?? `Runway poll failed (${res.status})`,
      };
    }
    if (json.status === "RUNNING" || json.status === "QUEUED") {
      return {
        status: "running",
        progress: json.progress ?? 0,
      };
    }
    if (json.status === "FAILED") {
      return {
        status: "failed",
        error: json.error?.message ?? "Runway reported failure.",
      };
    }
    if (json.status === "CANCELED") {
      return {
        status: "failed",
        error: "Runway job was canceled.",
      };
    }
    const asset = await fetchRunwayAsset(json.outputs?.[0]);
    if (!asset) {
      return { status: "failed", error: "Runway returned success without asset." };
    }
    return {
      status: "succeeded",
      asset,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: msg };
  }
}

interface RunwayGenerationResponse {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress?: number;
  outputs?: RunwayOutput[];
  error?: { message?: string };
}

interface RunwayOutput {
  id: string;
  url?: string;
  artifact_type?: string;
  mime_type?: string;
  file_name?: string;
}

async function fetchRunwayAsset(output?: RunwayOutput): Promise<{
  data: Uint8Array;
  mimeType: string;
  filename: string;
} | null> {
  if (!output?.url) return null;
  const res = await fetch(output.url);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = output.mime_type ?? res.headers.get("content-type") ?? "video/mp4";
  const filename = output.file_name ?? `video-${Date.now()}.mp4`;
  return {
    data: new Uint8Array(buffer),
    mimeType: mime,
    filename,
  };
}
