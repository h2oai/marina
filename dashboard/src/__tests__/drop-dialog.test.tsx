import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DroppedFileResult } from "../unified/hooks/use-canvas-integration";
import { DropDialog } from "../unified/overlays/DropDialog";

/**
 * DropDialog flow contract:
 *   1. Pre-fills the intent textarea with a MIME-aware suggestion.
 *   2. Quick-action chips overwrite the textarea.
 *   3. "Set Intent" PATCHes the node's data.intent and advances the queue.
 *   4. "Skip" advances without writing.
 *   5. Multi-file drops advance through the queue then call onClose.
 */

const mkFile = (over: Partial<DroppedFileResult> = {}): DroppedFileResult => ({
  filename: "report.pdf",
  mime: "application/pdf",
  size: 12_345,
  nodeId: "node-1",
  canvasId: "canvas-1",
  ...over,
});

describe("DropDialog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // GET node → return shell with empty data so the dialog can merge intent.
      if (!init || init.method === undefined) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // PATCH → record the call and 200.
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-fills the intent textarea with a MIME-aware suggestion", () => {
    render(<DropDialog files={[mkFile({ mime: "application/pdf" })]} onClose={() => {}} />);
    const textarea = screen.getByLabelText(/INTENT FOR AGENTS/i) as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/summarize/i);
  });

  it("falls back to a generic prompt when the MIME is unknown", () => {
    render(
      <DropDialog
        files={[mkFile({ mime: "application/octet-stream", filename: "blob.bin" })]}
        onClose={() => {}}
      />,
    );
    const textarea = screen.getByLabelText(/INTENT FOR AGENTS/i) as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/inspect/i);
  });

  it("clicking a quick-action chip overwrites the textarea", () => {
    render(<DropDialog files={[mkFile()]} onClose={() => {}} />);
    const textarea = screen.getByLabelText(/INTENT FOR AGENTS/i) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /^Critique$/ }));
    expect(textarea.value).toMatch(/feedback|improvements/i);
  });

  it("Set Intent PATCHes the node's data.intent and closes when queue is empty", async () => {
    const onClose = vi.fn();
    render(<DropDialog files={[mkFile()]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /SET INTENT/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const patchCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
    const [url, init] = patchCalls[0]! as [string, RequestInit];
    expect(url).toContain("/api/canvases/canvas-1/nodes/node-1");
    const body = JSON.parse(init.body as string);
    expect(body.data.intent.status).toBe("pending");
    expect(body.data.intent.prompt).toMatch(/summarize/i);
  });

  it("Skip advances without PATCHing", async () => {
    const onClose = vi.fn();
    render(<DropDialog files={[mkFile()]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const patchCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("walks through a multi-file queue and calls onClose at the end", async () => {
    const onClose = vi.fn();
    render(
      <DropDialog
        files={[
          mkFile({ nodeId: "n1", filename: "a.pdf" }),
          mkFile({ nodeId: "n2", filename: "b.csv", mime: "text/csv" }),
        ]}
        onClose={onClose}
      />,
    );
    // First file
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /SET INTENT/i }));
    // Second file shows after first PATCH resolves
    await screen.findByText("b.csv");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
