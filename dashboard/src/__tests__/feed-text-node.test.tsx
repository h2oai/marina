// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Feed canvas cards name a supervised resident with its vendor tag, and a
 * channel post that answers an earlier post says whom it answers and how
 * deep the thread is.
 */

import { render, screen } from "@testing-library/react";
import { type NodeProps, ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TextNode } from "../canvas/nodes/TextNode";
import { useWorldState } from "../hooks/use-world-state";

function show(data: Record<string, unknown>) {
  return render(
    <ReactFlowProvider>
      <TextNode {...({ id: "n1", data, selected: false } as unknown as NodeProps)} />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  useWorldState.setState({
    entities: [
      { id: "e_2", name: "Iris", kind: "agent", room: "zone/lobby", vendor: "codex" },
      { id: "e_1", name: "qop", kind: "human", room: "zone/lobby" },
    ],
  });
});

describe("feed text node", () => {
  it("tags a resident author with its vendor", () => {
    show({ feedType: "channel_message", author: "Iris", body: "`add(2, 3)` returns `5`." });
    expect(screen.getByText(/by/).textContent).toBe("by Iris[codex]");
  });

  it("leaves a person's name plain", () => {
    show({ feedType: "channel_message", author: "qop", body: "what does add return?" });
    expect(screen.getByText(/by/).textContent).toBe("by qop");
  });

  it("names the answered author and the reply depth, not a node id", () => {
    show({
      feedType: "channel_message",
      author: "Iris",
      body: "5",
      parent_node_id: "0f9c2a1e-aaaa-bbbb-cccc-000000000000",
      inReplyTo: "qop",
      depth: 1,
    });
    const reply = screen.getByTestId("text-node-reply");
    expect(reply.textContent).toBe("↩ in reply toqop↳1reply depth 1");
    expect(reply.textContent).not.toContain("0f9c2a1e");
    expect(screen.getByText("reply depth 1")).toBeTruthy();
  });
});
