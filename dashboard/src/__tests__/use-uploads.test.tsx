// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDropZone, UploadTray } from "../components/media/UploadControls";
import { resetUiConfigForTests, useUploads } from "../hooks/use-uploads";
import { filesFromClipboard, uploadErrorMessage } from "../lib/upload";
import { computePeaks } from "../lib/waveform";

/** A scriptable XMLHttpRequest: tests drive progress and completion. */
class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const file = (name: string, size = 10, type = "image/png") =>
  new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  resetUiConfigForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ maxUploadBytes: 1000 }), { status: 200 })),
  );
  localStorage.setItem("marina_chat_token", "tok");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useUploads", () => {
  it("reports progress, then the uploaded asset, and calls onUploaded", async () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads({ onUploaded, maxBytes: 1000 }));
    act(() => {
      result.current.upload([file("a.png")]);
    });
    const xhr = FakeXhr.all[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toMatch(/\/api\/assets$/);
    expect(xhr.headers.Authorization).toBe("Bearer tok");
    expect(xhr.body).toBeInstanceOf(FormData);
    act(() => xhr.progress(5, 10));
    expect(result.current.entries[0]).toMatchObject({ status: "uploading", progress: 0.5 });
    act(() => xhr.respond(201, { id: "as1", url: "/assets/as1.png", filename: "a.png" }));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("done"));
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "as1" }),
      expect.any(File),
    );
  });

  it("surfaces a deduplicated upload as already in the library", async () => {
    const { result } = renderHook(() => useUploads({ maxBytes: 1000 }));
    act(() => {
      result.current.upload([file("a.png")]);
    });
    act(() =>
      FakeXhr.all[0]!.respond(200, { id: "as1", url: "/assets/as1.png", deduplicated: true }),
    );
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("duplicate"));
  });

  it("refuses files over the server cap before sending, and reports a 413 readably", async () => {
    const { result } = renderHook(() => useUploads());
    // The cap comes from /api/ui-config.
    await waitFor(() => expect(result.current.maxBytes).toBe(1000));
    act(() => {
      result.current.upload([file("big.png", 2000), file("ok.png", 10)]);
    });
    expect(result.current.entries[0]).toMatchObject({ status: "error" });
    expect(result.current.entries[0]?.error).toMatch(/too large/i);
    expect(FakeXhr.all).toHaveLength(1);
    act(() => FakeXhr.all[0]!.respond(413, { error: "File too large. Maximum 0MB." }));
    await waitFor(() => expect(result.current.entries[1]?.status).toBe("error"));
    expect(result.current.entries[1]?.error).toMatch(/too large/i);
  });

  it("shows the server's error text and cancels an upload in flight", async () => {
    const { result } = renderHook(() => useUploads({ maxBytes: 1000 }));
    act(() => {
      result.current.upload([file("a.png"), file("b.png")]);
    });
    act(() => FakeXhr.all[0]!.respond(400, { error: "Empty file." }));
    await waitFor(() =>
      expect(result.current.entries[0]).toMatchObject({ status: "error", error: "Empty file." }),
    );
    const id = result.current.entries[1]!.id;
    act(() => result.current.cancel(id));
    await waitFor(() => expect(result.current.entries[1]?.status).toBe("cancelled"));
    expect(FakeXhr.all[1]?.aborted).toBe(true);
  });

  it("limits parallel uploads and drains the queue", async () => {
    const { result } = renderHook(() => useUploads({ maxBytes: 1000, concurrency: 1 }));
    act(() => {
      result.current.upload([file("a.png"), file("b.png")]);
    });
    expect(FakeXhr.all).toHaveLength(1);
    expect(result.current.entries[1]?.status).toBe("queued");
    act(() => FakeXhr.all[0]!.respond(201, { id: "1", url: "/assets/1.png" }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
  });
});

describe("upload helpers and controls", () => {
  it("maps statuses to readable errors", () => {
    expect(uploadErrorMessage(413, null, 5 * 1024 * 1024)).toBe("File too large (max 5.0 MB).");
    expect(uploadErrorMessage(401, null)).toMatch(/Sign in/);
    expect(uploadErrorMessage(0, null)).toBe("Network error.");
  });

  it("takes files from a clipboard paste and names pasted screenshots", () => {
    const shot = file("image.png");
    const data = {
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => shot },
      ],
      files: [],
    } as unknown as DataTransfer;
    const files = filesFromClipboard(data);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^pasted-.*\.png$/);
    expect(filesFromClipboard(null)).toEqual([]);
  });

  it("uploads on paste and drop inside the zone; text pastes pass through", () => {
    const onFiles = vi.fn();
    render(
      <UploadDropZone onFiles={onFiles}>
        <textarea aria-label="draft" />
      </UploadDropZone>,
    );
    const area = screen.getByLabelText("draft");
    const pasted = file("x.png");
    fireEvent.paste(area, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => pasted }], files: [] },
    });
    expect(onFiles).toHaveBeenCalledWith([pasted]);
    fireEvent.paste(area, {
      clipboardData: { items: [{ kind: "string", getAsFile: () => null }], files: [] },
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    const dropped = file("d.pdf", 10, "application/pdf");
    fireEvent.drop(area, { dataTransfer: { types: ["Files"], files: [dropped] } });
    expect(onFiles).toHaveBeenLastCalledWith([dropped]);
  });

  it("renders progress, dedupe and error rows with named controls", () => {
    const onCancel = vi.fn();
    const onDismiss = vi.fn();
    render(
      <UploadTray
        entries={[
          { id: "1", name: "a.png", size: 10, mime: "", progress: 0.4, status: "uploading" },
          { id: "2", name: "b.png", size: 10, mime: "", progress: 1, status: "duplicate" },
          {
            id: "3",
            name: "c.png",
            size: 10,
            mime: "",
            progress: 0,
            status: "error",
            error: "Nope.",
          },
        ]}
        onCancel={onCancel}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Uploading a.png" })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(screen.getByText("Already in your library")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Nope.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of a.png" }));
    expect(onCancel).toHaveBeenCalledWith("1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss c.png" }));
    expect(onDismiss).toHaveBeenCalledWith("3");
  });
});

describe("waveform peaks", () => {
  it("reduces channels to normalized per-bucket peaks", () => {
    const left = new Float32Array([0, 0.5, -0.25, 0.1, 0, -1, 0.2, 0.2]);
    const right = new Float32Array([0.9, 0, 0, 0, 0, 0, 0, 0]);
    expect(computePeaks([left, right], 4).map((p) => Math.round(p * 100) / 100)).toEqual([
      0.9, 0.25, 1, 0.2,
    ]);
    expect(computePeaks([], 4)).toEqual([]);
  });
});
