// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";
import { useCallback, useState } from "react";
import type { NodeType } from "../lib/types";

interface SearchBarProps {
  nodes: Node[];
  onFilterChange: (filtered: Node[] | null) => void;
}

const NODE_TYPES: NodeType[] = [
  "image",
  "video",
  "pdf",
  "audio",
  "document",
  "text",
  "embed",
  "frame",
];

const INTENT_FILTERS = [
  { value: "", label: "All intents" },
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "has-intent", label: "Has intent" },
  { value: "no-intent", label: "No intent" },
];

export function SearchBar({ nodes, onFilterChange }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [intentFilter, setIntentFilter] = useState<string>("");

  const applyFilters = useCallback(
    (q: string, type: string, intent: string) => {
      if (!q && !type && !intent) {
        onFilterChange(null);
        return;
      }
      const filtered = nodes.filter((n) => {
        if (type && n.type !== type) return false;
        if (q) {
          const searchable = JSON.stringify(n.data).toLowerCase();
          if (!searchable.includes(q.toLowerCase())) return false;
        }
        if (intent) {
          const nodeIntent = (n.data as Record<string, unknown>).intent as
            | { status: string }
            | undefined;
          if (intent === "has-intent" && !nodeIntent) return false;
          if (intent === "no-intent" && nodeIntent) return false;
          if (["pending", "active", "done", "failed"].includes(intent)) {
            if (nodeIntent?.status !== intent) return false;
          }
        }
        return true;
      });
      onFilterChange(filtered);
    },
    [nodes, onFilterChange],
  );

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        placeholder="Search nodes..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          applyFilters(e.target.value, typeFilter, intentFilter);
        }}
        className="bg-bg-hover text-text text-xs rounded px-2 py-1 border border-border focus:outline-none focus:border-primary w-40"
      />
      <select
        value={typeFilter}
        onChange={(e) => {
          setTypeFilter(e.target.value);
          applyFilters(query, e.target.value, intentFilter);
        }}
        className="bg-bg-hover text-text text-xs rounded px-2 py-1 border border-border focus:outline-none focus:border-primary"
      >
        <option value="">All types</option>
        {NODE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        value={intentFilter}
        onChange={(e) => {
          setIntentFilter(e.target.value);
          applyFilters(query, typeFilter, e.target.value);
        }}
        className="bg-bg-hover text-text text-xs rounded px-2 py-1 border border-border focus:outline-none focus:border-primary"
      >
        {INTENT_FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}
