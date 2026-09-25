// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admin → Ops: the runtime as an operator sees it — every agent with its
 * operator accounting (tokens, spend, pauses, errors, next tick), spend caps,
 * row retention, the prompt budget, the last provider probe and the security
 * posture. Bootstraps from `GET /api/ops/overview` (10 s heartbeat) and
 * refreshes on agent lifecycle events. Server-scoped: a resident sees only its
 * own agents and no provider probe.
 */

import { Bot, Coins, Cpu, Database, Plug, Scale, ShieldCheck } from "lucide-react";
import { useCallback } from "react";
import { OPS_OVERVIEW_KEY, useOpsOverview } from "../../hooks/use-api";
import { useInvalidateOnEvent } from "../../hooks/use-realtime";
import { describeApiError } from "../../lib/api";
import type { DashboardEvent } from "../../lib/types";
import { FetchErrorNotice } from "../FetchErrorNotice";
import { AgentsSection } from "./AgentsSection";
import { DecisionsSection } from "./DecisionsSection";
import { formatAgo } from "./format";
import { PromptBudgetSection } from "./PromptBudgetSection";
import { ProvidersSection } from "./ProvidersSection";
import { Chip, Placeholder, Section } from "./primitives";
import { RetentionSection } from "./RetentionSection";
import { SecuritySection } from "./SecuritySection";
import { SpendSection } from "./SpendSection";

/** Lifecycle events that change the agent table (streaming deltas deliberately excluded). */
export const OPS_REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "agent_spawn",
  "agent_stop",
  "agent_error",
  "agent_state_change",
]);

export function OpsTab({ confirm }: { confirm?: (text: string) => boolean } = {}) {
  const overview = useOpsOverview();
  useInvalidateOnEvent(
    OPS_OVERVIEW_KEY,
    useCallback((event: DashboardEvent) => OPS_REFRESH_EVENTS.has(event.type), []),
    2_000,
  );
  const data = overview.data;
  const privileged = data?.scope === "privileged";

  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="text-text-dim">
          {overview.isLoading && !data
            ? "Loading ops overview…"
            : data
              ? `Live · refreshes every 10 s and on agent events · ${formatAgo(data.generatedAt)}`
              : ""}
          {data && (
            <>
              {" "}
              <Chip
                className={
                  privileged
                    ? "border-emerald-400/60 text-emerald-400"
                    : "border-border text-text-dim"
                }
              >
                {privileged ? "operator scope" : "your agents only"}
              </Chip>
            </>
          )}
        </span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void overview.refetch()}
        >
          Refresh
        </button>
      </div>
      {overview.error && (
        <FetchErrorNotice
          what="ops overview"
          error={describeApiError(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      )}

      <Section
        title="Agents"
        icon={<Bot size={12} />}
        extra={data ? <span className="text-text-dim">{data.agents.length} running</span> : null}
      >
        {data ? (
          <AgentsSection
            agents={data.agents}
            spend={data.spend}
            privileged={privileged}
            confirm={confirm}
          />
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section title="Spend" icon={<Coins size={12} />}>
        {data ? <SpendSection spend={data.spend} agents={data.agents} /> : <Placeholder />}
      </Section>

      <Section title="Retention" icon={<Database size={12} />}>
        {data ? <RetentionSection retention={data.retention} /> : <Placeholder />}
      </Section>

      <Section title="Prompt budget" icon={<Cpu size={12} />}>
        {data ? <PromptBudgetSection prompt={data.prompt} /> : <Placeholder />}
      </Section>

      <Section title="Providers" icon={<Plug size={12} />}>
        {data ? (
          <ProvidersSection providers={data.providers} privileged={privileged} />
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section title="Decisions" icon={<Scale size={12} />}>
        {data ? <DecisionsSection decisions={data.decisions} /> : <Placeholder />}
      </Section>

      <Section title="Security posture" icon={<ShieldCheck size={12} />}>
        {data ? <SecuritySection security={data.security} /> : <Placeholder />}
      </Section>
    </div>
  );
}
