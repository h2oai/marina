import { afterEach, describe, expect, it } from "bun:test";
import { generateGoogleImage } from "../src/engine/media/providers/google-image";
import {
  getImageProvider,
  knownImageProviders,
} from "../src/engine/media/providers/image-registry";
import { bareModel, nearestAspectRatio } from "../src/engine/media/providers/image-util";
import { generateStabilityImage } from "../src/engine/media/providers/stability";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock; returns a capture of the last call. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  url: () => string;
  init: () => RequestInit | undefined;
} {
  let lastUrl = "";
  let lastInit: RequestInit | undefined;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    lastUrl = String(url);
    lastInit = init;
    return Promise.resolve(handler(lastUrl, init));
  }) as unknown as typeof fetch;
  return { url: () => lastUrl, init: () => lastInit };
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
  it("resolves the implemented providers and nothing else", () => {
    expect(knownImageProviders().sort()).toEqual(["google", "openai", "stability"]);
    expect(typeof getImageProvider("openai")).toBe("function");
    expect(typeof getImageProvider("stability")).toBe("function");
    expect(typeof getImageProvider("google")).toBe("function");
    expect(getImageProvider("midjourney")).toBeUndefined();
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
