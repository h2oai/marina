// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { logQueryString, useLogs } from "../hooks/use-api";
import { describeApiError, downloadApi } from "../lib/api";
import type { StructuredLogEntry } from "../lib/types";

const LEVEL_CLASS = {
  debug: "text-text-dim",
  info: "text-cyan-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

export function LogExplorer() {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | StructuredLogEntry["level"]>("all");
  const [category, setCategory] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [actionError, setActionError] = useState<string>();
  const filters = {
    limit: 100,
    ...(cursor ? { cursor } : {}),
    ...(level === "all" ? {} : { level }),
    ...(category.trim() ? { category: category.trim() } : {}),
    ...(query.trim() ? { q: query.trim() } : {}),
  };
  const result = useLogs(filters);
  const data = result.data;
  const resetPage = () => {
    setCursor(undefined);
    setHistory([]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-[10px]">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search logs"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            resetPage();
          }}
          placeholder="Search message or category"
          className="min-w-40 flex-1 rounded border border-border bg-bg px-2 py-1 text-text outline-none focus:border-primary"
        />
        <select
          aria-label="Filter log level"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value as typeof level);
            resetPage();
          }}
          className="rounded border border-border bg-bg px-2 py-1 text-text"
        >
          <option value="all">all levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          aria-label="Filter log category"
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            resetPage();
          }}
          placeholder="category"
          className="w-28 rounded border border-border bg-bg px-2 py-1 text-text outline-none focus:border-primary"
        />
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-text-dim hover:text-text"
          onClick={async () => {
            setActionError(undefined);
            try {
              await downloadApi(
                `/api/logs?${logQueryString(filters)}&format=otlp-json&download=1`,
                "marina-logs-otlp.json",
              );
            } catch (cause) {
              setActionError(describeApiError(cause));
            }
          }}
        >
          Download OTLP
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-text-dim hover:text-text"
          onClick={() => result.refetch()}
        >
          Refresh
        </button>
      </div>

      {result.isLoading && !data && <div className="text-text-dim">Loading logs…</div>}
      {result.error && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-red-300">
          {describeApiError(result.error)}{" "}
          <button type="button" className="underline" onClick={() => result.refetch()}>
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-red-300">
          Export failed: {actionError}
        </div>
      )}
      {data && data.logs.length === 0 && !result.error && (
        <div className="rounded border border-border p-3 text-text-dim">
          No retained logs match these filters.
        </div>
      )}
      {data && data.logs.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg/50">
          {data.logs.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      {data && (
        <div className="flex items-center justify-between text-text-dim">
          <span>
            retention target {data.retention.toLocaleString()} · OTLP{" "}
            {data.otlp.enabled
              ? `${data.otlp.exportedLogs} exported, ${data.otlp.pendingLogs} queued`
              : "off"}
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              disabled={history.length === 0}
              className="rounded border border-border px-2 py-1 disabled:opacity-30"
              onClick={() => {
                const previous = history[history.length - 1];
                setHistory((items) => items.slice(0, -1));
                setCursor(previous);
              }}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!data.page.nextCursor}
              className="rounded border border-border px-2 py-1 disabled:opacity-30"
              onClick={() => {
                setHistory((items) => [...items, cursor]);
                setCursor(data.page.nextCursor);
              }}
            >
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: StructuredLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border/60 px-2 py-1.5 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="grid w-full grid-cols-[68px_72px_90px_1fr] gap-2 text-left"
      >
        <span className="text-text-dim">{new Date(entry.timestamp).toLocaleTimeString()}</span>
        <span className={LEVEL_CLASS[entry.level]}>{entry.level.toUpperCase()}</span>
        <span className="truncate text-violet-300">{entry.category}</span>
        <span className="break-words text-text">{entry.message}</span>
      </button>
      {expanded && (
        <div className="ml-[232px] mt-1 space-y-1 text-text-dim">
          {entry.traceId && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("marina:open-traces", { detail: { traceId: entry.traceId } }),
                )
              }
            >
              trace {entry.traceId}
            </button>
          )}
          {entry.spanId && <div>span {entry.spanId}</div>}
          {entry.requestId && <div>request {entry.requestId}</div>}
          {entry.entityId && <div>entity {entry.entityId}</div>}
          {entry.data && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
