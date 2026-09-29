// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeDetailPanel } from "../canvas/components/NodeDetailPanel";
import { useWorkspaceState } from "../hooks/use-workspace-state";

const authFetch = vi.fn();
vi.mock("../lib/api", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

function node(data: Record<string, unknown> = {}, overrides: Partial<Node> = {}): Node {
  return {
    id: "n1",
    type: "text",
    position: { x: 10.4, y: 20.6 },
    style: { width: 200, height: 100 },
    data: { title: "Plan", body: "Draft", author: "Ada", created_at: 1_700_000_000_000, ...data },
    ...overrides,
  } as Node;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const onSetIntent = vi.fn(async (..._args: unknown[]) => {});
const onClose = vi.fn();
const onIntentActionResult = vi.fn();
const onConnect = vi.fn();

function panel(n: Node | null, extra: Record<string, unknown> = {}) {
  return render(
    <NodeDetailPanel
      node={n}
      onClose={onClose}
      canvasId="c1"
      onSetIntent={onSetIntent}
      onIntentActionResult={onIntentActionResult}
      nodes={n ? [n] : []}
      onConnect={onConnect}
      {...extra}
    />,
  );
}

beforeEach(() => {
  authFetch.mockReset();
  for (const fn of [onSetIntent, onClose, onIntentActionResult, onConnect]) fn.mockClear();
});

describe("NodeDetailPanel", () => {
  it("renders nothing without a node", () => {
    const { container } = panel(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows identity, provenance, layout, relationships and data", () => {
    panel(node({ asset_id: "a_9", tags: ["x"] }), {
      relationships: [
        { id: "e1", sourceId: "n1", targetId: "n2", relationship: "cites" },
        { id: "e2", sourceId: "n3", targetId: "n1", relationship: "answers" },
        { id: "e3", sourceId: "n4", targetId: "n5", relationship: "unrelated" },
      ],
    });
    expect(screen.getByRole("complementary", { name: "Node inspector" })).toBeInTheDocument();
    expect(screen.getByText("10, 21")).toBeInTheDocument();
    expect(screen.getByText("200 × 100")).toBeInTheDocument();
    expect(screen.getAllByText("a_9").length).toBeGreaterThan(0);
    expect(screen.getByText("cites: → n2")).toBeInTheDocument();
    expect(screen.getByText("answers: ← n3")).toBeInTheDocument();
    expect(screen.queryByText(/unrelated/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect nodes" }));
    expect(onConnect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close node inspector" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("attaches the node to the workspace to discuss it", () => {
    const attach = vi.fn();
    useWorkspaceState.setState({ attach } as never);
    panel(node());
    fireEvent.click(screen.getByRole("button", { name: "Ask an agent" }));
    expect(attach).toHaveBeenCalledWith({
      canvasId: "c1",
      nodeId: "n1",
      title: "Plan",
      mode: "ask",
    });
  });

  it("saves edited properties and reports a save failure", async () => {
    panel(node());
    fireEvent.change(screen.getByLabelText("Node title"), { target: { value: "Plan B" } });
    fireEvent.change(screen.getByLabelText("Node content"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save properties" }));
    await waitFor(() => expect(onSetIntent).toHaveBeenCalled());
    expect(onSetIntent.mock.calls[0]?.[1]).toMatchObject({ title: "Plan B", body: "New" });
    onSetIntent.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Save properties" }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("sets a new intent from the prompt, prefilled from a drop suggestion", async () => {
    panel(node(), { suggestedPrompt: "Summarize this" });
    const prompt = screen.getByPlaceholderText(/What should an agent do/);
    expect(prompt).toHaveValue("Summarize this");
    fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSetIntent).toHaveBeenCalled());
    expect(onSetIntent.mock.calls[0]?.[1]).toMatchObject({
      intent: { prompt: "Summarize this", status: "pending" },
    });
  });

  it("edits, claims and clears a pending intent", async () => {
    authFetch.mockResolvedValue(jsonResponse({ node: { data: { intent: { status: "active" } } } }));
    panel(node({ intent: { prompt: "Old", status: "pending" } }));
    expect(screen.getByText("Pending")).toBeInTheDocument();
    const update = screen.getByRole("button", { name: "Update Intent" });
    expect(update).toBeDisabled();
    const textarea = screen.getByDisplayValue("Old");
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Newer" } });
    fireEvent.click(update);
    await waitFor(() => expect(onSetIntent).toHaveBeenCalledTimes(1));
    expect(onSetIntent.mock.calls[0]?.[1]).toMatchObject({ intent: { prompt: "Newer" } });

    fireEvent.click(screen.getByRole("button", { name: /Claim Intent/ }));
    await waitFor(() => expect(onIntentActionResult).toHaveBeenCalled());
    expect(authFetch.mock.calls[0]?.[0]).toMatch(/\/api\/canvases\/c1\/nodes\/n1\/intent\/claim$/);

    fireEvent.click(screen.getByRole("button", { name: "Clear intent" }));
    await waitFor(() => expect(onSetIntent).toHaveBeenCalledTimes(2));
    expect(onSetIntent.mock.calls[1]?.[1]).toMatchObject({ intent: undefined });
  });

  it("completes and fails an active intent, surfacing server errors", async () => {
    panel(node({ intent: { prompt: "Do", status: "active", claimedBy: "Ada" } }));
    expect(screen.getByText("by Ada")).toBeInTheDocument();
    const complete = screen.getByRole("button", { name: /Complete Intent/ });
    expect(complete).toBeDisabled();
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    fireEvent.change(screen.getByPlaceholderText(/Deliver the result/), {
      target: { value: "done" },
    });
    fireEvent.click(complete);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/intent\/complete$/);
    expect(JSON.parse(String(init.body))).toEqual({ result: "done" });

    authFetch.mockResolvedValueOnce(jsonResponse({ error: "not yours" }, false, 403));
    fireEvent.click(screen.getByRole("button", { name: /Fail Intent/ }));
    expect((await screen.findAllByText("not yours")).length).toBeGreaterThan(0);
    const [, failInit] = authFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(failInit.body))).toEqual({
      reason: "Unable to complete from dashboard",
    });
  });

  it("shows result and failure reason on finished intents", () => {
    const { unmount } = panel(node({ intent: { prompt: "Do", status: "done", result: "42" } }));
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    unmount();
    panel(node({ intent: { prompt: "Do", status: "failed", failReason: "no data" } }));
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("no data")).toBeInTheDocument();
  });

  it("lists the conversation thread and sends a message as a child node", async () => {
    const parent = node();
    const child = {
      id: "n2",
      position: { x: 0, y: 0 },
      data: { parent_node_id: "n1", body: "Looks good", author: "Bob", created_at: 2 },
    } as Node;
    authFetch.mockResolvedValueOnce(jsonResponse({}));
    panel(parent, { nodes: [parent, child] });
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Say something/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/canvases\/c1\/nodes$/);
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: "text",
      parent_node_id: "n1",
      data: { body: "hi", feedType: "conversation" },
    });
  });

  it("reports a failed message send", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    panel(node());
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Say something/), { target: { value: "hi" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/Say something/), {
      key: "Enter",
      metaKey: true,
    });
    expect(await screen.findByText("Message could not be sent (500).")).toBeInTheDocument();
  });
});
