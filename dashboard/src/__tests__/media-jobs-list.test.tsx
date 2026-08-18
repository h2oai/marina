// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildMediaRetryCommand, MediaJobsList } from "../components/MediaJobsList";
import type { MediaJob } from "../lib/types";

const baseJob = (overrides: Partial<MediaJob> = {}): MediaJob => ({
  id: overrides.id ?? "job-1",
  type: overrides.type ?? "image",
  status: overrides.status ?? "pending",
  provider: overrides.provider ?? "openai",
  model: overrides.model ?? "openai/gpt-image-1",
  prompt: overrides.prompt ?? "A test prompt",
  entityName: overrides.entityName ?? "alice",
  costEstimate: overrides.costEstimate ?? null,
  error: overrides.error ?? null,
  assetId: overrides.assetId ?? null,
  assetUrl: overrides.assetUrl ?? null,
  options: overrides.options ?? {},
  metadata: overrides.metadata ?? {},
  createdAt: overrides.createdAt ?? Date.now() - 60_000,
  updatedAt: overrides.updatedAt ?? Date.now(),
  completedAt: overrides.completedAt ?? null,
});

describe("MediaJobsList", () => {
  it("renders empty message when no jobs", () => {
    render(<MediaJobsList jobs={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("renders job details and actions", () => {
    const job = baseJob({
      status: "failed",
      costEstimate: 0.42,
      error: "network error",
      assetUrl: "https://example.com/asset.png",
    });
    const onRetry = vi.fn();
    const { getByText } = render(<MediaJobsList jobs={[job]} onRetry={onRetry} emptyMessage="-" />);
    expect(getByText(/FAILED/i)).toBeInTheDocument();
    expect(getByText(/openai\/gpt-image-1/i)).toBeInTheDocument();
    expect(getByText("~$0.420")).toBeInTheDocument();
    fireEvent.click(getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith(job);
    expect(getByText("Open")).toBeInTheDocument();
  });

  it("invokes delete asset callback", () => {
    const job = baseJob({ status: "succeeded", assetId: "asset-123", assetUrl: "http://asset" });
    const onDelete = vi.fn();
    render(<MediaJobsList jobs={[job]} onDeleteAsset={onDelete} emptyMessage="-" />);
    fireEvent.click(screen.getByText("Delete Asset"));
    expect(onDelete).toHaveBeenCalledWith(job);
  });
});

describe("buildMediaRetryCommand", () => {
  it("builds command for image job with options", () => {
    const command = buildMediaRetryCommand(
      baseJob({
        type: "image",
        model: "openai/gpt-image-1",
        options: { width: 512, height: 512, style: "synthwave", canvasId: "workspace" },
      }),
    );
    expect(command).toBe(
      "image generate A test prompt --model openai/gpt-image-1 --width 512 --height 512 --style synthwave --canvas workspace",
    );
  });

  it("builds command for video job with options", () => {
    const command = buildMediaRetryCommand(
      baseJob({
        type: "video",
        model: "runway/gen3-alpha",
        options: {
          duration: 12,
          fps: 24,
          referenceImage: "asset-1",
          aspectRatio: "16:9",
          canvasId: "workspace",
        },
      }),
    );
    expect(command).toBe(
      "video generate A test prompt --model runway/gen3-alpha --duration 12 --fps 24 --reference asset-1 --aspect 16:9 --canvas workspace",
    );
  });
});
