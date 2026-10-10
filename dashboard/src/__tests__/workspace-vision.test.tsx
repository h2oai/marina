// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeRenderers } from "../components/ChatCodeRenderers";
import { CodingDeskResource } from "../components/CodingDeskResource";
import type { CodeMessageData } from "../lib/webchat-format";

afterEach(cleanup);
function show(code: CodeMessageData) {
  const send = vi.fn(() => true);
  const renderer = createCodeRenderers({
    copy: async () => {},
    copied: null,
    sendCommandWithOverlay: send,
    renderTextContent: (text) => text,
  });
  render(renderer.renderCodeMessage({ kind: "code", html: "" }, 0, { kind: "code" }, code));
  return send;
}

it("image inspection is an explicit action with a literal path, not a side effect of browsing", () => {
  const path = 'inputs/drawing "sample".png';
  const send = show({
    type: "list",
    event: "files_listed",
    sessionId: "image-session",
    rows: [{ type: "file", path }],
  });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: `Inspect image ${path}` }));
  expect(send).toHaveBeenCalledExactlyOnceWith(`code see ${JSON.stringify({ path })}`, {
    sessionId: "image-session",
  });
});

it("chat reopens saved evidence without requesting vision again", () => {
  const send = show({
    type: "artifact",
    artifactKind: "visual_evidence",
    artifactId: "a1",
    sessionId: "image-session",
    content: "Label: 17 mm",
    metadata: { sourcePath: "drawing.png", model: "test/vision", question: "Read label" },
    commands: ["code show a1"],
  });
  expect(screen.getByText(/not independently verified/)).toBeInTheDocument();
  expect(screen.getByText("Source: drawing.png")).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "code show a1" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("code show a1", { sessionId: "image-session" });
});

it("canvas shows the same observation and separates recorded checks from delivery validation", () => {
  render(
    <CodingDeskResource
      value={{
        session: { title: "Images", status: "active", agent: "Ada" },
        artifacts: [
          {
            id: "a1",
            title: "Drawing",
            kind: "visual_evidence",
            status: "complete",
            content_text: "Label: 17 mm",
            metadata_json: JSON.stringify({ sourcePath: "drawing.png", model: "test/vision" }),
          },
          {
            id: "v1",
            title: "Tests",
            kind: "verification",
            status: "complete",
            content_text: "1 check passed",
            metadata_json: "{}",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("Source: drawing.png")).toBeInTheDocument();
  expect(screen.getByText(/Reopening this evidence/)).toBeInTheDocument();
  expect(
    screen.getByText(/Task acceptance and delivered-file validation are separate/),
  ).toBeInTheDocument();
});
