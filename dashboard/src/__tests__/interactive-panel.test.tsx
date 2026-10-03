// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { InteractivePanel } from "../components/InteractivePanel";
import { useChatState } from "../hooks/use-chat-state";
import { authFetch } from "../lib/api";

vi.mock("../hooks/use-canvas-node", () => ({ useCanvasNode: () => ({ isPending: false }) }));
vi.mock("../lib/api", async (original) => ({
  ...(await original<object>()),
  authFetch: vi.fn(),
  fetchApi: vi.fn(async () => ({
    items: [{ owned: true, session: { id: "me", label: "My session", state: "active" } }],
  })),
}));
const document = {
  title: "Project",
  panelRevision: "revision-one",
  components: [
    { id: "root", component: "Column", children: ["text", "send"] },
    { id: "text", component: "TextField", label: "Message" },
    {
      id: "send",
      component: "Button",
      label: "Send",
      operation: { kind: "message", targetId: "target", message: { field: "text" } },
    },
  ],
};
function wrap(children: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  useChatState.setState({ loggedIn: true, entityName: "Author" });
});
it("keeps repeated drafts independent and never submits until explicit action confirmation", async () => {
  vi.mocked(authFetch).mockResolvedValue(
    Response.json({
      status: "queued",
      receipt: { id: "receipt-1" },
      message: "Waiting for participant.",
    }),
  );
  render(
    wrap(
      <>
        <InteractivePanel canvasId="board" nodeId="one" data={document} />
        <InteractivePanel canvasId="board" nodeId="one" data={document} />
      </>,
    ),
  );
  const fields = screen.getAllByLabelText("Message");
  fireEvent.change(fields[0]!, { target: { value: "My draft" } });
  expect(fields[1]).toHaveValue("");
  expect(authFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]!);
  await screen.findByRole("option", { name: /My session/ });
  fireEvent.change(screen.getByLabelText("Sending participant"), { target: { value: "me" } });
  expect(authFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
  await screen.findByText(/receipt-1/);
  const body = JSON.parse(String(vi.mocked(authFetch).mock.calls[0]![1]?.body));
  expect(body).toMatchObject({
    fields: { text: "My draft" },
    sourceId: "me",
    revision: "revision-one",
  });
  expect(fields[0]).toHaveValue("My draft");
});
it("a changed publication cannot redirect an already reviewed draft", async () => {
  const client = new QueryClient();
  const content = (revision: string) => (
    <QueryClientProvider client={client}>
      <InteractivePanel
        canvasId="board"
        nodeId="one"
        data={{ ...document, panelRevision: revision }}
      />
    </QueryClientProvider>
  );
  const view = render(content("old"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.rerender(content("new"));
  expect(await screen.findByText(/Panel changed/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm action" })).toBeDisabled();
  expect(screen.getByLabelText("Message")).toHaveValue("keep me");
  expect(authFetch).not.toHaveBeenCalled();
});
it("legacy failures are visible and unavailable content cannot masquerade as an empty panel", async () => {
  vi.mocked(authFetch).mockResolvedValue(
    Response.json({ error: "Access revoked" }, { status: 403 }),
  );
  render(
    wrap(
      <InteractivePanel
        canvasId="board"
        nodeId="one"
        data={{
          panelRevision: "old",
          components: [
            { id: "b", component: "Button", label: "Save", action: { event: { name: "save" } } },
          ],
        }}
      />,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Access revoked"));
});

it("live defaults seed untouched fields while edits remain local through later refreshes", () => {
  const client = new QueryClient();
  const content = (text: string) => (
    <QueryClientProvider client={client}>
      <InteractivePanel
        canvasId="board"
        nodeId="one"
        data={{
          ...document,
          components: document.components.map((c) => (c.id === "text" ? { ...c, value: text } : c)),
        }}
      />
    </QueryClientProvider>
  );
  const view = render(content("Loading"));
  view.rerender(content("Loaded default"));
  expect(screen.getByLabelText("Message")).toHaveValue("Loaded default");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "My edit" } });
  view.rerender(content("New remote value"));
  expect(screen.getByLabelText("Message")).toHaveValue("My edit");
});
