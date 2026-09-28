// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compileCommandForms } from "../../../src/sdk/command-forms";
import { CommandInputAssistance } from "../components/CommandInputAssistance";
import { MemoryContextCard } from "../components/MemoryContextCard";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { requestParticipant } from "../lib/memory-service";

vi.mock("../lib/memory-service", () => ({ requestParticipant: vi.fn() }));
const request = vi.mocked(requestParticipant);
const catalog = [
  {
    name: "memory",
    aliases: [],
    category: "Memory",
    minRank: 0,
    help: "Remember evidence.",
    forms: [],
  },
  {
    name: "note",
    aliases: [],
    category: "Memory",
    minRank: 0,
    help: "Record an observation.",
    forms: compileCommandForms([
      "note <text>",
      {
        syntax: "note claim <text> [confidence:0..1] [source:URL] [observed:YYYY-MM-DD]",
        fields: { confidence: { kind: "number", min: 0, max: 1 } },
      },
    ]),
  },
  {
    name: "emote",
    aliases: ["me"],
    category: "Communication",
    minRank: 0,
    help: "Express an action.",
    forms: [],
  },
];
function Input({ codeMode = false }: { codeMode?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea ref={input} aria-label="Command" />
      <CommandInputAssistance input={input} codeMode={codeMode} />
    </>
  );
}
beforeEach(() => {
  useWorldState.setState({ entities: [] });
  useChatState.getState().setLoggedIn(true, "Ada");
  request.mockReset();
  request.mockResolvedValue({ commands: catalog });
});
afterEach(() => {
  useChatState.getState().setLoggedIn(false);
  useWorldState.setState({ entities: [] });
});

it("completes slash commands and action prefixes, then shows the selected action's fields", async () => {
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  try {
    render(<Input />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const input = screen.getByLabelText("Command");
    fireEvent.input(input, { target: { value: "/me" } });
    await screen.findByRole("option", { name: /emote/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe("emote ");
    fireEvent.input(input, { target: { value: "/mem" } });
    await screen.findByRole("option", { name: /memory/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect((draft.mock.calls[1]![0] as CustomEvent).detail.command).toBe("memory ");
    fireEvent.input(input, { target: { value: "note cl" } });
    await within(screen.getByRole("listbox")).findByRole("option", { name: /note claim/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect((draft.mock.calls[2]![0] as CustomEvent).detail.command).toBe("note claim ");
    await waitFor(() =>
      expect(screen.getByLabelText("Command action")).toHaveValue(catalog[1]!.forms[1]!.syntax),
    );
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "A measured result" } });
    fireEvent.click(screen.getByLabelText("Include confidence:0..1"));
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Confidence/ }), {
      target: { value: "1.1" },
    });
    expect(screen.getByRole("button", { name: "Fill command" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Confidence/ }), {
      target: { value: "0.8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill command" }));
    expect((draft.mock.calls[3]![0] as CustomEvent).detail.command).toBe(
      "note claim A measured result confidence:0.8 ",
    );
  } finally {
    window.removeEventListener("marina:draft-command", draft);
  }
});

it("keeps world completion and parameter helpers out of Code Mode", async () => {
  render(<Input codeMode />);
  fireEvent.input(screen.getByLabelText("Command"), { target: { value: "note claim " } });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Command action")).not.toBeInTheDocument();
});

it("ignores a stale discovery response after a newer refresh", async () => {
  let stale!: (result: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        stale = resolve;
      }),
  );
  request.mockResolvedValue({ commands: [catalog[0]] });
  render(<Input />);
  const input = screen.getByLabelText("Command");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "/me" } });
  await screen.findByRole("option", { name: /memory/ });
  await act(async () => stale({ commands: [catalog[2]] }));
  expect(screen.getByRole("option", { name: /memory/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /emote/ })).not.toBeInTheDocument();
});

it("resets keyboard selection when a catalog refresh shrinks the suggestions", async () => {
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  try {
    render(<Input />);
    const input = screen.getByLabelText("Command");
    fireEvent.input(input, { target: { value: "/me" } });
    await screen.findByRole("option", { name: /memory/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    request.mockResolvedValue({ commands: [catalog[2]] });
    fireEvent.focus(input);
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /memory/ })).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(input, { key: "Tab" });
    expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe("emote ");
  } finally {
    window.removeEventListener("marina:draft-command", draft);
  }
});

it("keeps the selected command when a refresh reorders the catalog", async () => {
  render(<Input />);
  const input = screen.getByLabelText("Command");
  fireEvent.input(input, { target: { value: "/me" } });
  await screen.findByRole("option", { name: /memory/ });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  request.mockResolvedValue({ commands: [catalog[0]] });
  fireEvent.focus(input);
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: /emote/ })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("option", { name: /memory/ })).toHaveAttribute("aria-selected", "true");
});

