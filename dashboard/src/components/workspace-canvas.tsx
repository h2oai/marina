// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type Node,
  type NodeProps,
  NodeResizeControl,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import type { Layout } from "react-grid-layout";
import {
  completeWorkspaceLayout,
  moveWorkspacePanel,
  resizeWorkspacePanel,
  workspaceGridMetrics,
  workspacePanelRect,
} from "../lib/workspace-canvas-layout";

type PanelNode = Node<
  {
    content: ReactNode;
    panelRef: (element: HTMLDivElement | null) => void;
    resizable: boolean;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight?: number;
    onResizeStart: () => void;
    onResize: (size: { width: number; height: number }) => void;
  },
  "workspacePanel"
>;

/** A host for trusted, already composed panels, with no world lifecycle of its own. */
function WorkspacePanelNode({ id, data }: NodeProps<PanelNode>) {
  return (
    <div
      ref={data.panelRef}
      data-pane-key={id}
      className="workspace-panel-host h-full min-h-0 min-w-0"
    >
      {data.content}
      {data.resizable && (
        <NodeResizeControl
          position="bottom-right"
          className="workspace-panel-resize"
          minWidth={data.minWidth}
          minHeight={data.minHeight}
          maxWidth={data.maxWidth}
          maxHeight={data.maxHeight}
          onResizeStart={data.onResizeStart}
          onResizeEnd={(_event, size) => data.onResize(size)}
        />
      )}
    </div>
  );
}
const nodeTypes = { workspacePanel: WorkspacePanelNode };

export interface WorkspaceCanvasProps {
  panels: Array<[string, ReactNode]>;
  layout: Layout;
  width: number;
  height: number;
  cols: number;
  rowHeight: number;
  focused: string | null;
  /** Phone tabs and fullscreen hide views without unmounting their drafts. */
  visiblePane?: string;
  editable: boolean;
  onLayoutChange: (layout: Layout) => void;
  panelRef: (id: string, element: HTMLDivElement | null) => void;
}

function WorkspaceCanvasInner({
  panels,
  layout: savedLayout,
  width,
  height,
  cols,
  rowHeight,
  focused,
  visiblePane,
  editable,
  onLayoutChange,
  panelRef,
}: WorkspaceCanvasProps) {
  const activeGesture = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<PanelNode>([]);
  const layout = useMemo(
    () =>
      completeWorkspaceLayout(
        savedLayout,
        panels.map(([id]) => id),
        cols,
      ),
    [savedLayout, panels, cols],
  );
  const metrics = useMemo(
    () => workspaceGridMetrics(width, cols, rowHeight),
    [width, cols, rowHeight],
  );
  const projected = useMemo<PanelNode[]>(
    () =>
      panels.flatMap(([id, content]) => {
        const item = layout.find((entry) => entry.i === id);
        if (!item) return [];
        const rect = workspacePanelRect(metrics, item);
        const min = workspacePanelRect(metrics, { ...item, w: item.minW ?? 1, h: item.minH ?? 1 });
        const max = workspacePanelRect(metrics, {
          ...item,
          w: Math.min(item.maxW ?? cols, cols - item.x),
          h: item.maxH ?? item.h,
        });
        return [
          {
            id,
            type: "workspacePanel",
            position: visiblePane ? { x: 0, y: 0 } : { x: rect.left, y: rect.top },
            width: visiblePane ? width : rect.width,
            height: visiblePane ? height : rect.height,
            // Keep the component mounted when hidden: React Flow's `hidden` would remove it.
            style: {
              display: visiblePane && visiblePane !== id ? "none" : undefined,
              // React Flow disables pointer events on non-draggable/non-selectable
              // nodes. Their embedded UI must still work on phones and in focus mode.
              pointerEvents: "auto",
            },
            className: focused === id ? "panel-focused" : undefined,
            dragHandle: ".workspace-panel-host > .glass-panel > .drag-handle",
            draggable: editable && !item.static && item.isDraggable !== false,
            selectable: false,
            focusable: false,
            data: {
              content,
              panelRef: (element) => panelRef(id, element),
              resizable: editable && !item.static && item.isResizable !== false,
              minWidth: min.width,
              minHeight: min.height,
              maxWidth: max.width,
              maxHeight: item.maxH ? max.height : undefined,
              onResizeStart: () => {
                activeGesture.current = id;
              },
              onResize: (size) => {
                activeGesture.current = null;
                setNodes(projected);
                onLayoutChange(resizeWorkspacePanel(layout, id, size, metrics));
              },
            },
          },
        ];
      }),
    [
      panels,
      layout,
      metrics,
      cols,
      width,
      height,
      focused,
      visiblePane,
      editable,
      panelRef,
      onLayoutChange,
      setNodes,
    ],
  );
  useEffect(() => {
    setNodes((current) => {
      const moving = current.find((node) => node.id === activeGesture.current);
      // Live world/query updates refresh panel content during a gesture. They
      // must not snap the panel back to the last committed grid coordinates.
      return projected.map((node) =>
        moving?.id === node.id
          ? {
              ...node,
              position: moving.position,
              width: moving.width,
              height: moving.height,
              dragging: moving.dragging,
              resizing: moving.resizing,
            }
          : node,
      );
    });
  }, [projected, setNodes]);
  const contentHeight = visiblePane
    ? height
    : Math.max(height, ...projected.map((node) => node.position.y + (node.height ?? 0) + 4));

  return (
    <div
      className="workspace-canvas"
      style={{ height: contentHeight }}
      data-workspace-surface="canvas"
    >
      <ReactFlow<PanelNode>
        aria-label="Workspace panels"
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_event, node) => {
          activeGesture.current = node.id;
        }}
        onNodeDragStop={(_event, node) => {
          activeGesture.current = null;
          const next = moveWorkspacePanel(layout, node.id, node.position, metrics);
          // The same grid slot may be returned; always remove the transient drag offset.
          setNodes(projected);
          onLayoutChange(next);
        }}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={1}
        maxZoom={1}
        panOnDrag={false}
        panOnScroll={false}
        autoPanOnNodeDrag={false}
        autoPanOnNodeFocus={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

/** Private layout projection; shared Canvas documents keep their own provider and permissions. */
export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkspaceCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
