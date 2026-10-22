// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeContextMenu } from "../unified/overlays/NodeContextMenu";
import type { CommandBarHandle } from "../unified/panels/CommandBar";

/**
 * A refused node mutation (the server's 403 ownership rule) is reported in the
 * command bar with the server's reason, and the node is left in place.
 */

const REFUSAL = "Only the node's author, the canvas owner, or an admin can delete node n1.";

function setup(noteInput: { nodeId: string; nodeType: string } | null = null) {
  const addMessage = vi.fn();
  const commandBarRef = { current: { addMessage } as unknown as CommandBarHandle };
  const removeCanvasNode = vi.fn();
  const setDisplayNodes = vi.fn();
  const node: Node = {
    id: "canvas-n1",
    type: "text",
    position: { x: 0, y: 0 },
    data: { canvasId: "c1", title: "Note" },
  };
  render(
    <NodeContextMenu
      contextMenu={{ x: 0, y: 0, nodeId: "canvas-n1", nodeType: "text" }}
      displayNodes={[node]}
      setDisplayNodes={setDisplayNodes}
      closeContextMenu={() => {}}
      openContext={() => {}}
      onOpenInViewer={() => {}}
      sendCommand={() => {}}
      commandBarRef={commandBarRef}
      currentEntityName="Mallory"
      removeCanvasNode={removeCanvasNode}
      noteInput={noteInput}
      setNoteInput={() => {}}
      noteText="Summarize this"
      setNoteText={() => {}}
      noteInputRef={{ current: null }}
      intentActionInput={null}
      setIntentActionInput={() => {}}
      intentInputRef={{ current: null }}
    />,
  );
  return { addMessage, removeCanvasNode, setDisplayNodes };
}

describe("NodeContextMenu refusals", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: REFUSAL, code: "not_owner" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a refused delete with the server's reason and keeps the node", async () => {
    const { addMessage, removeCanvasNode, setDisplayNodes } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(addMessage).toHaveBeenCalledWith(null, REFUSAL, true, "system"));
    expect(removeCanvasNode).not.toHaveBeenCalled();
    expect(setDisplayNodes).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalledWith(null, "Canvas node deleted", true, "system");
  });

  it("reports a refused intent with the server's reason instead of success", async () => {
    const { addMessage } = setup({ nodeId: "canvas-n1", nodeType: "_intent" });
    const input = screen.getByPlaceholderText("What should be done with this?");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(addMessage).toHaveBeenCalledWith(null, REFUSAL, true, "system"));
    expect(addMessage).not.toHaveBeenCalledWith(
      null,
      'Intent set: "Summarize this"',
      true,
      "system",
    );
  });
});
