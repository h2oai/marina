// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Right-click menu for UnifiedCanvas nodes: inspect, bring to front, add a
 * note, and for canvas content open in the viewer, set / claim / complete /
 * fail an intent, or delete the node. The input state stays with the canvas
 * so its Escape and outside-click handling are unchanged.
 */

import type { Node } from "@xyflow/react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { claimIntent, completeIntent, failIntent } from "../hooks/use-canvas-integration";
import type { CommandBarHandle } from "../panels/CommandBar";
import type { ContextType } from "../panels/ContextPanel";
import { type CanvasNodeMeta, isCanvasContentNode } from "../unified-canvas-config";

/** Where the menu opened and on which node. */
export interface NodeContextMenuTarget {
  x: number;
  y: number;
  nodeId: string;
  nodeType: string;
}

export interface NodeContextMenuProps {
  contextMenu: NodeContextMenuTarget;
  displayNodes: Node[];
  setDisplayNodes: Dispatch<SetStateAction<Node[]>>;
  closeContextMenu(): void;
  openContext(type: ContextType, id: string): void;
  onOpenInViewer(node: Node): void;
  sendCommand(command: string): void;
  commandBarRef: RefObject<CommandBarHandle | null>;
  currentEntityName: string | null | undefined;
  removeCanvasNode(nodeId: string): void;
  noteInput: { nodeId: string; nodeType: string } | null;
  setNoteInput(value: { nodeId: string; nodeType: string } | null): void;
  noteText: string;
  setNoteText(value: string): void;
  noteInputRef: RefObject<HTMLInputElement | null>;
  intentActionInput: { nodeId: string; action: "complete" | "fail" } | null;
  setIntentActionInput(value: { nodeId: string; action: "complete" | "fail" } | null): void;
  intentInputRef: RefObject<HTMLInputElement | null>;
}

