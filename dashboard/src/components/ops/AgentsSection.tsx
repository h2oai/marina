// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { useState } from "react";
import { OPS_OVERVIEW_KEY } from "../../hooks/use-api";
import { describeApiError, postApi } from "../../lib/api";
import type { AgentOperatorRow, OpsAgentStopResponse, OpsSpend } from "../../lib/ops-types";
import { AnimatedNumber } from "../AnimatedNumber";
import {
  descendantsOf,
  formatAgo,
  formatCount,
  formatDuration,
  formatUsd,
  PAUSE_KIND_CLASS,
  PAUSE_KIND_LABEL,
  resumeLabel,
  spendTone,
  stopConfirmText,
} from "./format";
import { Chip, Empty } from "./primitives";

export const AGENTS_EMPTY_TEXT = "No agents running in your scope.";
export const AGENTS_EMPTY_HINT = "agent spawn <name> [model <m>] [role <r>] [goal <g>]";

export function stopUrl(name: string): string {
  return `/api/ops/agents/${encodeURIComponent(name)}/stop`;
}

const TONE_TEXT = {
  default: "text-text-bright",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function AgentsSection({
  agents,
  spend,
  privileged,
  confirm = (text) => window.confirm(text),
}: {
  agents: AgentOperatorRow[];
  spend: OpsSpend;
  privileged: boolean;
  /** Injectable for tests; defaults to `window.confirm`. */
  confirm?: (text: string) => boolean;
}) {
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastStop, setLastStop] = useState<OpsAgentStopResponse | null>(null);

  if (agents.length === 0) {
    return (
      <Empty>
        {AGENTS_EMPTY_TEXT} <code className="text-text">{AGENTS_EMPTY_HINT}</code>
      </Empty>
    );
  }

  const stop = async (row: AgentOperatorRow) => {
    const children = descendantsOf(agents, row.name);
    if (!confirm(stopConfirmText(row.name, children))) return;
    setStopping(row.name);
    setError(null);
    try {
      const result = await postApi<OpsAgentStopResponse>(stopUrl(row.name));
      setLastStop(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...OPS_OVERVIEW_KEY] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setStopping(null);
    }
  };

  const now = Date.now();
  return (
    <div className="space-y-1.5">
      {error && (
        <div
          role="alert"
          className="rounded border border-red-900 bg-red-950/30 p-1.5 text-red-300"
        >
          {error}
        </div>
      )}
      {lastStop && (
        <div className="text-text-dim">
          Stopped <span className="text-text">{lastStop.stopped}</span>
          {lastStop.stoppedChildren.length > 0 && (
            <>
              {" "}
              and {lastStop.stoppedChildren.length} spawned agent
              {lastStop.stoppedChildren.length === 1 ? "" : "s"} (
              {lastStop.stoppedChildren.join(", ")})
            </>
          )}
          .
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[10px]">
          <thead className="text-[8px] uppercase text-text-dim">
            <tr>
              <th className="py-0.5 pr-2">Agent</th>
              <th className="py-0.5 pr-2">Role · model</th>
              <th className="py-0.5 pr-2">Tools</th>
              <th className="py-0.5 pr-2 text-right">Tokens in / out</th>
              <th className="py-0.5 pr-2 text-right">Cost total / 1h</th>
              <th className="py-0.5 pr-2 text-right">Errors</th>
              <th className="py-0.5 pr-2">Last error</th>
              <th className="py-0.5 pr-2">Pause</th>
              <th className="py-0.5 pr-2 text-right">Next tick</th>
              {privileged && <th className="py-0.5" />}
            </tr>
          </thead>
          <tbody>
            {agents.map((row) => {
              const hourTone = spendTone(row.cost.lastHourUsd, spend.caps.perAgentUsd);
              return (
                <tr
                  key={row.name}
                  className="border-t border-border/60 align-top"
                  data-testid={`ops-agent-${row.name}`}
                >
                  <td className="py-1 pr-2">
                    <div className="font-medium text-text-bright">{row.name}</div>
                    <div className="text-[9px] text-text-dim">
                      {row.health ?? row.state}
                      {row.spawnedBy !== "system" && <> · by {row.spawnedBy}</>}
                      {" · up "}
                      {formatDuration(row.uptimeMs)}
                    </div>
                  </td>
                  <td className="py-1 pr-2">
                    <div className="text-accent">{row.role || "—"}</div>
                    <div className="truncate text-[9px] text-text-dim" title={row.model}>
                      {row.model.split("/")[1] ?? row.model}
                    </div>
                  </td>
                  <td className="py-1 pr-2">
                    <Chip>{row.toolProfile}</Chip>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {row.operatorStatus ? (
                      <>
                        {formatCount(row.tokens.input)}
                        <span className="text-text-dim"> / </span>
                        {formatCount(row.tokens.output)}
                      </>
                    ) : (
                      <span
                        className="text-text-dim"
                        title="No operator accounting for this handle"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {formatUsd(row.cost.totalUsd)}
                    <span className="text-text-dim"> / </span>
                    <span className={TONE_TEXT[hourTone]}>{formatUsd(row.cost.lastHourUsd)}</span>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    <AnimatedNumber
                      value={row.consecutiveErrors}
                      className={row.consecutiveErrors > 0 ? "text-warning" : "text-text-dim"}
                    />
                  </td>
                  <td className="max-w-[220px] py-1 pr-2">
                    {row.lastError ? (
                      <span className="text-red-300" title={row.lastError.text}>
                        <span className="text-text-dim">{formatAgo(row.lastError.at, now)} · </span>
                        <span className="line-clamp-2 break-words">{row.lastError.text}</span>
                      </span>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    {row.paused ? (
                      <div className="space-y-0.5">
                        <Chip
                          className={PAUSE_KIND_CLASS[row.paused.kind]}
                          title={row.paused.reason}
                        >
                          paused · {PAUSE_KIND_LABEL[row.paused.kind]}
                        </Chip>
                        <div className="text-[9px] text-text-dim">
                          {resumeLabel(row.paused, now)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-text-dim">
                    {row.nextTickInMs === null ? "—" : formatDuration(row.nextTickInMs)}
                  </td>
                  {privileged && (
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        onClick={() => void stop(row)}
                        disabled={stopping !== null}
                        className="inline-flex items-center gap-1 rounded border border-border px-1 py-0.5 text-text-dim transition-colors hover:border-red-400/60 hover:text-red-300 disabled:opacity-50"
                        title={`Stop ${row.name} (cascades to agents it spawned)`}
                        aria-label={`Stop ${row.name}`}
                      >
                        <Square size={9} />
                        {stopping === row.name ? "stopping…" : "stop"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
