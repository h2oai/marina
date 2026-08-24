// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";
import { useState } from "react";

const RELATIONSHIPS = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "relates_to",
  "supersedes",
  "derived_from",
  "part_of",
] as const;

function labelFor(node: Node): string {
  const content = node.data.content;
  const title = node.data.title;
  const label = typeof title === "string" ? title : typeof content === "string" ? content : node.id;
  return label.length > 52 ? `${label.slice(0, 49)}…` : label;
}

interface DialogFrameProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

function DialogFrame({ title, children, onClose }: DialogFrameProps) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-dialog-title"
        className="w-full max-w-md rounded-lg border border-border bg-bg-card p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="canvas-dialog-title" className="text-sm font-semibold text-text-bright">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-dim hover:text-text"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-primary";
const buttonClass =
  "rounded border border-primary/60 bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-40";

export function CreateCanvasDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <DialogFrame title="Create a canvas" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await onCreate(name.trim(), description.trim());
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-text-dim">
          Name
          <input
            required
            maxLength={80}
            className={`${inputClass} mt-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-xs text-text-dim">
          Description <span className="opacity-60">(optional)</span>
          <textarea
            maxLength={240}
            rows={3}
            className={`${inputClass} mt-1 resize-none`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={buttonClass}>
            {busy ? "Creating…" : "Create canvas"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export function CreateRelationshipDialog({
  nodes,
  onClose,
  onCreate,
}: {
  nodes: Node[];
  onClose: () => void;
  onCreate: (sourceId: string, targetId: string, relationship: string) => Promise<void>;
}) {
  const [sourceId, setSourceId] = useState(nodes[0]?.id ?? "");
  const [targetId, setTargetId] = useState(nodes[1]?.id ?? "");
  const [relationship, setRelationship] = useState<string>("relates_to");
  const [busy, setBusy] = useState(false);
  return (
    <DialogFrame title="Connect selected nodes" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await onCreate(sourceId, targetId, relationship);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-text-dim">
          From
          <select
            className={`${inputClass} mt-1`}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {labelFor(node)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-text-dim">
          Relationship
          <select
            className={`${inputClass} mt-1`}
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
          >
            {RELATIONSHIPS.map((item) => (
              <option key={item} value={item}>
                {item.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-text-dim">
          To
          <select
            className={`${inputClass} mt-1`}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {labelFor(node)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !sourceId || !targetId || sourceId === targetId}
            className={buttonClass}
          >
            {busy ? "Connecting…" : "Create relationship"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
