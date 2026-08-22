// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvas } from "../canvas/hooks/use-canvas";
import { authFetch } from "../lib/api";

vi.mock("../lib/api", () => ({ authFetch: vi.fn() }));

describe("useCanvas snapshot lifecycle", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("releases the live-event buffer when the snapshot request fails", async () => {
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network unavailable"));
    const onSnapshotReady = vi.fn();

    const { result } = renderHook(() => useCanvas("feed-id", { onSnapshotReady }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("network unavailable");
    expect(onSnapshotReady).toHaveBeenCalledTimes(1);
  });
});
