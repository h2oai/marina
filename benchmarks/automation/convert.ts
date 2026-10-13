// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AutomationBench exports → Marina's benchmark ledger. A thin adapter:
 * AutomationBench (`auto-bench`) runs unmodified with its model pointed at a
 * Marina `/v1`; this module only reads the `--export-json` files it writes.
 *
 * Each exported task becomes one ledger item keyed by the task name
 * (`<domain>.<task>`): correct when AutomationBench marks it `passed`, score =
 * its assertion fraction. Transcripts, end states and assertion text are never
 * copied — ids and outcomes only, like every ledger import.
 *
 * Infrastructure failures (no export, no task in it, a task AutomationBench
 * reports aborted, a task that never reached the model) are counted in
 * `config.infrastructureErrors` and filed as fallbacks; `--require-clean`
 * refuses to write anything when there is one.
 */

import type { HarnessResultFile } from "../../src/engine/benchmark-ledger";

/** The ledger's benchmark id (also the `x-marina-eval` board name). */
export const AUTOMATION_BENCHMARK = "automationbench";

const BY_DOMAIN: Record<string, string[]> = {
  sales: [
    "zoom_meeting_followup",
    "email_zoom_fuzzy",
    "calendly_reschedule_chain",
    "advance_opportunity_stage",
  ],
  marketing: [
    "content_localization",
    "social_comment_response_queue",
    "customer_milestone",
    "partner_commission_calculation",
  ],
  operations: [
    "chemical_inventory_safety_audit",
    "asana_slack_sheets_audit",
    "linkedin_abm_outreach",
    "notion_gmail_checklist_update",
  ],
  support: [
    "helpscout_reamaze_migration",
    "hiver_coaching_pipeline",
    "helpcrunch_trial_nurture",
    "zendesk_weekend_handoff",
  ],
  finance: [
    "payment_fraud_detection",
    "qb_bill_payment_batch",
    "sales_tax_remittance",
    "timesheet_to_invoice",
  ],
  hr: [
    "airtable_skills_matrix",
    "docusign_offer_letters",
    "visa_expiry_tracking",
    "mandatory_meeting_compliance",
  ],
};

/**
 * The fixed task list (24 tasks, 4 per domain), interleaved across domains so
 * that the first N always spread over the domains: the first 6 are one per
 * domain (the smoke size), the first 24 are all of them.
 */
export const AUTOMATION_TASKS: readonly string[] = (() => {
  const domains = Object.keys(BY_DOMAIN);
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    for (const d of domains) out.push(`${d}.${BY_DOMAIN[d]![i]}`);
  }
  return out;
})();

/** One `auto-bench --export-json` file (the subset this adapter reads). */
export interface AutomationExport {
  meta?: {
    timestamp?: string;
    model?: string;
    toolset?: string;
    duration_seconds?: number | null;
    benchmark_version?: string;
    reasoning_effort?: string | null;
    max_steps?: number;
  };
  summary?: { aborted_tasks?: string[] };
  tasks?: Array<{
    name?: string;
    score?: number;
    passed?: boolean;
    cost?: number | null;
    num_model_calls?: number;
    model_time_s?: number;
    tool_time_s?: number;
    /** Everything else (transcript, end state, assertion results) is never read. */
    [field: string]: unknown;
  }>;
}

/** An export as read from disk: its path and content, or why it could not be read. */
export interface ExportInput {
  path: string;
  data?: AutomationExport;
  error?: string;
}

export interface AutomationConversion {
  file: HarnessResultFile;
  /** Human-readable infrastructure failures (missing export, aborted task …). */
  infrastructure: string[];
}

/**
 * Convert exports into the harness result shape `benchmark:import` reads.
 * `expect` (task names) makes a task with no exported result an infrastructure
 * failure too.
 */
export function automationToHarness(
  exports: readonly ExportInput[],
  opts: { expect?: readonly string[]; model?: string; stack?: string } = {},
): AutomationConversion {
  const infrastructure: string[] = [];
  const items: NonNullable<HarnessResultFile["items"]> = [];
  const seen = new Set<string>();
  let model = opts.model;
  let version: string | undefined;
  let effort: string | undefined;
  let toolset: string | undefined;
  let durationMs = 0;
  let earliest: number | undefined;
  for (const ex of exports) {
    if (!ex.data) {
      infrastructure.push(`${ex.path}: ${ex.error ?? "no export"}`);
      continue;
    }
    const meta = ex.data.meta ?? {};
    model ??= meta.model;
    version ??= meta.benchmark_version;
    effort ??= meta.reasoning_effort ?? undefined;
    toolset ??= meta.toolset;
    const ts = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
    if (Number.isFinite(ts)) earliest = Math.min(earliest ?? ts, ts);
    const aborted = new Set(ex.data.summary?.aborted_tasks ?? []);
    const tasks = (ex.data.tasks ?? []).filter((t) => typeof t.name === "string" && t.name);
    if (tasks.length === 0) infrastructure.push(`${ex.path}: no task results`);
    // One task per export: its wall time is the task's latency.
    const fileMs =
      typeof meta.duration_seconds === "number" && tasks.length === 1
        ? Math.round(meta.duration_seconds * 1000)
        : undefined;
    if (typeof meta.duration_seconds === "number") durationMs += meta.duration_seconds * 1000;
    for (const t of tasks) {
      const name = t.name as string;
      if (seen.has(name)) {
        infrastructure.push(`${name}: exported more than once`);
        continue;
      }
      seen.add(name);
      const reason = aborted.has(name)
        ? "aborted (cut off mid-work)"
        : t.num_model_calls === 0
          ? "no model call completed"
          : undefined;
      if (reason) infrastructure.push(`${name}: ${reason}`);
      const timed =
        fileMs ??
        (typeof t.model_time_s === "number" || typeof t.tool_time_s === "number"
          ? Math.round(((t.model_time_s ?? 0) + (t.tool_time_s ?? 0)) * 1000)
          : undefined);
      items.push({
        id: name,
        correct: t.passed === true,
        ...(typeof t.score === "number" ? { score: t.score } : {}),
        ...(timed !== undefined ? { latencyMs: timed } : {}),
        ...(typeof t.cost === "number" ? { usage: { costUsd: t.cost } } : {}),
        ...(reason ? { fallback: true } : {}),
      });
    }
  }
  for (const name of opts.expect ?? []) {
    if (!seen.has(name)) infrastructure.push(`${name}: no result`);
  }
  return {
    file: {
      config: {
        dataset: AUTOMATION_BENCHMARK,
        model: model ?? "unknown",
        lessons_mode: "measure",
        judge: { model: "AutomationBench assertions (official)" },
        ...(version ? { automationbenchVersion: version } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(toolset ? { toolset } : {}),
        ...(opts.stack ? { stack: opts.stack } : {}),
        infrastructureErrors: infrastructure.length,
      },
      timestamp: earliest ?? Date.now(),
      duration_ms: Math.round(durationMs),
      items,
    },
    infrastructure,
  };
}
