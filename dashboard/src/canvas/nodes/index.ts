// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NodeProps, NodeTypes } from "@xyflow/react";
import { createElement, lazy, Suspense } from "react";
import { AudioNode } from "./AudioNode";
import { A2UINode } from "./a2ui/A2UINode";
import { DocumentNode } from "./DocumentNode";
import { FrameNode } from "./FrameNode";
import { ImageNode } from "./ImageNode";
import { IntentBadge } from "./IntentBadge";
import { NodeActionBar } from "./NodeActionBar";
import { TextNode } from "./TextNode";
import { VideoNode } from "./VideoNode";

const LazyPdfNode = lazy(() => import("./PdfNode"));

function PdfNodeWrapper(props: NodeProps) {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        "div",
        {
          className:
            "rounded-lg bg-gray-900 border border-red-800/50 p-4 text-gray-500 text-sm animate-pulse flex items-center justify-center",
          style: { minWidth: 200, minHeight: 250 },
        },
        "Loading PDF...",
      ),
    },
    createElement(LazyPdfNode, props),
  );
}

/** Wrap a node component to overlay IntentBadge + hover action bar. */
function withIntent(Component: React.ComponentType<NodeProps>): React.ComponentType<NodeProps> {
  function WithIntentBadge(props: NodeProps) {
    return createElement(
      "div",
      { className: "relative w-full h-full group" },
      createElement(Component, props),
      createElement(IntentBadge, { data: props.data as Record<string, unknown> }),
      createElement(NodeActionBar, { nodeId: props.id }),
    );
  }
  WithIntentBadge.displayName = `WithIntent(${Component.displayName || Component.name || "Node"})`;
  return WithIntentBadge;
}

export const nodeTypes: NodeTypes = {
  a2ui: withIntent(A2UINode),
  image: withIntent(ImageNode),
  video: withIntent(VideoNode),
  pdf: withIntent(PdfNodeWrapper),
  audio: withIntent(AudioNode),
  document: withIntent(DocumentNode),
  text: withIntent(TextNode),
  embed: withIntent(TextNode),
  frame: withIntent(FrameNode),
};
