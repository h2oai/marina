// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DetailPanel } from "../components/CoordinationCard";
import { ParticipantAttention } from "../components/ParticipantAttention";
import { TaskEvidence } from "../components/TaskEvidence";
import { WorkLauncher } from "../components/WorkLauncher";
import { useChatState } from "../hooks/use-chat-state";
import { openCanvas, returnFromCanvas, useWorkspaceState } from "../hooks/use-workspace-state";
import type { CodingArtifactEntry, TaskDetail } from "../lib/types";
import { renderWithProviders } from "./test-utils";

const send = vi.fn((_command: string) => true);
const runtime = () => ({
  version: 1,
  role: "supervisor",
  status: "idle",
  mode: "managed",
  updatedAt: Date.now(),
  cwd: "/project",
  adapters: [{ id: "custom", label: "Custom coding tool" }],
});
const overview = (state = runtime()) => ({
  items: [
    {
      session: { id: "runner", label: "Project runner", state: "active" },
      runtime: state,
      owned: true,
    },
  ],
  total: 1,
  nextCursor: null,
});
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("marina_chat_token", "test");
  useChatState.setState({ loggedIn: true, entityName: "Ada", sendCommand: send });
  useWorkspaceState.setState({
    view: "work",
    selection: null,
    canvasOrigin: null,
    participantId: null,
  });
  history.replaceState(null, "", "/dashboard?view=work");
  send.mockClear();
});
afterEach(() => vi.restoreAllMocks());

it("keeps selecting and saving a harness inert, and sends a task only on explicit submission", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([{ id: "p", name: "Orbits", description: "Explore a new view" }]),
  );
  renderWithProviders(<WorkLauncher />);
  await screen.findByRole("option", { name: "Orbits" });
  fireEvent.change(screen.getByLabelText(/Project context/), { target: { value: "p" } });
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  fireEvent.click(screen.getByRole("button", { name: "Remember harness" }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("What would you like to make?"), {
    target: { value: "Build a map" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start work" }));
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "code crew Project context: Orbits\nExplore a new view\n\nBuild a map",
  );
  act(() => useChatState.setState({ entityName: "Grace" }));
  expect(screen.getByRole("button", { name: "Marina" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("What would you like to make?")).toHaveValue("");
});

it("launches a registry-provided runtime and retries a lost response with the identical payload and id", async () => {
  const requests: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) throw new Error("Connection interrupted");
      return Response.json({ id: "receipt" });
    }
    return Response.json(String(url).includes("routing") ? overview() : []);
  });
  renderWithProviders(<WorkLauncher />);
  fireEvent.click(screen.getByRole("button", { name: "Native agent" }));
  await screen.findByRole("option", { name: "Custom coding tool" });
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Comet" } });
  fireEvent.change(screen.getByLabelText("What would you like to make?"), {
    target: { value: "Improve tests" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start work" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(screen.getByLabelText("What would you like to make?")).toHaveValue("Improve tests");
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => expect(useWorkspaceState.getState().participantId).toBe("runner"));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({
    control: {
      action: "launch",
      adapter: "custom",
      workspace: "worktree",
      prompt: "Improve tests",
    },
  });
  expect(send).not.toHaveBeenCalled();
});

it("opens a participant request directly without sending a decision or acknowledging it", async () => {
  const state = {
    ...runtime(),
    role: "agent",
    status: "waiting",
    request: { id: "q", kind: "question", title: "Which branch?" },
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(overview(state)));
  const close = vi.fn();
  renderWithProviders(<ParticipantAttention active onNavigate={close} />);
  fireEvent.click(await screen.findByRole("button", { name: /Which branch/ }));
  expect(useWorkspaceState.getState().participantId).toBe("runner");
  expect(useWorkspaceState.getState().view).toBe("streams");
  expect(close).toHaveBeenCalledOnce();
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("returns from Canvas to the original task selection", () => {
  useWorkspaceState.setState({ selection: { type: "task", id: 42 } });
  openCanvas("board", "node");
  useWorkspaceState.getState().inspect({ type: "node", id: "node" });
  openCanvas(undefined, undefined, true);
  returnFromCanvas();
  expect(useWorkspaceState.getState()).toMatchObject({
    view: "work",
    selection: { type: "task", id: 42 },
    fullscreen: false,
  });
  expect(location.search).toBe("?view=work");
});

it("recovers a task inspector after a failed read and offers claiming only for open work", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockImplementation(async () =>
      Response.json({
        id: 42,
        title: "In progress",
        status: "claimed",
        creator_name: "Ada",
        created_at: 1,
      }),
    );
  renderWithProviders(
    <DetailPanel detail={{ type: "task", id: 42 }} onBack={() => {}} onNavigate={() => {}} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load task");
  fireEvent.click(screen.getByRole("button", { name: "Retry task" }));
  await screen.findByText("#42 In progress");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Claim task" })).not.toBeInTheDocument();
});

it("shows recorded evidence and requests gated review without completing the task optimistically", async () => {
  const run = {
    id: "run",
    session_id: "session",
    kind: "task_run",
    status: "submitted",
    created_by: "Worker",
    created_at: 1000,
    content_text: "",
    title: "Attempt",
    metadata_json: JSON.stringify({
      taskId: 42,
      workerName: "Worker",
      workspace: "/repo",
      verification: "passed",
    }),
  } as CodingArtifactEntry;
  const patch = {
    ...run,
    id: "patch",
    kind: "patch",
    title: "Change",
    content_text: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
    metadata_json: '{"runId":"run"}',
  };
  const task = {
    id: 42,
    title: "Improve navigation",
    creator_name: "Ada",
    status: "claimed",
    codingRuns: [run],
    claims: [
      { entity_id: "worker", entity_name: "Worker", status: "submitted", submission_text: "Ready" },
    ],
  } as TaskDetail;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ run, artifacts: [patch] }),
  );
  renderWithProviders(<TaskEvidence task={task} />);
  expect(await screen.findByText("Change", { selector: "h4" })).toBeVisible();
  expect(screen.getByText("passed", { selector: "strong" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approve submission" }));
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    "code resume session",
    "code review approve run",
  ]);
  expect(screen.getByRole("button", { name: "Approve submission" })).toBeDisabled();
  expect(task.status).toBe("claimed");
});
