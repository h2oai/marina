// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { loadFeedSnapshot, useFeedState } from "../hooks/use-feed-state";
import { describeApiError } from "../lib/api";
import { formatTime } from "../lib/utils";

export function RecentActivity({ onOpen }: { onOpen: () => void }) {
  const events = useFeedState((s) => s.events);
  const error = useFeedState((s) => s.error);
  return (
    <section
      aria-label="Recent activity"
      className="flex shrink-0 items-center gap-3 overflow-x-auto rounded border border-border px-3 py-1 text-[11px]"
    >
      <button type="button" className="shrink-0 text-primary" onClick={onOpen}>
        Recent activity
      </button>
      {error ? (
        <span role="alert">
          Activity unavailable.{" "}
          <button type="button" onClick={() => void loadFeedSnapshot()}>
            Retry
          </button>
        </span>
      ) : events.length ? (
        events.slice(0, 5).map((event) => (
          <button
            type="button"
            onClick={onOpen}
            key={event.id}
            className="max-w-72 shrink-0 truncate text-text-dim"
            title={event.summary}
          >
            <time>{formatTime(event.timestamp)}</time> {event.summary}
          </button>
        ))
      ) : (
        <span className="text-text-dim">No recent events</span>
      )}
    </section>
  );
}

/** Observe failures once at the cache boundary; retry reads, never replay writes. */
export function ApiFeedback() {
  const client = useQueryClient();
  const [failure, setFailure] = useState<{ hash: string; message: string } | null>(null);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        if (event.action.type === "error" && event.query.getObserversCount() > 0) {
          setFailure({
            hash: event.query.queryHash,
            message: describeApiError(event.query.state.error),
          });
        } else if (event.action.type === "success") {
          setFailure((current) => (current?.hash === event.query.queryHash ? null : current));
        }
      }),
    [client],
  );
  if (!failure) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 rounded border border-danger/40 bg-bg px-3 py-2 text-xs"
    >
      <span className="flex-1">{failure.message}</span>
      <button
        type="button"
        className="text-primary"
        onClick={() =>
          void client.refetchQueries({
            predicate: (query) => query.queryHash === failure.hash,
            type: "active",
          })
        }
      >
        Retry
      </button>
      <button type="button" onClick={() => setFailure(null)}>
        Dismiss
      </button>
    </div>
  );
}

export function ConnectionBanner({ connected }: { connected: boolean }) {
  const wasConnected = useRef(false);
  if (connected) wasConnected.current = true;
  if (connected) return null;
  return (
    <div
      role="status"
      className="shrink-0 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      {wasConnected.current
        ? "Reconnecting… Live updates are paused. Retrying automatically."
        : "Connecting to live updates… Retrying automatically."}
    </div>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="Keyboard shortcuts"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto w-[min(440px,calc(100vw-24px))] rounded border border-primary/40 bg-bg p-5 text-text shadow-2xl backdrop:bg-black/60"
    >
      <h2 className="mb-4 font-semibold">Keyboard shortcuts</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
        <dt>Ctrl / ⌘ K</dt>
        <dd>Search and compose commands</dd>
        <dt>Shift Enter</dt>
        <dd>Add a line to a chat command; Enter sends</dd>
        <dt>?</dt>
        <dd>Show this guide</dd>
        <dt>1–3</dt>
        <dd>Focus Chat, Workspace, or Context (1–8 in a saved classic grid)</dd>
        <dt>`</dt>
        <dd>Cycle through panels</dd>
        <dt>Esc</dt>
        <dd>Close a dialog, exit full screen, or restore panel size</dd>
      </dl>
      <p className="my-4 text-xs text-text-dim">
        Use a panel’s maximize button to enlarge it. Panel shortcuts are paused while typing.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="rounded border border-primary px-3 py-1 text-primary"
      >
        Close shortcuts
      </button>
    </dialog>
  );
}

export function PanelSkeleton() {
  return (
    <div role="status" aria-label="Loading panel" className="space-y-3 p-3">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="h-4 w-1/3 rounded bg-bg-hover motion-safe:animate-pulse" />
      {[1, 2, 3].map((row) => (
        <div
          key={row}
          aria-hidden="true"
          className="flex gap-3 rounded border border-border p-3 motion-safe:animate-pulse"
        >
          <div className="h-8 w-8 rounded bg-bg-hover" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/3 rounded bg-bg-hover" />
            <div className="h-3 w-full rounded bg-bg-hover" />
          </div>
        </div>
      ))}
    </div>
  );
}
