// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { ArrowUpRight, Bot, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { runtimeState, useRoutingOverview } from "../hooks/use-routing-overview";
import { openParticipant } from "../hooks/use-workspace-state";

export function ParticipantAttention({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate: () => void;
}) {
  const [after, setAfter] = useState("");
  const query = useRoutingOverview(true, after, active);
  if (!query.enabled) return null;
  return (
    <section aria-label="Agent attention" className="space-y-2 border-b border-border p-3">
      <div className="flex items-center gap-2 text-primary">
        <MessageCircleQuestion size={16} />
        <h3 className="font-semibold">Your agents need you</h3>
        {query.data && <span className="mission-count ml-auto">{query.data.total}</span>}
      </div>
      {query.isPending && (
        <p role="status" className="mission-skeleton h-12">
          Loading agent requests…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not load agent attention.{" "}
          <button
            className="text-primary underline"
            type="button"
            onClick={() => void query.refetch()}
          >
            Retry agent attention
          </button>
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-text-dim">
          All clear. We’ll surface questions and runtime failures here.
        </p>
      )}
      {query.data?.items.map((item) => {
        const state = runtimeState(item.runtime);
        const request = state?.request;
        const stale =
          !state || Date.now() - state.updatedAt > 45000 || item.session.state === "left";
        return (
          <button
            type="button"
            key={item.session.id}
            className="mission-card flex w-full gap-3 p-3 text-left"
            onClick={() => {
              openParticipant(item.session.id);
              onNavigate();
            }}
          >
            <span className="mission-icon">
              <Bot size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-text-bright">{item.session.label}</span>
              <span className="block break-words text-sm">
                {typeof request?.title === "string"
                  ? request.title
                  : state?.error ||
                    (item.lastDelivery?.kind === "delivery.error"
                      ? "An instruction needs inspection"
                      : "Runtime needs attention")}
              </span>
              <span className="text-xs text-text-dim">
                {stale
                  ? "Last reported · reconnect to act"
                  : request?.kind === "question"
                    ? "Question"
                    : request
                      ? "Permission request"
                      : "Inspect activity"}
                {!item.owned ? " · shared, view only" : ""}
              </span>
            </span>
            <ArrowUpRight size={15} className="shrink-0 text-primary" />
          </button>
        );
      })}
      <div className="flex gap-3 text-xs text-primary">
        {after && (
          <button type="button" onClick={() => setAfter("")}>
            First requests
          </button>
        )}
        {query.data?.nextCursor && (
          <button type="button" onClick={() => setAfter(query.data!.nextCursor!)}>
            More requests
          </button>
        )}
      </div>
    </section>
  );
}
