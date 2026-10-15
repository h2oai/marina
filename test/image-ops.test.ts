// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import sharp from "sharp";
import {
  imageProcessingAvailable,
  JEV_IMAGE_LIMITS,
  prepareImage,
  probeImage,
  setImageBackendForTests,
  thumbnail,
  toDataUrl,
} from "../src/engine/media/image-ops";

const make = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#336699" } });
const bytes = async (p: Promise<Buffer>) => new Uint8Array(await p);

// Run sharp's native buffer finalizers while this file's realm is alive
// (`bun test --isolate` tears the realm down before the next file).
afterAll(() => Bun.gc(true));

describe("probeImage", () => {
  it("reads dimensions of PNG, JPEG, WebP (lossy + lossless) and GIF headers", async () => {
    expect(probeImage(await bytes(make(321, 123).png().toBuffer()))).toMatchObject({
      mime: "image/png",
      width: 321,
      height: 123,
      animated: false,
    });
    expect(probeImage(await bytes(make(640, 480).jpeg().toBuffer()))).toEqual({
      mime: "image/jpeg",
      width: 640,
      height: 480,
    });
    expect(probeImage(await bytes(make(300, 200).webp().toBuffer()))).toMatchObject({
      mime: "image/webp",
      width: 300,
      height: 200,
    });
    expect(
      probeImage(await bytes(make(301, 199).webp({ lossless: true }).toBuffer())),
    ).toMatchObject({ mime: "image/webp", width: 301, height: 199 });
    expect(probeImage(await bytes(make(64, 32).gif().toBuffer()))).toMatchObject({
      mime: "image/gif",
      width: 64,
      height: 32,
    });
  });

  it("reads EXIF orientation from a JPEG", async () => {
    const rotated = await bytes(make(400, 300).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    expect(probeImage(rotated)).toMatchObject({ width: 400, height: 300, orientation: 6 });
  });

  it("rejects non-images and truncated headers", () => {
    expect(probeImage(new TextEncoder().encode("<html>not an image</html>"))).toBeUndefined();
    expect(probeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

describe("prepareImage", () => {
  afterEach(() => setImageBackendForTests());

  it("returns an image already inside the limits unchanged", async () => {
    const png = await bytes(make(800, 600).png().toBuffer());
    const out = await prepareImage(png, JEV_IMAGE_LIMITS);
    expect(out).toMatchObject({ ok: true, changed: false, mime: "image/png", width: 800 });
    expect(out.ok && out.bytes).toBe(png);
  });

  it("scales a large image down into Jev's range keeping the aspect ratio", async () => {
    const out = await prepareImage(
      await bytes(make(4000, 2000).png().toBuffer()),
      JEV_IMAGE_LIMITS,
    );
    expect(out).toMatchObject({ ok: true, changed: true, width: 1568, height: 784 });
    if (out.ok) expect(probeImage(out.bytes)).toMatchObject({ width: 1568, height: 784 });
  });

  it("scales a small image up to the minimum side", async () => {
    const out = await prepareImage(await bytes(make(128, 200).jpeg().toBuffer()), JEV_IMAGE_LIMITS);
    expect(out).toMatchObject({ ok: true, changed: true, width: 256, height: 400 });
  });

  it("rotates EXIF-oriented photos upright (Jev does not apply EXIF)", async () => {
    const photo = await bytes(make(800, 600).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    const out = await prepareImage(photo, JEV_IMAGE_LIMITS);
    expect(out).toMatchObject({ ok: true, changed: true, width: 600, height: 800 });
    if (out.ok) expect(probeImage(out.bytes)?.orientation).toBeUndefined();
  });

  it("converts an unaccepted format and refuses what cannot fit without cropping", async () => {
    const gif = await prepareImage(await bytes(make(400, 400).gif().toBuffer()), JEV_IMAGE_LIMITS);
    expect(gif).toMatchObject({ ok: true, changed: true, mime: "image/png" });
    const strip = await prepareImage(
      await bytes(make(2000, 100).png().toBuffer()),
      JEV_IMAGE_LIMITS,
    );
    expect(strip).toMatchObject({ ok: false });
    expect(!strip.ok && strip.reason).toContain("without cropping");
  });

  it("without the pixel backend: passes compliant images, refuses the rest with a reason", async () => {
    setImageBackendForTests(async () => undefined);
    expect(await imageProcessingAvailable()).toBe(false);
    const fine = await bytes(make(800, 600).png().toBuffer());
    expect(await prepareImage(fine, JEV_IMAGE_LIMITS)).toMatchObject({ ok: true, changed: false });
    const big = await prepareImage(
      await bytes(make(4000, 2000).png().toBuffer()),
      JEV_IMAGE_LIMITS,
    );
    expect(big).toMatchObject({ ok: false });
    expect(!big.ok && big.reason).toContain("`sharp`");
  });

  it("refuses non-images", async () => {
    expect(await prepareImage(new TextEncoder().encode("hello"))).toMatchObject({ ok: false });
  });
});

describe("thumbnail", () => {
  afterEach(() => setImageBackendForTests());

  it("fits inside the box, never upscales, and is WebP", async () => {
    const t = await thumbnail(await bytes(make(2000, 1000).png().toBuffer()), 256);
    expect(t).toMatchObject({ mime: "image/webp", width: 256, height: 128 });
    const small = await thumbnail(await bytes(make(100, 50).png().toBuffer()), 256);
    expect(small).toMatchObject({ width: 100, height: 50 });
  });

  it("is undefined without the pixel backend", async () => {
    setImageBackendForTests(async () => undefined);
    expect(await thumbnail(await bytes(make(100, 50).png().toBuffer()), 256)).toBeUndefined();
  });

  it("toDataUrl encodes base64 with the mime", () => {
    expect(toDataUrl(new Uint8Array([1, 2, 3]), "image/png")).toBe("data:image/png;base64,AQID");
  });
});
