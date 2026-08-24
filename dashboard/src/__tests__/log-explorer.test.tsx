// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogExplorer } from "../components/LogExplorer";

const useLogs = vi.fn();
const downloadApi = vi.fn();

vi.mock("../hooks/use-api", () => ({
  useLogs: (...args: unknown[]) => useLogs(...args),
  logQueryString: () => "limit=100",
}));
vi.mock("../lib/api", () => ({
  describeApiError: (error: unknown) => String(error),
  downloadApi: (...args: unknown[]) => downloadApi(...args),
}));

const response = {
  logs: [
    {
      id: 1,
      timestamp: 100,
      level: "error",
      category: "model-request",
      message: "Model request failed",
      traceId: "trace-visible",
      spanId: "span-visible",
      requestId: "request-visible",
      data: { errorKind: "timeout" },
    },
  ],
  page: { limit: 100, hasMore: false },
  source: "structured_logs",
  retention: 10_000,
  otlp: {
    enabled: true,
    pendingLogs: 2,
    exportedLogs: 12,
    rejectedLogs: 0,
    droppedLogs: 0,
    exportFailures: 0,
    consecutiveFailures: 0,
  },
};

describe("LogExplorer", () => {
  beforeEach(() => {
    useLogs.mockReturnValue({ data: response, isLoading: false, error: null, refetch: vi.fn() });
    downloadApi.mockReset();
  });

  it("renders searchable logs, delivery health, details, and trace navigation", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    render(<LogExplorer />);
    expect(screen.getByLabelText("Search logs")).toBeInTheDocument();
    expect(screen.getByText("Model request failed")).toBeInTheDocument();
    expect(screen.getByText(/12 exported, 2 queued/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Model request failed"));
    fireEvent.click(screen.getByText("trace trace-visible"));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "marina:open-traces" }));
  });

  it("exposes authenticated OTLP download and explicit empty/error states", () => {
    const view = render(<LogExplorer />);
    fireEvent.click(screen.getByRole("button", { name: "Download OTLP" }));
    expect(downloadApi).toHaveBeenCalledWith(
      expect.stringContaining("format=otlp-json"),
      expect.any(String),
    );

    useLogs.mockReturnValue({
      data: { ...response, logs: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    view.rerender(<LogExplorer />);
    expect(screen.getByText("No retained logs match these filters.")).toBeInTheDocument();

    useLogs.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("offline"),
      refetch: vi.fn(),
    });
    view.rerender(<LogExplorer />);
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
  });

  it("surfaces OTLP download failures", async () => {
    downloadApi.mockRejectedValueOnce(new Error("collector export unavailable"));
    render(<LogExplorer />);
    fireEvent.click(screen.getByRole("button", { name: "Download OTLP" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("collector export unavailable"),
    );
  });
});
