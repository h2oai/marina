import { afterEach, describe, expect, it } from "bun:test";
import { generateAutomatic1111Image } from "../src/engine/media/providers/automatic1111";
import { generateGoogleImage } from "../src/engine/media/providers/google-image";
import {
  getImageProvider,
  imageProviderRequiresKey,
  knownImageProviders,
} from "../src/engine/media/providers/image-registry";
import { bareModel, nearestAspectRatio } from "../src/engine/media/providers/image-util";
import { generateOpenAICompatibleImage } from "../src/engine/media/providers/openai-compatible-image";
import { generateStabilityImage } from "../src/engine/media/providers/stability";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock; returns a capture of the last call + a call count. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  url: () => string;
  init: () => RequestInit | undefined;
  calls: () => number;
} {
  let lastUrl = "";
  let lastInit: RequestInit | undefined;
  let count = 0;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    count += 1;
    lastUrl = String(url);
    lastInit = init;
    return Promise.resolve(handler(lastUrl, init));
  }) as unknown as typeof fetch;
  return { url: () => lastUrl, init: () => lastInit, calls: () => count };
}

describe("image-util helpers", () => {
  it("bareModel strips the provider prefix", () => {
    expect(bareModel("openai/gpt-image-1")).toBe("gpt-image-1");
    expect(bareModel("stability/core")).toBe("core");
    expect(bareModel("gpt-image-1")).toBe("gpt-image-1");
  });

  it("nearestAspectRatio snaps to the closest allowed ratio", () => {
    const allowed = ["1:1", "16:9", "9:16"];
    expect(nearestAspectRatio(1024, 1024, allowed)).toBe("1:1");
    expect(nearestAspectRatio(1920, 1080, allowed)).toBe("16:9");
    expect(nearestAspectRatio(1080, 1920, allowed)).toBe("9:16");
    expect(nearestAspectRatio(undefined, undefined, allowed)).toBe("1:1");
  });
});

describe("image-registry", () => {
  const prev = process.env.TOGETHER_IMAGE_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.TOGETHER_IMAGE_BASE_URL;
    else process.env.TOGETHER_IMAGE_BASE_URL = prev;
  });

  it("resolves built-ins + Automatic1111; cloud needs a key, local doesn't", () => {
    expect(typeof getImageProvider("openai")).toBe("function");
    expect(typeof getImageProvider("stability")).toBe("function");
    expect(typeof getImageProvider("google")).toBe("function");
    expect(typeof getImageProvider("flux")).toBe("function");
    expect(typeof getImageProvider("automatic1111")).toBe("function");
    expect(typeof getImageProvider("a1111")).toBe("function");

    expect(imageProviderRequiresKey("openai")).toBe(true);
    expect(imageProviderRequiresKey("stability")).toBe(true);
    expect(imageProviderRequiresKey("flux")).toBe(true);
    expect(imageProviderRequiresKey("automatic1111")).toBe(false);
  });

  it("resolves an arbitrary provider once <PROVIDER>_IMAGE_BASE_URL is set", () => {
    delete process.env.TOGETHER_IMAGE_BASE_URL;
    expect(getImageProvider("together")).toBeUndefined();
    process.env.TOGETHER_IMAGE_BASE_URL = "https://api.together.xyz/v1";
    expect(typeof getImageProvider("together")).toBe("function");
    expect(imageProviderRequiresKey("together")).toBe(false);
  });
});

