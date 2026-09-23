// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpsPrompt, OpsPromptSection } from "../../lib/ops-types";
import { formatAgo, formatBytes, TOOL_PROFILE_ORDER } from "./format";
import { Bar, Chip, Metric, OnOff } from "./primitives";

export const PROMPT_SECTIONS_EMPTY_TEXT = "No agent turn carried section metrics in the last 24 h.";

/** Deferral chip: quiet at 0 %, amber once a section has been re-queued at all. */
function deferralChipClass(rate: number): string {
  if (rate <= 0) return "border-border text-text-dim";
  if (rate >= 0.5) return "border-danger/60 bg-danger/10 text-danger";
  return "border-warning/60 bg-warning/10 text-warning";
}

/**
 * One continuation-prompt section over the sampled turns: name, mean / p95 bytes,
 * a bar for its share of the window's prompt bytes, and the deferral rate as a chip.
 */
function PromptSectionRow({ section, maxShare }: { section: OpsPromptSection; maxShare: number }) {
  const deferredPct = Math.round(section.deferralRate * 100);
  const sharePct = Math.round(section.share * 100);
  return (
    <div data-testid={`ops-prompt-section-${section.name}`}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-text-bright">{section.name}</span>
          <Chip
            className={deferralChipClass(section.deferralRate)}
            title={`Deferred past the budget in ${deferredPct}% of ${section.turns} turn${section.turns === 1 ? "" : "s"}`}
          >
            deferred {deferredPct}%
          </Chip>
        </span>
        <span
          className="shrink-0 tabular-nums text-text"
          title={`mean ${formatBytes(section.meanBytes)} · p95 ${formatBytes(section.p95Bytes)} · ${sharePct}% of prompt bytes`}
        >
          {formatBytes(section.meanBytes)}
          <span className="text-text-dim"> · p95 {formatBytes(section.p95Bytes)}</span>
          <span className="text-text-dim"> · {sharePct}%</span>
        </span>
      </div>
      <Bar
        fraction={maxShare > 0 ? section.share / maxShare : 0}
        label={`${section.name}: ${sharePct}% of prompt bytes`}
      />
    </div>
  );
}

export function PromptBudgetSection({ prompt }: { prompt: OpsPrompt }) {
  const sections = prompt.sections ?? [];
  const maxShare = Math.max(...sections.map((s) => s.share), 0);
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
      <section className="space-y-1" aria-label="Prompt sections">
        <div className="flex justify-between text-[8px] uppercase text-text-dim">
          <span>Continuation sections · last 24 h</span>
          <span className="tabular-nums">
            {prompt.turnsSampled ?? 0} turn{(prompt.turnsSampled ?? 0) === 1 ? "" : "s"} sampled
          </span>
        </div>
        {sections.length === 0 ? (
          <div className="text-text-dim">{PROMPT_SECTIONS_EMPTY_TEXT}</div>
        ) : (
          sections.map((section) => (
            <PromptSectionRow key={section.name} section={section} maxShare={maxShare} />
          ))
        )}
      </section>
      <div className="text-[9px] text-text-dim">
        Measured {formatAgo(prompt.computedAt)} (memoized per minute); sections aggregate the event
        log, bytes only.
      </div>
    </div>
  );
}
