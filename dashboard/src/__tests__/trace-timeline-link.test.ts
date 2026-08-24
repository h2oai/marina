// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeedState } from "../hooks/use-feed-state";
import type { FeedEvent } from "../lib/types";
import { TimelineStrip, traceIdFromFeedEvent } from "../unified/overlays/TimelineStrip";

function event(ref: string | null): FeedEvent {
  return {
    id: 1,
    kind: "model_request_completed",
    entity: null,
    ref,
    summary: "done",
    payload: null,
    timestamp: 1,
  };
}

describe("trace timeline links", () => {
  beforeEach(() => useFeedState.getState().reset());

  it("extracts only non-empty request trace references", () => {
    expect(traceIdFromFeedEvent(event("request:req-123"))).toBe("req-123");
    expect(traceIdFromFeedEvent(event("request:  "))).toBeUndefined();
    expect(traceIdFromFeedEvent(event("note:123"))).toBeUndefined();
    expect(traceIdFromFeedEvent(event(null))).toBeUndefined();
  });

  it("opens the exact trace when a request event is activated", () => {
    useFeedState.getState().setSnapshot([{ ...event("request:req-123"), timestamp: Date.now() }]);
    const opened = vi.fn();
    window.addEventListener("marina:open-traces", opened);
    render(createElement(TimelineStrip, { inline: true }));
    fireEvent.click(screen.getByRole("button", { name: "model_request_completed: done" }));
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ traceId: "req-123" });
    window.removeEventListener("marina:open-traces", opened);
  });
});
