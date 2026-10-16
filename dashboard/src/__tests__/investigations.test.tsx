// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  investigationFixtures,
  investigationSnapshot,
} from "../../../test/fixtures/investigations";
import { InvestigationAnswer } from "../components/investigations/InvestigationAnswer";
import { InvestigationCard } from "../components/investigations/InvestigationCard";
import { InvestigationComposer } from "../components/investigations/InvestigationComposer";
import { evidenceGraph } from "../components/investigations/InvestigationEvidence";
import { useChatState } from "../hooks/use-chat-state";
import { investigations } from "../hooks/use-investigations";

afterEach(() => {
  vi.restoreAllMocks();
  useChatState.setState({ loggedIn: false, entityName: null });
});

it("shows missing uncertainty and a plurality without converting either to confidence", () => {
  const snapshot = investigationSnapshot(investigationFixtures.numeric);
  const view = render(<InvestigationAnswer attempt={snapshot.attempt} />);
  expect(screen.getByText(/uncertainty not supplied/)).toBeInTheDocument();
  view.rerender(
    <InvestigationAnswer attempt={investigationSnapshot(investigationFixtures.choice).attempt} />,
  );
  expect(screen.getByLabelText("Outcome probabilities")).toHaveTextContent("40%");
  expect(screen.queryByText(/confidence/i)).toBeNull();
});

it("reuses the request key after an uncertain submission and allocates one after an edit", async () => {
  const start = vi
    .spyOn(investigations, "start")
    .mockRejectedValue(new Error("Connection interrupted"));
  render(<InvestigationComposer kind="prediction" onStarted={() => {}} />);
  fireEvent.change(screen.getByLabelText("What shall we predict?"), {
    target: { value: "Will we ship?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Predict", exact: true }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Predict", exact: true }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[0]![1]).toBe(start.mock.calls[1]![1]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Predict", exact: true })).not.toBeDisabled(),
  );
  fireEvent.change(screen.getByLabelText("What shall we predict?"), {
    target: { value: "Will we ship next month?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Predict", exact: true }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(3));
  expect(start.mock.calls[2]![1]).not.toBe(start.mock.calls[0]![1]);
});

it("chat cards load only on demand, never start work, and hide cached answers after logout", async () => {
  useChatState.setState({ loggedIn: true, entityName: "FixtureOwner" });
  const get = vi.spyOn(investigations, "get").mockResolvedValue(investigationSnapshot());
  const start = vi.spyOn(investigations, "start");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <InvestigationCard caseId="fixture-case" attemptId="fixture-attempt" />
    </QueryClientProvider>,
  );
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show private answer" }));
  await screen.findByText("65% chance");
  expect(start).not.toHaveBeenCalled();
  act(() => useChatState.setState({ loggedIn: false, entityName: null }));
  expect(screen.queryByText("65% chance")).toBeNull();
  cache.clear();
});

it("evidence canvas connects only captured stage inputs and outputs", () => {
  const base = {
    attemptId: "attempt",
    actor: "fixture",
    at: 1,
    stageId: "stage",
    inputId: "input",
  };
  const graph = evidenceGraph([
    { ...base, sequence: 1, kind: "stage_started" },
    { ...base, sequence: 2, kind: "stage_completed", outputId: "output" },
  ]);
  expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
    ["input", "stage"],
    ["stage", "output"],
  ]);
  expect(graph.nodes).toHaveLength(3);
  expect(
    evidenceGraph([{ ...base, sequence: 3, kind: "review", message: "unsupported causal claim" }])
      .edges,
  ).toEqual([]);
});
