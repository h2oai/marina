// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import type { RoutingEvent } from "../../../src/sdk/routing-types";
import { participantActivity } from "../lib/participant-activity";

export function ParticipantActivity({
  events,
  adapter,
}: {
  events: RoutingEvent[];
  adapter: string;
}) {
  const [query, setQuery] = useState("");
  const blocks = useMemo(() => participantActivity(events, adapter), [events, adapter]);
  const matching = blocks.filter((block) =>
    `${block.title}\n${block.text ?? ""}\n${block.events.map((event) => JSON.stringify(event)).join("\n")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <label className="mb-3 block text-xs text-text-dim">
        Search loaded activity
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Output, event type, or identifier…"
          className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm text-text"
        />
      </label>
      {query && matching.length === 0 && (
        <p role="status" className="text-sm text-text-dim">
          No matching loaded activity.
        </p>
      )}
      {matching.map((block) => {
        const first = block.events[0]!;
        const last = block.events.at(-1)!;
        return (
          <article
            key={first.sequence}
            className={`mission-card mb-3 min-w-0 border-l-2 p-3 ${block.tone === "danger" ? "border-l-danger" : block.tone === "warning" ? "border-l-warning" : "border-l-primary/50"}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <h4
                className={`text-sm font-medium ${block.tone === "danger" ? "text-danger" : block.tone === "warning" ? "text-warning" : "text-text"}`}
              >
                {block.title}
              </h4>
              <span className="text-xs text-text-dim">
                #{first.sequence}
                {last !== first ? `–${last.sequence}` : ""} ·{" "}
                {new Date(first.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {block.text && (
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
                {block.text}
              </pre>
            )}
            <details className="mt-2 text-xs text-text-dim">
              <summary className="cursor-pointer text-primary">
                Inspect source{" "}
                {block.events.length === 1 ? "event" : `events (${block.events.length})`}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {JSON.stringify(block.events.length === 1 ? first : block.events, null, 2)}
              </pre>
            </details>
          </article>
        );
      })}
    </>
  );
}
