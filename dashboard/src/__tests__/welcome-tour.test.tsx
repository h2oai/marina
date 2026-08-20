// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatState } from "../hooks/use-chat-state";
import { WelcomeTour } from "../unified/overlays/WelcomeTour";

beforeEach(() => {
  localStorage.clear();
  useChatState.setState({ loggedIn: false, entityName: null, connected: true });
});

describe("WelcomeTour", () => {
  it("directs a newcomer to the login control", () => {
    const openTerminal = vi.fn();
    render(<WelcomeTour instanceName="Test" onOpenTerminal={openTerminal} />);

    fireEvent.click(screen.getByRole("button", { name: /choose a name/i }));

    expect(openTerminal).toHaveBeenCalledOnce();
    expect(
      screen.getByText(/no account is required on the default local setup/i),
    ).toBeInTheDocument();
  });

  it("offers the canonical orientation commands after login", () => {
    const sendCommand = vi.fn(() => true);
    useChatState.setState({ loggedIn: true, entityName: "Kira", sendCommand });
    render(<WelcomeTour instanceName="Test" />);

    expect(screen.getByText(/you're in as Kira/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /look around/i }));
    fireEvent.click(screen.getByRole("button", { name: /read your brief/i }));
    fireEvent.click(screen.getByRole("button", { name: /find the next action/i }));

    expect(sendCommand).toHaveBeenNthCalledWith(1, "look");
    expect(sendCommand).toHaveBeenNthCalledWith(2, "brief");
    expect(sendCommand).toHaveBeenNthCalledWith(3, "next");
    expect(screen.getByRole("button", { name: /read your brief/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /find the next action/i })).toBeInTheDocument();
  });
});