export function NodeContextMenu({
  contextMenu,
  displayNodes,
  setDisplayNodes,
  closeContextMenu,
  openContext,
  onOpenInViewer,
  sendCommand,
  commandBarRef,
  currentEntityName,
  removeCanvasNode,
  noteInput,
  setNoteInput,
  noteText,
  setNoteText,
  noteInputRef,
  intentActionInput,
  setIntentActionInput,
  intentInputRef,
}: NodeContextMenuProps) {
  return (
    <fieldset
      className="uc-node-context-menu"
      aria-label="Node actions"
      style={{
        margin: 0,
        minWidth: 0,
        position: "fixed",
        left: contextMenu.x,
        top: contextMenu.y,
        zIndex: 200,
      }}
    >
      <button
        type="button"
        onClick={() => {
          const nodeId = contextMenu.nodeId;
          const nodeType = contextMenu.nodeType;
          closeContextMenu();
          if (nodeType === "room") {
            openContext("room", nodeId);
          } else if (isCanvasContentNode(nodeType)) {
            openContext("canvas", nodeId);
          }
        }}
      >
        Inspect
      </button>
      <button
        type="button"
        onClick={() => {
          const nodeId = contextMenu.nodeId;
          closeContextMenu();
          setDisplayNodes((nds) =>
            nds.map((n) => (n.id === nodeId ? { ...n, zIndex: (n.zIndex ?? 0) + 100 } : n)),
          );
        }}
      >
        Move to front
      </button>
      <div className="uc-context-menu-divider" />
      {/* Add Note — inline input or button */}
      {noteInput && noteInput.nodeId === contextMenu.nodeId ? (
        <div style={{ padding: "4px 8px", display: "flex", gap: "4px" }}>
          <input
            ref={noteInputRef}
            type="text"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && noteText.trim()) {
                const target = noteInput.nodeType === "room" ? noteInput.nodeId : noteInput.nodeId;
                sendCommand(`note create ${noteText.trim()} @${target}`);
                setNoteText("");
                setNoteInput(null);
                closeContextMenu();
              }
              if (e.key === "Escape") {
                setNoteText("");
                setNoteInput(null);
              }
            }}
            placeholder="Type note..."
            style={{
              flex: 1,
              background: "var(--color-bg-card)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              fontFamily: "'VT323', monospace",
              fontSize: "14px",
              padding: "3px 6px",
              outline: "none",
              minWidth: 0,
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setNoteInput({ nodeId: contextMenu.nodeId, nodeType: contextMenu.nodeType });
            setNoteText("");
            setTimeout(() => noteInputRef.current?.focus(), 50);
          }}
        >
          Add note
        </button>
      )}
      {isCanvasContentNode(contextMenu.nodeType) && (
        <>
          <div className="uc-context-menu-divider" />
          <button
            type="button"
            onClick={() => {
              const nodeId = contextMenu.nodeId;
              closeContextMenu();
              const node = displayNodes.find((n) => n.id === nodeId);
              if (node) onOpenInViewer(node);
            }}
          >
            Open in viewer
          </button>
          {/* Set intent — inline prompt or button */}
          {noteInput &&
          noteInput.nodeType === "_intent" &&
          noteInput.nodeId === contextMenu.nodeId ? (
            <div style={{ padding: "4px 8px", display: "flex", gap: "4px" }}>
              <input
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && noteText.trim()) {
                    const rawId = contextMenu.nodeId.replace("canvas-", "");
                    const node = displayNodes.find((n) => n.id === contextMenu.nodeId);
                    const canvasId = node
                      ? ((node.data as Record<string, unknown>).canvasId as string)
                      : null;
                    if (canvasId) {
                      try {
                        const { authFetch } = await import("../../lib/api");
                        const existingData = (node?.data as Record<string, unknown>) ?? {};
                        await authFetch(
                          `${window.location.origin}/api/canvases/${canvasId}/nodes/${rawId}`,
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              data: {
                                ...existingData,
                                intent: { prompt: noteText.trim(), status: "pending" },
                              },
                            }),
                          },
                        );
                        commandBarRef.current?.addMessage(
                          null,
                          `Intent set: "${noteText.trim()}"`,
                          true,
                          "system",
                        );
                      } catch {
                        commandBarRef.current?.addMessage(
                          null,
                          "Failed to set intent",
                          true,
                          "system",
                        );
                      }
                    }
                    setNoteText("");
                    setNoteInput(null);
                    closeContextMenu();
                  }
                  if (e.key === "Escape") {
                    setNoteText("");
                    setNoteInput(null);
                  }
                }}
                placeholder="What should be done with this?"
                style={{
                  flex: 1,
                  background: "var(--color-bg-card)",
                  border: "1px solid var(--color-teal)",
                  color: "var(--color-text)",
                  fontFamily: "'VT323', monospace",
                  fontSize: "14px",
                  padding: "3px 6px",
                  outline: "none",
                  minWidth: 0,
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNoteInput({ nodeId: contextMenu.nodeId, nodeType: "_intent" });
                setNoteText("");
              }}
            >
              Set intent
            </button>
          )}
          {/* ── Intent Actions: Claim / Complete / Fail ── */}
          {(() => {
            const node = displayNodes.find((n) => n.id === contextMenu.nodeId);
            const intentData = node ? (node.data as CanvasNodeMeta).intent : undefined;
            if (!intentData) return null;
            const rawId = contextMenu.nodeId.replace("canvas-", "");
            const canvasId = (node!.data as Record<string, unknown>).canvasId as string;
            return (
              <>
                <div className="uc-context-menu-divider" />
                {/* Pending -> Claim */}
                {intentData.status === "pending" && (
                  <button
                    type="button"
                    style={{ color: "#FFB800" }}
                    onClick={async () => {
                      const username = currentEntityName ?? "dashboard-user";
                      closeContextMenu();
                      try {
                        await claimIntent(canvasId, rawId, username);
                        commandBarRef.current?.addMessage(
                          null,
                          `Intent claimed by ${username}`,
                          true,
                          "system",
                        );
                      } catch {
                        commandBarRef.current?.addMessage(
                          null,
                          "Failed to claim intent",
                          true,
                          "system",
                        );
                      }
                    }}
                  >
                    Claim intent
                  </button>
                )}
                {/* Active + owned -> Complete / Fail */}
                {intentData.status === "active" && intentData.claimedBy === currentEntityName && (
                  <>
                    {intentActionInput &&
                    intentActionInput.nodeId === contextMenu.nodeId &&
                    intentActionInput.action === "complete" ? (
                      <div
                        style={{
                          padding: "4px 8px",
                          display: "flex",
                          gap: "4px",
                        }}
                      >
                        <input
                          ref={intentInputRef}
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === "Enter" && noteText.trim()) {
                              closeContextMenu();
                              try {
                                await completeIntent(canvasId, rawId, noteText.trim());
                                commandBarRef.current?.addMessage(
                                  null,
                                  "Intent completed",
                                  true,
                                  "system",
                                );
                              } catch {
                                commandBarRef.current?.addMessage(
                                  null,
                                  "Failed to complete intent",
                                  true,
                                  "system",
                                );
                              }
                            }
                            if (e.key === "Escape") {
                              setNoteText("");
                              setIntentActionInput(null);
                            }
                          }}
                          placeholder="Result text..."
                          style={{
                            flex: 1,
                            background: "var(--color-bg-card)",
                            border: "1px solid #22c55e",
                            color: "var(--color-text)",
                            fontFamily: "'VT323', monospace",
                            fontSize: "14px",
                            padding: "3px 6px",
                            outline: "none",
                            minWidth: 0,
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        style={{ color: "#22c55e" }}
                        onClick={() => {
                          setIntentActionInput({
                            nodeId: contextMenu.nodeId,
                            action: "complete",
                          });
                          setNoteText("");
                          setTimeout(() => intentInputRef.current?.focus(), 50);
                        }}
                      >
                        Complete intent
                      </button>
                    )}
                    {intentActionInput &&
                    intentActionInput.nodeId === contextMenu.nodeId &&
                    intentActionInput.action === "fail" ? (
                      <div
                        style={{
                          padding: "4px 8px",
                          display: "flex",
                          gap: "4px",
                        }}
                      >
                        <input
                          ref={intentInputRef}
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === "Enter" && noteText.trim()) {
                              closeContextMenu();
                              try {
                                await failIntent(canvasId, rawId, noteText.trim());
                                commandBarRef.current?.addMessage(
                                  null,
                                  "Intent failed",
                                  true,
                                  "system",
                                );
                              } catch {
                                commandBarRef.current?.addMessage(
                                  null,
                                  "Failed to update intent",
                                  true,
                                  "system",
                                );
                              }
                            }
                            if (e.key === "Escape") {
                              setNoteText("");
                              setIntentActionInput(null);
                            }
                          }}
                          placeholder="Failure reason..."
                          style={{
                            flex: 1,
                            background: "var(--color-bg-card)",
                            border: "1px solid #ef4444",
                            color: "var(--color-text)",
                            fontFamily: "'VT323', monospace",
                            fontSize: "14px",
                            padding: "3px 6px",
                            outline: "none",
                            minWidth: 0,
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        style={{ color: "#ef4444" }}
                        onClick={() => {
                          setIntentActionInput({
                            nodeId: contextMenu.nodeId,
                            action: "fail",
                          });
                          setNoteText("");
                          setTimeout(() => intentInputRef.current?.focus(), 50);
                        }}
                      >
                        Fail intent
                      </button>
                    )}
                  </>
                )}
                {/* Done/Failed intents: status indicator */}
                {(intentData.status === "done" || intentData.status === "failed") && (
                  <span
                    style={{
                      padding: "4px 12px",
                      fontSize: "12px",
                      color: intentData.status === "done" ? "#22c55e" : "#ef4444",
                      fontFamily: "'VT323', monospace",
                      opacity: 0.7,
                    }}
                  >
                    Intent {intentData.status}
                  </span>
                )}
              </>
            );
          })()}
          <div className="uc-context-menu-divider" />
          <button
            type="button"
            style={{ color: "#ef4444" }}
            onClick={async () => {
              const rawNodeId = contextMenu.nodeId.replace("canvas-", "");
              const reactFlowId = contextMenu.nodeId;
              closeContextMenu();
              try {
                const { authFetch } = await import("../../lib/api");
                const node = displayNodes.find((n) => n.id === reactFlowId);
                const canvasId = node
                  ? ((node.data as Record<string, unknown>).canvasId as string)
                  : null;
                if (canvasId) {
                  const res = await authFetch(
                    `${window.location.origin}/api/canvases/${canvasId}/nodes/${rawNodeId}`,
                    {
                      method: "DELETE",
                    },
                  );
                  if (res.ok) {
                    // Remove from both canvas integration state AND display nodes
                    removeCanvasNode(rawNodeId);
                    setDisplayNodes((nds) => nds.filter((n) => n.id !== reactFlowId));
                    commandBarRef.current?.addMessage(null, "Canvas node deleted", true, "system");
                  }
                }
              } catch {
                commandBarRef.current?.addMessage(null, "Failed to delete node", true, "system");
              }
            }}
          >
            Delete
          </button>
        </>
      )}
    </fieldset>
  );
}
