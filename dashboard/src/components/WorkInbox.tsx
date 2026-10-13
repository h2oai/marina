// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowUpRight, Inbox, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useEntityWork } from "../hooks/use-api";
import { useChatState } from "../hooks/use-chat-state";
import { useInvalidateOnEvent } from "../hooks/use-realtime";
import { openCanvas, useWorkspaceState } from "../hooks/use-workspace-state";
import { draftCommand } from "../lib/command-discovery";
import type { WorkItem } from "../lib/types";

function destination(item: WorkItem, onNavigate: () => void) {
  if (item.target?.kind === "canvas") {
    openCanvas(item.target.canvasId, item.target.nodeId);
  } else if (item.ref?.startsWith("task:")) {
    useWorkspaceState.getState().inspect({ type: "task", id: Number(item.ref.slice(5)) });
  } else {
    draftCommand(item.command ?? item.action);
  }
  onNavigate();
}

export function WorkInbox({
  name,
  active = true,
  onNavigate = () => {},
}: {
  name: string;
  active?: boolean;
  onNavigate?: () => void;
}) {
  const work = useEntityWork(name, active);
  const [expanded, setExpanded] = useState(false);
  const ready = useChatState(
    (state) => state.connected && state.loggedIn && state.entityName === name,
  );
  useInvalidateOnEvent(
    ["entityWork", name],
    (event) =>
      active &&
      (event.type.startsWith("canvas_") ||
        event.type.startsWith("task_") ||
        event.type.startsWith("crew_") ||
        event.entity === name),
  );
  // Never display a previously authorized snapshot after a failed refresh.
  const items = work.isError
    ? []
    : (work.data?.items ?? []).filter((item) => item.kind !== "default");
  return (
    <section aria-label="Work inbox" className="mb-4">
      <div className="mb-2 flex items-center gap-2 text-text-bright">
        <Inbox size={14} className="text-primary" />
        <h3 className="font-semibold">Your next moves</h3>
        <button
          type="button"
          aria-label="Refresh work inbox"
          onClick={() => void work.refetch()}
          className="ml-auto text-text-dim hover:text-primary"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <p className="mb-2 text-xs text-text-dim">
        Prioritized requests, commitments, and reviews for {name}.
      </p>
      {work.isLoading && <p className="text-xs text-text-dim">Loading your work…</p>}
      {work.isError && (
        <div role="alert" className="rounded border border-danger/40 p-2 text-xs text-danger">
          Could not load your work.{" "}
          <button type="button" onClick={() => void work.refetch()} className="underline">
            Retry work inbox
          </button>
        </div>
      )}
      {!work.isLoading && !work.isError && items.length === 0 && (
        <p className="text-xs text-text-dim">Nothing is waiting on you.</p>
      )}
      <div className="space-y-2">
        {(expanded ? items : items.slice(0, 5)).map((item) => (
          <article key={`${item.kind}:${item.ref ?? item.title}`} className="mission-card p-3">
            <div className="flex items-start justify-between gap-2">
              <h4 className="text-sm font-medium text-text-bright">{item.title}</h4>
              {item.status && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 text-xs text-primary">
                  {item.status === "done" ? "Completed" : item.status}
                </span>
              )}
            </div>
            {item.detail && (
              <p className="mt-1 line-clamp-2 break-words text-xs text-text">{item.detail}</p>
            )}
            {item.owner && <p className="mt-1 text-xs text-text-dim">Claimed by {item.owner}</p>}
            {item.status === "done" && (
              <p className="mt-1 text-xs text-text-dim">
                Result delivered · verification and task approval are separate.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => destination(item, onNavigate)}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {item.target
                  ? "Open request"
                  : item.ref?.startsWith("task:")
                    ? "Open task"
                    : "Draft next step"}
                <ArrowUpRight size={12} />
              </button>
              {item.command && (
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => draftCommand(item.command!)}
                  className="text-primary hover:underline disabled:opacity-40"
                >
                  Draft claim
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {items.length > 5 && (
        <button
          type="button"
          className="mt-2 text-xs text-primary hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show fewer suggestions" : `Show all ${items.length} suggestions`}
        </button>
      )}
    </section>
  );
}
