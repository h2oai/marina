// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * References in messages you can open: a key for each kind of thing a
 * message names, a hover card with what it is, a click that opens its page
 * (or pins the card when it has none), and a bare `#12` that lists every
 * thing it could be instead of guessing.
 */

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInline } from "../../../src/sdk/message-format";
import { MessageBody } from "../components/MessageBody";
import { ReferencePreview } from "../components/ReferencePreview";
import { parseReferenceKey, referenceKey, referenceTargetHref } from "../lib/reference-key";
import { renderWithProviders } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const first = (text: string) =>
  parseInline(text).find((s) => s.kind === "ref" || s.kind === "channel")!;

describe("reference keys", () => {
  it("names what each reference points to", () => {
    expect(referenceKey(first("see task #12"))).toBe("task:12");
    expect(referenceKey(first("see task:12"))).toBe("task:12");
    expect(referenceKey(first("in #general"))).toBe("channel:general");
    expect(referenceKey(first("tell:9"))).toBe("tell:9");
    expect(referenceKey(first("post:41"), { channel: "general" })).toBe("post:general:41");
    // A post with no channel to look in has no preview.
    expect(referenceKey(first("post:41"))).toBeUndefined();
    expect(referenceKey(first("fixed #12"), { channel: "general" })).toBe("any:12:general");
    expect(referenceKey(first("fixed #12"))).toBe("any:12");
  });

  it("parses keys back, and rejects anything malformed", () => {
    expect(parseReferenceKey("post:room:a:41")).toEqual({
      kind: "post",
      channel: "room:a",
      id: 41,
    });
    expect(parseReferenceKey("any:12:general")).toEqual({
      kind: "any",
      id: 12,
      channel: "general",
    });
    expect(parseReferenceKey("task:0")).toBeUndefined();
    expect(parseReferenceKey("channel:a b")).toBeUndefined();
    expect(parseReferenceKey("nope:1")).toBeUndefined();
    expect(referenceTargetHref({ kind: "tell", id: 3 })).toBeUndefined();
    expect(referenceTargetHref({ kind: "task", id: 3 })).toBe("/dashboard?inspect=task:3");
  });
});

describe("references in a message", () => {
  it("links what has a page, makes the rest a button, and previews people", () => {
    const { container } = renderWithProviders(
      <MessageBody text="@Ann task #12 and #7 in #general" channel="general" fold={false} />,
    );
    const task = screen.getByRole("link", { name: "task #12" });
    expect(task).toHaveAttribute("href", "/dashboard?inspect=task:12");
    expect(task).toHaveAttribute("data-ref-preview", "task:12");
    expect(screen.getByRole("button", { name: "#7" })).toHaveAttribute(
      "data-ref-preview",
      "any:7:general",
    );
    expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
      "data-ref-preview",
      "channel:general",
    );
    expect(container.querySelector("[data-entity-preview='Ann']")).not.toBeNull();
  });
});

function stubApi(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      const body = routes[path];
      return body === undefined
        ? { ok: false, status: 404, json: async () => ({ error: "not found" }) }
        : { ok: true, status: 200, json: async () => body };
    }),
  );
}

describe("the preview card", () => {
  it("shows a task on hover", async () => {
    stubApi({
      "/api/coordination/tasks/12": {
        id: 12,
        title: "Ship the parser",
        status: "claimed",
        creator_name: "Ann",
        created_at: 0,
        description: "All four surfaces.",
        parent_task_id: null,
        claims: [{ entity_id: "e", entity_name: "Bo", status: "active", submission_text: null }],
      },
    });
    renderWithProviders(
      <>
        <MessageBody text="see task #12" fold={false} />
        <ReferencePreview />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("link", { name: "task #12" }));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Ship the parser"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("held by Bo");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("a click on a bare #N pins every thing it could be, and a choice opens the post", async () => {
    stubApi({
      "/api/coordination/tasks/7": {
        id: 7,
        title: "Fix the hint",
        status: "open",
        creator_name: "Ann",
        created_at: 0,
        description: "",
        parent_task_id: null,
      },
      "/api/coordination/channels/general/messages/7": {
        id: 7,
        channel: "general",
        sender_name: "Critic",
        content: "Verdict: PASS\n1. checks pass",
        created_at: 0,
      },
    });
    renderWithProviders(
      <>
        <MessageBody text="done in #7" channel="general" fold={false} />
        <ReferencePreview />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "#7" }));
    const dialog = await screen.findByRole("dialog", { name: "Reference details" });
    await waitFor(() => expect(dialog).toHaveTextContent("#7 could be"));
    expect(screen.getByRole("link", { name: /Task 7/ })).toHaveAttribute(
      "href",
      "/dashboard?inspect=task:7",
    );
    fireEvent.click(screen.getByRole("button", { name: /Post 7/ }));
    await waitFor(() => expect(dialog).toHaveTextContent("Verdict: PASS"));
    expect(dialog).toHaveTextContent("post 7 in #general");
  });

  it("a tell the viewer cannot read says so", async () => {
    stubApi({});
    renderWithProviders(
      <>
        <MessageBody text="as in tell:9" fold={false} />
        <ReferencePreview />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "tell:9" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent("Not found, or not visible to you."),
    );
  });
});
