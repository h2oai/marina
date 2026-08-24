// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionDrawer } from "../components/AttentionDrawer";

const refetch = vi.fn(async () => undefined);
const postApi = vi.fn(async () => ({ ok: true }));
const useOperationalAlerts = vi.fn();

vi.mock("../hooks/use-api", () => ({ useOperationalAlerts: () => useOperationalAlerts() }));
vi.mock("../lib/api", () => ({
  describeApiError: (cause: unknown) => String(cause),
  postApi: (...args: unknown[]) => postApi(...args),
}));

const base = {
  id: 1,
  alert_key: "review:1",
  severity: "warning" as const,
  category: "review",
  title: "Candidate ready",
  detail: "Review candidate B.",
  remedy: "Inspect evidence.",
  status: "open" as const,
  occurrences: 1,
  first_seen_at: 1,
  last_seen_at: 1,
  acknowledged_at: null,
  resolved_at: null,
  attention_kind: "decision",
  source_entity: "Verifier",
  target_entity: "Operator",
  assigned_to: "Operator",
  action_label: "Open trace",
  action_ref: "/dashboard?trace=trace-1",
  metadata: null,
  seen_at: null,
  snoozed_until: null,
  deadline_at: null,
};

describe("AttentionDrawer", () => {
  beforeEach(() => {
    refetch.mockClear();
    postApi.mockClear();
    useOperationalAlerts.mockReturnValue({
      data: [base, { ...base, id: 2, title: "Snoozed", snoozed_until: Date.now() + 60_000 }],
      isLoading: false,
      isError: false,
      refetch,
    });
  });

  it("shows actionable, attributed attention and hides active snoozes", async () => {
    render(<AttentionDrawer open onClose={() => undefined} />);
    expect(screen.getByRole("complementary", { name: "Attention inbox" })).toBeVisible();
    expect(screen.getByText("Candidate ready")).toBeVisible();
    expect(screen.getByText("From Verifier")).toBeVisible();
    expect(screen.queryByText("Snoozed")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open trace/ })).toHaveAttribute(
      "href",
      "/dashboard?trace=trace-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() =>
      expect(postApi).toHaveBeenCalledWith("/api/operations/alerts/1/ack", undefined),
    );
    expect(refetch).toHaveBeenCalled();
  });
});
