// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalWorkspace, terminalWorkspaceToken } from "../components/TerminalWorkspace";
import { useChatState } from "../hooks/use-chat-state";

afterEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("consumes the fragment into tab storage without changing the chat connection", () => {
  history.replaceState(null, "", "/terminal#marina-token=terminal-secret");
  localStorage.setItem("marina_chat_token", "other-chat-session");
  expect(terminalWorkspaceToken()).toBe("terminal-secret");
  expect(location.hash).toBe("");
  expect(terminalWorkspaceToken()).toBe("terminal-secret");
  expect(localStorage.getItem("marina_chat_token")).toBe("other-chat-session");
  localStorage.removeItem("marina_chat_token");
});

it("observes streams with HTTP authentication and disconnects only this view", async () => {
  history.replaceState(null, "", "/terminal#marina-token=terminal-secret");
  useChatState.setState({ loggedIn: false });
  const fetcher = vi.fn(async () => Response.json({ sessions: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  render(<TerminalWorkspace />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).not.toContain("secret");
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer terminal-secret");
  expect(useChatState.getState().loggedIn).toBe(false);
  fireEvent.click(screen.getByText("Disconnect this view"));
  expect(screen.getByText(/Run \/dashboard/)).toBeVisible();
  expect(sessionStorage.getItem("marina_terminal_workspace_token")).toBeNull();
});
