// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaViewerProvider } from "../components/media/MediaViewer";
import { useChatState } from "../hooks/use-chat-state";
import { Viewer } from "../unified/overlays/Viewer";
import { renderWithProviders } from "./test-utils";

const claimIntent = vi.fn(async (..._args: unknown[]) => {});
const completeIntent = vi.fn(async (..._args: unknown[]) => {});
const failIntent = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../unified/hooks/use-canvas-integration", () => ({
  claimIntent: (...args: unknown[]) => claimIntent(...args),
  completeIntent: (...args: unknown[]) => completeIntent(...args),
  failIntent: (...args: unknown[]) => failIntent(...args),
}));

beforeEach(() => {
  claimIntent.mockClear();
  completeIntent.mockClear();
  failIntent.mockClear();
  useChatState.setState({ entityName: "Ada" });
});

function intent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "pending",
    prompt: "Draw the harbour",
    canvasId: "c1",
    nodeId: "n1",
    ...overrides,
  });
}

describe("Viewer", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <Viewer open={false} title="Hidden" contentType="image" onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the title and type badge, and closes on the button and on Escape", () => {
    const onClose = vi.fn();
    render(
      <Viewer open title="Sunset" contentType="document" content="<p>x</p>" onClose={onClose} />,
    );
    expect(screen.getByText("Sunset")).toBeInTheDocument();
    expect(screen.getByText("document")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Sunset" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["video", "VIDEO viewer"],
    ["pdf", "PDF viewer"],
    ["image", "IMAGE viewer"],
    ["a2ui", "A2UI viewer"],
    ["unknown", "UNKNOWN viewer"],
  ] as const)("shows a placeholder for %s without content", (type, text) => {
    render(<Viewer open title="Empty" contentType={type} onClose={() => {}} />);
    expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
  });

  it.each([
    ["image", "/a.png"],
    ["video", "/v.mp4"],
    ["audio", "/a.mp3"],
    ["pdf", "/p.pdf"],
  ] as const)("hands %s content to the shared media viewer and closes", (type, url) => {
    const onClose = vi.fn();
    renderWithProviders(
      <MediaViewerProvider>
        <Viewer open title="Media" contentType={type} content={url} onClose={onClose} />
      </MediaViewerProvider>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    // (onClose is a mock here, so the overlay itself stays mounted too.)
    const dialog = screen
      .getAllByRole("dialog")
      .find((d) => d.getAttribute("aria-labelledby") === "media-viewer-title");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("sanitizes document HTML before editing", () => {
    render(
      <Viewer
        open
        title="Doc"
        contentType="document"
        content={'<p>Hello</p><script>alert(1)</script><img src=x onerror="alert(1)">'}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
    expect(screen.getByTitle("Bold")).toBeInTheDocument();
  });

  it("reports missing intent data", () => {
    render(<Viewer open title="I" contentType="intent" content="not json" onClose={() => {}} />);
    expect(screen.getByText("No intent data available.")).toBeInTheDocument();
  });

  it("claims a pending intent as the current entity", async () => {
    render(<Viewer open title="I" contentType="intent" content={intent()} onClose={() => {}} />);
    expect(screen.getByText("Draw the harbour")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claim Intent" }));
    await waitFor(() => expect(screen.getByText("Claimed successfully")).toBeInTheDocument());
    expect(claimIntent).toHaveBeenCalledWith("c1", "n1", "Ada");
  });

  it("reports a failed claim", async () => {
    claimIntent.mockRejectedValueOnce(new Error("nope"));
    render(<Viewer open title="I" contentType="intent" content={intent()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim Intent" }));
    await waitFor(() => expect(screen.getByText("Failed to claim")).toBeInTheDocument());
  });

  it("lets the owner complete an active intent with a result", async () => {
    render(
      <Viewer
        open
        title="I"
        contentType="intent"
        content={intent({ status: "active", claimedBy: "Ada", claimedAt: 1 })}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete Intent" }));
    const input = screen.getByPlaceholderText("Result text...");
    // An empty result is a no-op.
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(completeIntent).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  done it  " } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByText("Completed successfully")).toBeInTheDocument());
    expect(completeIntent).toHaveBeenCalledWith("c1", "n1", "done it");
  });

  it("lets the owner fail an active intent, and Cancel restores the choices", async () => {
    render(
      <Viewer
        open
        title="I"
        contentType="intent"
        content={intent({ status: "active", claimedBy: "Ada" })}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fail Intent" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Fail Intent" }));
    fireEvent.change(screen.getByPlaceholderText("Failure reason..."), {
      target: { value: "blocked" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByText("Marked as failed")).toBeInTheDocument());
    expect(failIntent).toHaveBeenCalledWith("c1", "n1", "blocked");
  });

  it("offers no actions on an intent that is finished or owned by someone else", () => {
    render(
      <Viewer
        open
        title="I"
        contentType="intent"
        content={intent({ status: "done", result: "shipped", claimedBy: "Bob" })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("shipped")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Intent/ })).toBeNull();
  });
});
