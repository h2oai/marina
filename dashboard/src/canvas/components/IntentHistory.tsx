// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { openCanvas } from "../../hooks/use-workspace-state";

interface Transition {
  status: "active" | "done" | "failed";
  at: number;
  actor?: string;
  previousClaimant?: string;
  reason?: string;
}

function transitions(value: unknown): Transition[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Transition =>
      entry &&
      typeof entry === "object" &&
      ["active", "done", "failed"].includes(entry.status) &&
      Number.isFinite(entry.at) &&
      Math.abs(entry.at) <= 8_640_000_000_000_000 &&
      [entry.actor, entry.previousClaimant, entry.reason].every(
        (field) => field === undefined || typeof field === "string",
      ),
  );
}

export function IntentHistory({
  history,
  author,
  canvasId,
  resultNodeId,
  completed,
}: {
  history: unknown;
  author: string;
  canvasId: string | null;
  resultNodeId?: string;
  completed: boolean;
}) {
  const entries = transitions(history);
  return (
    <section
      aria-label="Request history"
      className="mt-3 rounded border border-border bg-bg/60 p-2 text-xs"
    >
      <h4 className="mb-2 font-medium text-text-bright">Request history</h4>
      <p className="mb-2 text-text-dim">Requested by {author || "unknown"}</p>
      {!entries.length && (
        <p className="text-text-dim">
          No lifecycle history recorded yet. Earlier transitions are unavailable.
        </p>
      )}
      {entries.length > 20 && (
        <p className="text-text-dim">
          Showing the latest 20 of {entries.length} recorded transitions.
        </p>
      )}
      <ol className="space-y-2 border-l border-primary/30 pl-3">
        {entries.slice(-20).map((entry) => (
          <li key={`${entry.at}:${entry.status}:${entry.actor}`}>
            <p className="text-text">
              {entry.actor ?? "Unknown actor"}{" "}
              {entry.status === "active"
                ? entry.previousClaimant
                  ? `took over from ${entry.previousClaimant}`
                  : "claimed the request"
                : entry.status === "done"
                  ? "delivered a result"
                  : "marked the request failed"}
            </p>
            <time className="text-text-dim" dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleString()}
            </time>
            {entry.reason && <p className="break-words text-text-dim">{entry.reason}</p>}
          </li>
        ))}
      </ol>
      {resultNodeId && canvasId && (
        <button
          type="button"
          className="mt-2 text-primary hover:underline"
          onClick={() => openCanvas(canvasId, resultNodeId)}
        >
          Open delivered result
        </button>
      )}
      {completed && (
        <p className="mt-2 text-text-dim">
          A delivered result does not establish verification or task approval. Review linked task
          evidence separately.
        </p>
      )}
    </section>
  );
}
