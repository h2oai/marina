// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages in the dashboard: the shared grammar rendered as React (lists,
 * labels, chips, quiet asides, references that open the inspector, your
 * mentions), no markup from the message ever reaching the DOM, folding, and
 * the chat layout (speaker from structured fields, grouping, day breaks).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { speechLayout } from "../components/ChatMessageList";
import { MessageBody } from "../components/MessageBody";
import type { ChatMessage } from "../hooks/use-chat-state";
import { identityColor, initials } from "../lib/identity-color";
import { parseSpeech } from "../lib/perception";

const long =
  "Reviewed against the newer text, not the cited note. Two findings from my seat: 1. The cursor parameter is named cursor and is parsed. 2. Staleness is not self-inflicted. Not claimed: any conclusion about gate placement.";

describe("MessageBody", () => {
  it("recovers a list and a lead-in label from a one-line message", () => {
    const { container } = render(<MessageBody text={long} fold={false} />);
    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/^The cursor parameter/);
    expect(screen.getByText("Not claimed:").tagName).toBe("STRONG");
  });

  it("renders a Markdown link as its label, linking only to http(s)", () => {
    const { container } = render(
      <MessageBody
        text={
          "Duties apply ([Commission factpage](https://example.eu/gpai)). [bad](javascript:alert(1))"
        }
        fold={false}
      />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe("Commission factpage");
    expect(links[0]!.getAttribute("href")).toBe("https://example.eu/gpai");
    expect(container.textContent).not.toContain("](https://");
    expect(container.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("renders a message's markup as text, never as HTML", () => {
    const { container } = render(
      <MessageBody text={'<img src=x onerror="alert(1)"> <b>bold</b> **real**'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect(screen.getByText("real").tagName).toBe("STRONG");
  });

  it("verdict chips, quiet asides, code, ids", () => {
    const { container } = render(
      <MessageBody text={"#21 REVIEWED AND APPROVED (see `task approve 21`) id 03a35b94"} />,
    );
    const chip = screen.getByText("REVIEWED AND APPROVED");
    expect(chip.className).toContain("text-success");
    expect(container.querySelector("code")?.textContent).toBe("task approve 21");
    const aside = container.querySelector("span.text-text-dim");
    expect(aside?.textContent).toBe("(see task approve 21)");
    expect(screen.getByText("03a35b94").className).toContain("font-mono");
  });

  it("typed references open the inspector; a bare one asks what it names", () => {
    render(<MessageBody text="claimed task #22, see #general and #9" />);
    expect(screen.getByText("task #22").getAttribute("href")).toBe("/dashboard?inspect=task:22");
    expect(screen.getByText("#general").getAttribute("href")).toBe(
      "/dashboard?inspect=channel:general",
    );
    // A bare #9 could be a task or a post: a button whose card lists what exists.
    expect(screen.getByText("#9").tagName).toBe("BUTTON");
    expect(screen.getByText("#9").getAttribute("data-ref-preview")).toBe("any:9");
  });

  it("highlights a mention of the viewer only", () => {
    render(<MessageBody text="@Ann and @Bob please check" viewer="ann" />);
    expect(screen.getByText("@Ann").className).toContain("bg-warning");
    expect(screen.getByText("@Bob").className).not.toContain("bg-warning");
  });

  it("folds a long message behind Read more", () => {
    render(<MessageBody text={"word ".repeat(220)} />);
    const button = screen.getByRole("button", { name: "Read more" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });
});

describe("chat layout", () => {
  const at = Date.UTC(2026, 10, 4, 15, 0);
  const channelMsg = (sender: string, content: string, timestamp: number): ChatMessage =>
    ({
      html: "",
      text: `[general] ${sender}: ${content}`,
      kind: "message",
      tag: "general",
      timestamp,
      perception: {
        kind: "message",
        tag: "general",
        timestamp,
        data: { senderName: sender, channel: "general", content },
      },
    }) as unknown as ChatMessage;

  it("reads the speaker and a multi-line body from structured fields", () => {
    const meta = parseSpeech("Ann says: line one\n  line two", "say", {
      kind: "message",
      tag: "say",
      timestamp: at,
      data: { senderName: "Ann", message: "line one\nline two" },
    } as never);
    expect(meta).toMatchObject({
      speaker: "Ann",
      body: "line one\nline two",
      perspective: "other",
    });
    const echo = parseSpeech("[general] You: hi\n  there", "general", {
      kind: "message",
      tag: "general",
      timestamp: at,
      data: { delivery: { kind: "channel", target: "general", message: "hi\nthere" } },
    } as never);
    expect(echo).toMatchObject({ speaker: "You", body: "hi\nthere", channel: "general" });
  });

  it("groups a run from one sender within five minutes and marks a new day", () => {
    const layout = speechLayout([
      channelMsg("Critic", "a", at),
      channelMsg("Critic", "b", at + 60_000),
      channelMsg("Builder", "c", at + 120_000),
      channelMsg("Builder", "d", at + 20 * 60_000),
      channelMsg("Builder", "e", at + 86_400_000),
    ]);
    expect(layout.map((l) => l.grouped)).toEqual([false, true, false, false, false]);
    expect(layout.map((l) => !!l.day)).toEqual([false, false, false, false, true]);
  });

  it("identity colours are stable and initials are short", () => {
    expect(identityColor("Critic")).toBe(identityColor("Critic"));
    expect(identityColor("Critic")).toContain("var(--color-text-bright)");
    expect(initials("Builder")).toBe("Bu");
    expect(initials("Ada Lovelace")).toBe("AL");
  });
});
