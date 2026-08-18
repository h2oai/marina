// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { inferKind } from "../components/AssetLightbox";

describe("inferKind", () => {
  it("trusts an explicit kind (pdf normalized)", () => {
    expect(inferKind({ url: "x", kind: "image" })).toBe("image");
    expect(inferKind({ url: "x", kind: "video" })).toBe("video");
    expect(inferKind({ url: "x", kind: "pdf" })).toBe("pdf");
  });

  it("infers from mime when kind is missing or generic 'document'", () => {
    expect(inferKind({ url: "x", mime: "image/png" })).toBe("image");
    expect(inferKind({ url: "x", mime: "video/mp4" })).toBe("video");
    expect(inferKind({ url: "x", mime: "audio/mpeg" })).toBe("audio");
    expect(inferKind({ url: "x", mime: "application/pdf" })).toBe("pdf");
    // generic "document" defers to mime/url sniffing
    expect(inferKind({ url: "x", kind: "document", mime: "image/png" })).toBe("image");
  });

  it("falls back to the URL extension", () => {
    expect(inferKind({ url: "https://h/assets/abc.png" })).toBe("image");
    expect(inferKind({ url: "https://h/assets/abc.mp4?t=1" })).toBe("video");
    expect(inferKind({ url: "https://h/assets/abc.mp3" })).toBe("audio");
    expect(inferKind({ url: "https://h/assets/abc.pdf" })).toBe("pdf");
  });

  it("defaults to document for unknown types", () => {
    expect(inferKind({ url: "https://h/assets/abc.bin" })).toBe("document");
  });
});
