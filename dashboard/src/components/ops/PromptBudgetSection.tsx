// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpsPrompt } from "../../lib/ops-types";
import { formatAgo, formatBytes, TOOL_PROFILE_ORDER } from "./format";
import { Bar, Metric, OnOff } from "./primitives";

export function PromptBudgetSection({ prompt }: { prompt: OpsPrompt }) {
  const systemFraction =
    prompt.systemPromptCapBytes > 0 ? prompt.systemPromptBytes / prompt.systemPromptCapBytes : null;
  const systemTone =
    systemFraction === null
      ? "default"
      : systemFraction > 1
        ? "danger"
        : systemFraction > 0.9
          ? "warning"
          : "success";
  const maxSchema = Math.max(
    ...TOOL_PROFILE_ORDER.map((p) => prompt.residentSchemaBytesByProfile[p]),
    1,
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <Metric
          label="System prompt"
          value={
            <>
              {formatBytes(prompt.systemPromptBytes)}
              <span className="text-text-dim"> / {formatBytes(prompt.systemPromptCapBytes)}</span>
            </>
          }
          tone={systemTone}
          title="getLeanSystemPrompt(null) vs LEAN_SYSTEM_PROMPT_BYTE_CAP"
        />
        <Metric
          label="Continuation budget"
          value={formatBytes(prompt.continuationBudgetBytes)}
          title="CONTINUATION_PROMPT_BUDGET_BYTES (MARINA_CONTINUATION_BUDGET_BYTES)"
        />
        <Metric
          label="Deferred tools"
          value={<OnOff on={prompt.deferredTools} />}
          title="MARINA_DEFERRED_TOOLS (off restores every schema resident)"
        />
        <Metric
          label="Loadable on demand"
          value={
            prompt.deferredTools ? (
              <>
                {prompt.deferredToolCount}
                <span className="text-text-dim"> · {formatBytes(prompt.deferredSchemaBytes)}</span>
              </>
            ) : (
              "—"
            )
          }
          title="Tools reachable through marina_tool_search"
        />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-[9px] text-text-dim">
          <span>System prompt vs cap</span>
          <span className="tabular-nums">
            {systemFraction === null ? "" : `${Math.round(systemFraction * 100)}%`}
          </span>
        </div>
        <Bar
          fraction={systemFraction}
          tone={systemTone}
          label="System prompt bytes against the cap"
        />
      </div>
      <div className="space-y-1">
        <div className="text-[8px] uppercase text-text-dim">Resident tool schemas per profile</div>
        {TOOL_PROFILE_ORDER.map((profile) => {
          const bytes = prompt.residentSchemaBytesByProfile[profile];
          return (
            <div key={profile} data-testid={`ops-profile-${profile}`}>
              <div className="flex justify-between text-[10px]">
                <span className="text-text-bright">{profile}</span>
                <span className="tabular-nums text-text">{formatBytes(bytes)}</span>
              </div>
              <Bar
                fraction={bytes / maxSchema}
                label={`${profile} profile resident schema bytes`}
              />
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-text-dim">
        Measured {formatAgo(prompt.computedAt)} (memoized per minute).
      </div>
    </div>
  );
}