it("uses the visible catalog for a native key event immediately after a refresh commit", async () => {
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  const observer = new MutationObserver(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    if (options.length === 1 && options[0]!.textContent?.includes("emote")) {
      observer.disconnect();
      // Deliver before React's passive effects: this is the browser event boundary,
      // not fireEvent's act wrapper (which can flush the stale listener first).
      screen
        .getByLabelText("Command")
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
    }
  });
  try {
    render(<Input />);
    const input = screen.getByLabelText("Command");
    fireEvent.input(input, { target: { value: "/me" } });
    await screen.findByRole("option", { name: /memory/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    observer.observe(document.body, { childList: true, subtree: true });
    request.mockResolvedValue({ commands: [catalog[2]] });
    fireEvent.focus(input);
    await waitFor(() => expect(draft).toHaveBeenCalledTimes(1));
    expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe("emote ");
  } finally {
    observer.disconnect();
    window.removeEventListener("marina:draft-command", draft);
  }
});

it("refreshes room-specific discovery without requiring the resident to blur the input", async () => {
  render(<Input />);
  const input = screen.getByLabelText("Command");
  fireEvent.input(input, { target: { value: "/me" } });
  await screen.findByRole("option", { name: /memory/ });
  request.mockResolvedValue({ commands: [catalog[2]] });
  act(() =>
    useWorldState.setState({
      entities: [
        {
          id: "ada",
          name: "Ada",
          kind: "agent",
          room: "new-room",
          properties: { rank: 1 },
        },
      ],
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: /memory/ })).not.toBeInTheDocument(),
  );
  expect(await screen.findByRole("option", { name: /emote/ })).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
});

it("shows only the resident's preview in the sidebar and clears it on logout", async () => {
  request.mockResolvedValue({
    createdAt: Date.now(),
    context: {
      entity: "Ada",
      query: "opal",
      scope: "all",
      usedBytes: 12,
      budgetBytes: 4096,
      truncated: false,
      degraded: [],
      tiers: [
        {
          tier: "unverified",
          items: [
            { id: "1", content: "opal own observation", provenance: "own assertion", bytes: 12 },
          ],
          omitted: 0,
        },
      ],
    },
  });
  render(<MemoryContextCard />);
  fireEvent.click(screen.getByText("My memory context", { exact: true }));
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: "opal" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh context" }));
  await screen.findByText("opal own observation");
  expect(request).toHaveBeenCalledWith(
    "context_preview",
    { query: "opal", scope: "all", budgetBytes: 4096 },
    expect.any(AbortSignal),
  );
  act(() => useChatState.getState().setLoggedIn(false));
  expect(screen.queryByText("opal own observation")).not.toBeInTheDocument();
  expect(screen.getByText(/Sign in to world chat/)).toBeVisible();
});

it("debounces focus bursts and cancels the scheduled refresh on unmount", async () => {
  vi.useFakeTimers();
  try {
    const view = render(<Input />);
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText("Command");
    for (let i = 0; i < 10; i++) fireEvent.focus(input);
    await act(async () => vi.advanceTimersByTime(149));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.focus(input);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(500));
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves an edited form while a late world snapshot revalidates an unchanged schema", async () => {
  render(<Input />);
  const input = screen.getByLabelText("Command");
  fireEvent.input(input, { target: { value: "note claim " } });
  const text = await screen.findByLabelText("Text");
  fireEvent.change(text, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByLabelText("Include confidence:0..1"));
  fireEvent.change(screen.getByRole("spinbutton", { name: /^Confidence/ }), {
    target: { value: "0.8" },
  });
  let resolveRefresh!: (value: { commands: typeof catalog }) => void;
  const refresh = new Promise<{ commands: typeof catalog }>((resolve) => {
    resolveRefresh = resolve;
  });
  request.mockReturnValueOnce(refresh);
  act(() =>
    useWorldState.setState({
      entities: [
        { id: "ada", name: "Ada", kind: "agent", room: "initial-room", properties: { rank: 1 } },
      ],
    }),
  );
  expect(screen.getByLabelText("Text")).toHaveValue("Keep this draft");
  expect(screen.getByRole("button", { name: "Fill command" })).toBeDisabled();
  await act(async () => resolveRefresh({ commands: structuredClone(catalog) }));
  expect(screen.getByLabelText("Text")).toHaveValue("Keep this draft");
  expect(screen.getByRole("spinbutton", { name: /^Confidence/ })).toHaveValue(0.8);
  expect(screen.getByRole("button", { name: "Fill command" })).toBeEnabled();
});

it("clears parameter values when a refresh changes the field contract under the same syntax", async () => {
  render(<Input />);
  const input = screen.getByLabelText("Command");
  fireEvent.input(input, { target: { value: "note claim " } });
  fireEvent.change(await screen.findByLabelText("Text"), { target: { value: "Old meaning" } });
  const changed = structuredClone(catalog);
  changed[1]!.forms[1]!.fields[0]!.label = "New meaning";
  request.mockResolvedValue({ commands: changed });
  fireEvent.focus(input);
  expect(await screen.findByLabelText("New meaning")).toHaveValue("");
});
