// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommandMessage } from "../unified/panels/CommandBar";
import { MessageRow } from "../unified/panels/MessageRow";

function msg(overrides: Partial<CommandMessage>): CommandMessage {
  return {
    id: 1,
    name: null,
    text: "",
    isSys: false,
    type: "room",
    time: 0,
    ...overrides,
  };
}

describe("MessageRow URL linkification", () => {
  it("renders a clickable anchor for a URL in a regular message", () => {
    render(<MessageRow msg={msg({ name: "alice", text: "found https://example.com/docs" })} />);
    const link = screen.getByRole("link", { name: "https://example.com/docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("linkifies the ANSI html branch (search-result shape)", () => {
    // ansiToHtml output: dim span around the URL, as `web search` emits.
    render(
      <MessageRow
        msg={msg({
          text: "https://result.test",
          html: '<span style="opacity:0.6">https://result.test</span>',
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "https://result.test" })).toHaveAttribute(
      "href",
      "https://result.test",
    );
  });

  it("renders plain text without a link when there is no URL", () => {
    render(<MessageRow msg={msg({ text: "just a normal message" })} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("just a normal message")).toBeInTheDocument();
  });
});
