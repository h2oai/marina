// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CodingDeskPanel } from "../components/CodingDeskPanel";
import { useChatState } from "../hooks/use-chat-state";

vi.mock("../components/panel-resources", () => ({ PanelResource: () => <p>Live resource</p> }));
const send = vi.fn(() => true);
beforeEach(() => {
  send.mockClear();
  useChatState.setState({
    loggedIn: true,
    connected: true,
    codingTargetSupported: true,
    entityName: "Coder",
    sendCommand: send,
  });
});
it("opening personal views is inert and confirmed requests use the captured session and text", () => {
  const view = render(<CodingDeskPanel binding={{ kind: "coding", id: "marina" }} />);
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Request for coder"), {
    target: { value: "Improve Marina itself" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review coding request" }));
  fireEvent.change(screen.getByLabelText("Request for coder"), {
    target: { value: "Later unsent edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm request" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("code ask Improve Marina itself", false, {
    sessionId: "marina",
  });
  view.rerender(<CodingDeskPanel binding={{ kind: "coding", id: "external-project" }} />);
  expect(screen.getByLabelText("Request for coder")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Confirm request" })).toBeNull();
  view.unmount();
  expect(send).toHaveBeenCalledTimes(1);
});
it("a connection lacking explicit session targeting cannot silently send to the selected coder", () => {
  useChatState.setState({ codingTargetSupported: false });
  render(<CodingDeskPanel binding={{ kind: "coding", id: "marina" }} />);
  fireEvent.change(screen.getByLabelText("Request for coder"), { target: { value: "Request" } });
  expect(screen.getByRole("button", { name: "Review coding request" })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

it("freezes the delivery manifest and session until the reviewed action is sent", () => {
  render(<CodingDeskPanel binding={{ kind: "coding", id: "package-session" }} />);
  fireEvent.change(screen.getByLabelText("Delivery manifest path"), {
    target: { value: "delivery.json" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review delivery check" }));
  fireEvent.change(screen.getByLabelText("Delivery manifest path"), {
    target: { value: "another.json" },
  });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Run delivery check" }));
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "code verify delivery manifest:delivery.json",
    false,
    { sessionId: "package-session" },
  );
});

it("freezes the reviewed image path and session without sending on open or draft edits", () => {
  const view = render(<CodingDeskPanel binding={{ kind: "coding", id: "images" }} />);
  fireEvent.change(screen.getByLabelText("Workspace image path"), {
    target: { value: "first image.png" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review image inspection" }));
  fireEvent.change(screen.getByLabelText("Workspace image path"), {
    target: { value: "later.png" },
  });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect image" }));
  expect(send).toHaveBeenCalledExactlyOnceWith('code see {"path":"first image.png"}', false, {
    sessionId: "images",
  });
  view.rerender(<CodingDeskPanel binding={{ kind: "coding", id: "different" }} />);
  expect(screen.getByLabelText("Workspace image path")).toHaveValue("");
  view.unmount();
});
