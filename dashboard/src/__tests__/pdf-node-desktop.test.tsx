// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * On the desktop shell pdf.js cannot fetch `/assets/<key>` (there is no HTTP
 * origin): the PDF node waits for the adapter's blob URL and loads that.
 */

const getDocument = vi.fn((_opts: { url: string }) => ({
  promise: Promise.resolve({ numPages: 1, getPage: () => new Promise(() => {}) }),
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));

let blobUrl: string | undefined;
vi.mock("../lib/asset-url", () => ({
  assetAuthHeaders: () => ({}),
  desktopAssetPath: (url: string) => (url.startsWith("/assets/") ? url : undefined),
  useAssetUrl: () => blobUrl,
}));

const { default: PdfNode } = await import("../canvas/nodes/PdfNode");

const props = {
  id: "n1",
  data: { url: "/assets/doc.pdf", filename: "doc.pdf" },
  selected: false,
} as unknown as ComponentProps<typeof PdfNode>;

const node = () => (
  <ReactFlowProvider>
    <PdfNode {...props} />
  </ReactFlowProvider>
);

describe("PdfNode on the desktop shell", () => {
  it("loads the adapter's blob URL once it is read, never the bare asset path", async () => {
    blobUrl = undefined;
    const view = render(node());
    await new Promise((r) => setTimeout(r, 20));
    expect(getDocument).not.toHaveBeenCalled();
    blobUrl = "blob:views://dashboard/7";
    view.rerender(node());
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(getDocument.mock.calls[0]![0].url).toBe("blob:views://dashboard/7");
  });
});
