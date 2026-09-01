// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunGuide } from "../components/FirstRunGuide";
import { useChatState } from "../hooks/use-chat-state";

beforeEach(() => {
  localStorage.clear();
  useChatState.setState({
    loggedIn: false,
    entityName: null,
    connected: true,
    commandHistory: [],
  });
});

describe("FirstRunGuide", () => {
  it("focuses the standard dashboard login path for a newcomer", () => {
    const focusChat = vi.fn();
    render(<FirstRunGuide onFocusChat={focusChat} onOpenKeys={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /choose a name/i }));

    expect(focusChat).toHaveBeenCalledOnce();
    expect(screen.getByRole("complementary", { name: /getting started/i })).toBeInTheDocument();
  });

  it("sends and records the three canonical orientation commands", () => {
    const sendCommand = vi.fn(() => true);
    useChatState.setState({ loggedIn: true, entityName: "Kira", sendCommand });
    const openKeys = vi.fn();
    render(<FirstRunGuide onFocusChat={() => {}} onOpenKeys={openKeys} />);

    fireEvent.click(screen.getByRole("button", { name: /look around/i }));
    fireEvent.click(screen.getByRole("button", { name: /read your brief/i }));
    fireEvent.click(screen.getByRole("button", { name: /find the next action/i }));

    expect(sendCommand).toHaveBeenNthCalledWith(1, "look");
    expect(sendCommand).toHaveBeenNthCalledWith(2, "brief");
    expect(sendCommand).toHaveBeenNthCalledWith(3, "next");
    fireEvent.click(screen.getByRole("button", { name: /connect an ai provider/i }));
    expect(openKeys).toHaveBeenCalledOnce();
  });

  it("begins a journey from one ordinary-language desire", () => {
    const sendCommand = vi.fn(() => true);
    const focusChat = vi.fn();
    useChatState.setState({ loggedIn: true, entityName: "Kira", sendCommand });
    render(<FirstRunGuide onFocusChat={focusChat} onOpenKeys={() => {}} />);

    fireEvent.change(screen.getByLabelText(/what would you like to explore, understand, decide/i), {
      target: { value: "Decide where to live" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Begin" }));

    expect(focusChat).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith("desire Decide where to live");
  });

  it("can be reopened after dismissal", () => {
    render(<FirstRunGuide onFocusChat={() => {}} onOpenKeys={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss getting-started guide/i }));
    fireEvent.click(screen.getByRole("button", { name: /start here/i }));
    expect(screen.getByRole("complementary", { name: /getting started/i })).toBeInTheDocument();
  });
});
