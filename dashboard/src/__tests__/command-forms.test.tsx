// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandFavorites, FavoriteCommandButton } from "../components/CommandFavorites";
import { CommandFields } from "../components/CommandFields";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { commandForms, composeCommand, parseCommandForm } from "../lib/command-forms";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: vi.fn(async () => []),
}));

const withQuery = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

describe("guided command composition", () => {
  it("builds a crew invitation with an optional role and no raw command syntax", () => {
    const compose = vi.fn();
    render(<CommandFields name="crew" onCompose={compose} />);
    fireEvent.change(screen.getByLabelText("Command action"), {
      target: { value: "crew invite <name> <agent> [role:<r>]" },
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "builders" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "builder" } });
    fireEvent.click(screen.getByLabelText("Include role:r"));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill command" }));
    expect(compose).toHaveBeenCalledWith("invite builders builder role:engineer");
  });
  it("requires numeric experiment observations and valid durable-memory JSON", () => {
    const experiment = parseCommandForm("experiment record <name> <arm> <metric> <value>");
    expect(
      composeCommand(
        experiment,
        { "field-0": "lab3", "field-1": "control", "field-2": "accuracy", "field-3": "many" },
        {},
      ).errors,
    ).toEqual({ "field-3": "Enter a number" });
    const memory = parseCommandForm("memory claim <subject> <predicate> <JSON scalar>");
    expect(
      composeCommand(
        memory,
        { "field-0": "project:marina", "field-1": "status", "field-2": '"active"' },
        {},
      ).command,
    ).toBe('memory claim project:marina status "active"');
    expect(
      composeCommand(memory, { "field-0": "p", "field-1": "status", "field-2": "not json" }, {})
        .errors,
    ).toHaveProperty("field-2");
  });
  it("keeps literal delimiters and user punctuation distinct from modifier prefixes", () => {
    const form = parseCommandForm("task create <title> | <description> [standing:N] [bounty]");
    expect(
      composeCommand(
        form,
        { "field-0": "Review:", "field-1": "Check the release", "field-2": "2" },
        { "option-0": true, "option-1": true },
      ),
    ).toEqual({ command: "task create Review: | Check the release standing:2 bounty", errors: {} });
  });
  it("preserves no-argument actions and removes prose from live usage tables", () => {
    const forms = commandForms({
      name: "code",
      help: "  code profile    Show active profile\n  code apply <patch_id> Apply a pending patch\nExamples:\n  code apply abcd",
    });
    expect(forms.some((form) => form.syntax === "code profile")).toBe(true);
    expect(forms.some((form) => form.syntax.includes("Apply a pending"))).toBe(false);
    expect(forms.some((form) => form.syntax.includes("abcd"))).toBe(false);
  });
  it("uses documented alternatives as a constrained selector", () => {
    const form = parseCommandForm("crew autonomy <name> <manual|supervised|autonomous>");
    expect(form.fields[1]?.kind).toBe("choice");
    expect(
      composeCommand(form, { "field-0": "builders", "field-1": "supervised" }, {}).command,
    ).toBe("crew autonomy builders supervised");
    expect(
      composeCommand(form, { "field-0": "builders", "field-1": "invalid" }, {}).errors,
    ).toHaveProperty("field-1");
  });
  it("keeps identifier alternatives editable and joins arbitrary modifier keys", () => {
    const go = parseCommandForm("goto <room-id|entity-name>");
    expect(go.fields[0]?.kind).toBe("text");
    expect(composeCommand(go, { "field-0": "workbench/start" }, {}).command).toBe(
      "goto workbench/start",
    );
    const probe = commandForms({ name: "probe", help: "" }).find((form) => form.fields.length > 0)!;
    expect(
      composeCommand(probe, { "field-0": "echoing", "field-1": "payload", "field-2": "hello" }, {})
        .command,
    ).toBe("probe echoing payload:hello");
    expect(
      composeCommand(
        probe,
        {
          "field-0": "resolving",
          "field-1": "venue",
          "field-2": "kalshi",
          "field-3": "ticker:KXFED-26MAR",
        },
        { "option-0": true },
      ).command,
    ).toBe("probe resolving venue:kalshi ticker:KXFED-26MAR");
  });
  it("preserves multiline code content and exact edit markers", () => {
    const forms = commandForms({ name: "code", help: "" });
    const write = forms.find((form) => form.syntax.startsWith("code write "))!;
    expect(
      composeCommand(
        write,
        { "field-0": "demo.ts", "field-1": "  const a = 1;\n  console.log(a);" },
        {},
      ),
    ).toEqual({ command: "code write demo.ts\n  const a = 1;\n  console.log(a);", errors: {} });
    const edit = forms.find((form) => form.syntax.startsWith("code edit "))!;
    expect(
      composeCommand(
        edit,
        { "field-0": "demo.ts", "field-1": "old\ntext", "field-2": "new\ntext" },
        {},
      ).command,
    ).toBe("code edit demo.ts\n<<<<<<< OLD\nold\ntext\n=======\nnew\ntext\n>>>>>>> NEW");
  });
});

it("pins a command per resident and drafts it without execution", () => {
  useWorldState.setState({ instanceName: "Favorites test" });
  const send = vi.fn();
  useChatState.setState({ entityName: "FavoritesUser", sendCommand: send });
  const drafted = vi.fn();
  window.addEventListener("marina:draft-command", drafted);
  const view = render(
    withQuery(
      <>
        <FavoriteCommandButton command="agent status builder" />
        <CommandFavorites />
      </>,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pin command" }));
  expect(localStorage.getItem("marina-command-favorites-v1")).toContain("agent status builder");
  fireEvent.click(screen.getByRole("button", { name: "agent status builder" }));
  expect((drafted.mock.calls[0]![0] as CustomEvent).detail.command).toBe("agent status builder");
  expect(send).not.toHaveBeenCalled();
  view.unmount();
  render(withQuery(<CommandFavorites />));
  expect(screen.getByRole("navigation", { name: "Favorite commands" })).toBeInTheDocument();
  window.removeEventListener("marina:draft-command", drafted);
});