describe("generateStabilityImage", () => {
  it("posts a multipart form to the variant endpoint and returns image bytes", async () => {
    const cap = mockFetch(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const res = await generateStabilityImage({
      apiKey: "sk-test",
      model: "stability/sd3",
      prompt: "a koi pond",
      width: 1920,
      height: 1080,
    });

    expect(cap.url()).toBe("https://api.stability.ai/v2beta/stable-image/generate/sd3");
    const form = cap.init()?.body as FormData;
    expect(form.get("prompt")).toBe("a koi pond");
    expect(form.get("output_format")).toBe("png");
    expect(form.get("aspect_ratio")).toBe("16:9");
    expect(res.status).toBe("succeeded");
    expect(res.asset?.mimeType).toBe("image/png");
    expect(res.asset?.data.byteLength).toBe(4);
  });

  it("maps sdxl/unknown variants to core and forwards a valid style preset only", async () => {
    const cap = mockFetch(() => new Response(new Uint8Array([9]), { status: 200 }));

    await generateStabilityImage({
      apiKey: "k",
      model: "stability/sdxl",
      prompt: "p",
      style: "not-a-real-preset",
    });
    expect(cap.url()).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    expect((cap.init()?.body as FormData).get("style_preset")).toBeNull();

    await generateStabilityImage({
      apiKey: "k",
      model: "stability/core",
      prompt: "p",
      style: "anime",
    });
    expect((cap.init()?.body as FormData).get("style_preset")).toBe("anime");
  });

  it("surfaces a provider error", async () => {
    mockFetch(() => new Response("bad prompt", { status: 400 }));
    const res = await generateStabilityImage({ apiKey: "k", model: "stability/core", prompt: "x" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("400");
  });
});

describe("generateGoogleImage", () => {
  it("calls :predict with the bare model and decodes base64 bytes", async () => {
    const cap = mockFetch(() =>
      Response.json({
        predictions: [
          { bytesBase64Encoded: Buffer.from("hello").toString("base64"), mimeType: "image/png" },
        ],
      }),
    );

    const res = await generateGoogleImage({
      apiKey: "AIza-test",
      model: "google/imagen-3.0-generate-002",
      prompt: "a city",
      width: 1024,
      height: 768,
    });

    expect(cap.url()).toContain("/models/imagen-3.0-generate-002:predict");
    expect(cap.url()).toContain("key=AIza-test");
    const body = JSON.parse(String(cap.init()?.body)) as { instances: { prompt: string }[] };
    expect(body.instances[0]!.prompt).toBe("a city");
    expect(res.status).toBe("succeeded");
    expect(Buffer.from(res.asset!.data).toString()).toBe("hello");
  });
});

describe("generateAutomatic1111Image (local SD)", () => {
  const prev = process.env.A1111_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.A1111_BASE_URL;
    else process.env.A1111_BASE_URL = prev;
  });

  it("posts txt2img to the configured base and decodes the first image", async () => {
    process.env.A1111_BASE_URL = "http://localhost:7860/";
    const cap = mockFetch(() => Response.json({ images: [Buffer.from("png").toString("base64")] }));
    const res = await generateAutomatic1111Image({
      apiKey: "",
      model: "automatic1111/realvisxl",
      prompt: "a cat",
      width: 768,
      height: 768,
    });
    expect(cap.url()).toBe("http://localhost:7860/sdapi/v1/txt2img");
    const body = JSON.parse(String(cap.init()?.body)) as {
      prompt: string;
      override_settings?: { sd_model_checkpoint?: string };
    };
    expect(body.prompt).toBe("a cat");
    expect(body.override_settings?.sd_model_checkpoint).toBe("realvisxl");
    expect(res.status).toBe("succeeded");
    expect(Buffer.from(res.asset!.data).toString()).toBe("png");
  });

  it("omits the checkpoint override for a bare provider id", async () => {
    const cap = mockFetch(() => Response.json({ images: [Buffer.from("x").toString("base64")] }));
    await generateAutomatic1111Image({ apiKey: "", model: "a1111", prompt: "p" });
    const body = JSON.parse(String(cap.init()?.body)) as { override_settings?: unknown };
    expect(body.override_settings).toBeUndefined();
  });
});

describe("generateOpenAICompatibleImage (generic endpoint)", () => {
  const prev = process.env.TOGETHER_IMAGE_BASE_URL;
  const prevKey = process.env.TOGETHER_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.TOGETHER_IMAGE_BASE_URL;
    else process.env.TOGETHER_IMAGE_BASE_URL = prev;
    if (prevKey === undefined) delete process.env.TOGETHER_API_KEY;
    else process.env.TOGETHER_API_KEY = prevKey;
  });

  it("fails clearly when no endpoint is configured", async () => {
    delete process.env.TOGETHER_IMAGE_BASE_URL;
    const res = await generateOpenAICompatibleImage({
      apiKey: "",
      model: "together/flux",
      prompt: "p",
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("TOGETHER_IMAGE_BASE_URL");
  });

  it("posts /images/generations with the bare model + env key", async () => {
    process.env.TOGETHER_IMAGE_BASE_URL = "https://api.together.xyz/v1";
    process.env.TOGETHER_API_KEY = "tok";
    const cap = mockFetch(() =>
      Response.json({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }),
    );
    const res = await generateOpenAICompatibleImage({
      apiKey: "",
      model: "together/black-forest-labs/FLUX.1-schnell",
      prompt: "a tree",
    });
    expect(cap.url()).toBe("https://api.together.xyz/v1/images/generations");
    expect((cap.init()?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(cap.init()?.body)) as { model: string };
    expect(body.model).toBe("black-forest-labs/FLUX.1-schnell");
    expect(res.status).toBe("succeeded");
    expect(Buffer.from(res.asset!.data).toString()).toBe("img");
  });
});

import { generateFluxImage } from "../src/engine/media/providers/flux";

describe("generateFluxImage (Black Forest Labs)", () => {
  const prevKey = process.env.BFL_API_KEY;
  afterEach(() => {
    if (prevKey === undefined) delete process.env.BFL_API_KEY;
    else process.env.BFL_API_KEY = prevKey;
  });

  it("submits to the model endpoint, polls get_result, and downloads the sample", async () => {
    const seen: string[] = [];
    const cap = mockFetch((url, init) => {
      seen.push(url);
      if (url.includes("/v1/get_result")) {
        return Response.json({ status: "Ready", result: { sample: "https://bfl.cdn/img.jpg" } });
      }
      if (url.endsWith("/v1/flux-pro-1.1")) {
        expect((init?.headers as Record<string, string>)["x-key"]).toBe("bfl-key");
        return Response.json({ id: "task-1" });
      }
      // sample download
      return new Response(new Uint8Array([5, 5, 5]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    const res = await generateFluxImage({
      apiKey: "bfl-key",
      model: "flux/flux-pro-1.1",
      prompt: "a dragon",
    });
    expect(seen[0]).toBe("https://api.bfl.ml/v1/flux-pro-1.1");
    expect(cap.calls()).toBe(3); // submit + poll + download
    expect(res.status).toBe("succeeded");
    expect(res.asset?.mimeType).toBe("image/jpeg");
    expect(res.asset?.data.byteLength).toBe(3);
  });

  it("defaults a bare 'flux' to flux-pro-1.1 and uses BFL_API_KEY from env", async () => {
    process.env.BFL_API_KEY = "env-key";
    let submitUrl = "";
    mockFetch((url) => {
      if (url.includes("/v1/get_result"))
        return Response.json({ status: "Ready", result: { sample: "https://x/y.jpg" } });
      if (!url.includes("get_result") && url.includes("/v1/")) {
        submitUrl = url;
        return Response.json({ id: "t" });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    await generateFluxImage({ apiKey: "", model: "flux", prompt: "p" });
    expect(submitUrl).toBe("https://api.bfl.ml/v1/flux-pro-1.1");
  });

  it("fails clearly without a key, and surfaces moderation", async () => {
    delete process.env.BFL_API_KEY;
    const noKey = await generateFluxImage({ apiKey: "", model: "flux/flux-dev", prompt: "p" });
    expect(noKey.status).toBe("failed");
    expect(noKey.error).toContain("BFL_API_KEY");

    mockFetch((url) =>
      url.includes("get_result")
        ? Response.json({ status: "Content Moderated" })
        : Response.json({ id: "t" }),
    );
    const moderated = await generateFluxImage({ apiKey: "k", model: "flux/flux-dev", prompt: "p" });
    expect(moderated.status).toBe("failed");
    expect(moderated.error).toContain("Content Moderated");
  });
});
