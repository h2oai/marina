// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkDrawer } from "../components/WorkDrawer";

const refetch = vi.fn(async () => undefined);

vi.mock("../hooks/use-api", () => ({
  useTasks: () => ({
    data: [
      { id: 7, title: "Verify release", status: "open" },
      { id: 8, title: "Already done", status: "completed" },
    ],
    isLoading: false,
    isError: false,
    refetch,
  }),
  useProjects: () => ({
    data: [{ id: "project-1", name: "Launch", status: "active" }],
    isLoading: false,
    isError: false,
    refetch,
  }),
}));

vi.mock("../hooks/use-coding", () => ({
  useCodingSessionsSnapshot: () => ({
    data: { items: [{ id: "code-1", title: "Fix onboarding", status: "active" }] },
    isLoading: false,
    isError: false,
    refetch,
  }),
}));

describe("WorkDrawer", () => {
  it("projects active work into clickable canonical destinations", () => {
    const close = vi.fn();
    const opened: string[] = [];
    window.addEventListener("marina:open-coding", ((event: CustomEvent<{ sessionId: string }>) => {
      opened.push(event.detail.sessionId);
    }) as EventListener);

    render(<WorkDrawer open onClose={close} />);

    expect(screen.getByRole("complementary", { name: "Work overview" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Verify release/ })).toHaveAttribute(
      "href",
      "/dashboard?inspect=task:7",
    );
    expect(screen.queryByText("Already done")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Launch/ })).toHaveAttribute(
      "href",
      "/dashboard?inspect=project:project-1",
    );
    fireEvent.click(screen.getByRole("button", { name: /Fix onboarding/ }));
    expect(opened).toEqual(["code-1"]);
    expect(close).toHaveBeenCalled();
  });
});
