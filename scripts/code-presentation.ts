// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { diffStat } from "../src/coding/unified-diff";
import { formatPerception } from "../src/net/formatter";
import type { Perception } from "../src/sdk/client";
import { type DiffPayload, diffPayloadFor, renderDiff } from "./code-diff";
import type { EntryFormat } from "./code-views";
import { workflowShortcut } from "./code-workflow";

/** "diff" when a perception carries structured diff content the terminal renders itself;
 *  "activity" for one agent action (and its change) from the coding stream. */
export function codePerceptionFormat(p: Perception): EntryFormat | undefined {
  const code = p.data?.code;
  if (!code || typeof code !== "object") return undefined;
  const c = code as Record<string, unknown>;
  if (c.event === "agent_output" && (c.metadata as { kind?: unknown } | undefined)?.kind === "tool")
    return "activity";
  return diffPayloadFor(c) ? "diff" : undefined;
}

/** One action from the coding stream (`src/engine/commands/code/activity.ts`), as sent. */
interface StreamActivity {
  label?: unknown;
  diff?: unknown;
  more?: unknown;
  quiet?: unknown;
}

/** The action line and its change, or "" for bookkeeping a person need not watch. */
function activityText(activity: StreamActivity | undefined): string {
  if (!activity || activity.quiet === true || typeof activity.label !== "string") return "";
  const diff = Array.isArray(activity.diff)
    ? activity.diff.filter((l): l is string => typeof l === "string")
    : [];
  const more = typeof activity.more === "number" && activity.more > 0 ? activity.more : 0;
  return [
    activity.label,
    ...diff,
    ...(more ? [`… ${more} more line${more === 1 ? "" : "s"} (/diff shows the whole change)`] : []),
  ].join("\n");
}

/** The server's `[code]` channel tag and a `Name:` speaker prefix, which the view replaces. */
function bodyOf(served: string): string {
  return served.replace(/^\[code\] ?/, "");
}

function diffHeading(served: string): string {
  const lines: string[] = [];
  for (const line of served.split("\n")) {
    if (/^─{8,}$/.test(line.trim()) || /^(diff --git |--- |@@ )/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trimEnd() || (served.split("\n", 1)[0] ?? "");
}

/** Native tool output is data, never terminal instructions (OSC links/clipboard, cursor escapes). */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal control bytes.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

/** Labels reflect the server's declared readiness, never command exit prose. */
export function verificationReadinessLabel(value: unknown): string | undefined {
  switch (value) {
    case "required":
      return "verification required";
    case "running":
      return "checks running";
    case "ready":
      return "ready for review";
    case "needs-attention":
      return "checks need attention";
    case "not-run":
      return "checks not run";
    default:
      return undefined;
  }
}

export function codingSessionPhase(meta: {
  runStatus?: string;
  reviewStatus?: string;
  acceptedUnverified?: boolean;
  reason?: string;
}): string {
  if (meta.runStatus === "active") return "working";
  if (meta.runStatus === "submitted") {
    if (meta.reviewStatus === "approved")
      return meta.acceptedUnverified ? "accepted unverified" : "approved";
    if (meta.reviewStatus === "rejected") return "rejected";
    return "submitted for review";
  }
  if (meta.runStatus === "interrupted" || meta.runStatus === "failed")
    return meta.reason === "blocked" ? "blocked" : "stopped";
  if (["approved", "rejected", "cancelled"].includes(meta.runStatus ?? "")) return meta.runStatus!;
  return "ready";
}

export function workerActivityLabel(meta: {
  workerState?: string;
  workerReason?: string;
  workerPauseKind?: string;
}): string | undefined {
  let label: string;
  switch (meta.workerState) {
    case "paused":
      label =
        meta.workerPauseKind === "budget"
          ? "paused · model budget"
          : meta.workerPauseKind === "spend-cap"
            ? "paused · spend cap"
            : meta.workerPauseKind === "upstream-errors"
              ? "paused · upstream errors"
              : "paused";
      break;
    case "waiting":
      label = "worker waiting";
      break;
    case "recovering":
      label = "worker recovering";
      break;
    case "unavailable":
      label = "worker unavailable";
      break;
    case "stopped":
      label = "worker stopped";
      break;
    case "unknown":
      label = "worker status unknown";
      break;
    default:
      return undefined;
  }
  const reason =
    typeof meta.workerReason === "string"
      ? terminalText(meta.workerReason).replace(/\s+/g, " ").slice(0, 180)
      : "";
  return reason ? `${label} · ${reason}` : label;
}

/** Transcript categories add orientation without interpreting prose as authorization or success. */
export function formatCodePerception(p: Perception, selectedSessionId?: string): string {
  const served = formatPerception(p, "plaintext");
  if (!served) return "";
  const diff = diffPayloadFor(
    p.data?.code && typeof p.data.code === "object"
      ? (p.data.code as Record<string, unknown>)
      : undefined,
  );
  // Diffs render from structured content: stat first, hunks, and an explicit
  // truncation note. The server's summary lines (before its separator or the
  // first diff header) stay as the heading.
  const text = diff ? `${diffHeading(served)}\n${renderDiff(diff)}` : served;
  const code = p.data?.code as
    | {
        event?: string;
        phase?: string;
        status?: string;
        type?: string;
        commands?: unknown[];
        sessionId?: string;
        artifactId?: string;
        verificationReadiness?: string;
        metadata?: {
          verificationReadiness?: string;
          reason?: string;
          runId?: string;
          workerState?: string;
          workerReason?: string;
          workerPauseKind?: string;
        };
      }
    | undefined;
  const readiness = verificationReadinessLabel(
    code?.metadata?.verificationReadiness ?? code?.verificationReadiness,
  );
  // ── What a person watches (structure decides; prose is shown, never parsed) ──
  const meta = (code?.metadata ?? {}) as Record<string, unknown>;
  if (code?.event === "agent_output") {
    if (meta.kind === "tool") return terminalText(activityText(meta.activity as StreamActivity));
    if (meta.kind === "prose") {
      // "Coder: …" — the speaker becomes the entry's label.
      const prose = bodyOf(served).match(/^([^:\n]{1,40}): ([\s\S]*)$/);
      return terminalText(prose ? `[${prose[1]}] ${prose[2]}` : bodyOf(served));
    }
    if (meta.kind === "tool_error") return terminalText(`[step failed] ${bodyOf(served).trim()}`);
  }
  // Phases ride the live status line; the end of a run is the console's result block.
  if (code?.event === "code_lifecycle") return "";
  if (code?.event === "worker_state_changed" && code.metadata?.workerState === "working") return "";
  if (code?.event === "verification_started" || code?.event === "verification_required") return "";
  // Only the run's structured verdict says passed or failed; anything else keeps its
  // labelled receipt below (never read "passed" from prose).
  if (code?.event === "verification_finished" || code?.event === "verification_ran") {
    const reason = typeof meta.verificationReason === "string" ? meta.verificationReason : "";
    if (meta.verification === "passed")
      return terminalText("[checks passed] on a snapshot of the change");
    if (meta.verification === "failed")
      return terminalText(`[checks failed]${reason ? ` ${reason}` : ""}`);
  }
  let label: string | undefined;
  if (p.kind === "error" || p.kind === "auth_error") label = "error";
  else if (p.data?.execApproval) label = "approval requested";
  else if (code?.event === "verification_required") label = readiness ?? "verification required";
  else if (code?.event === "verification_started") label = readiness ?? "checks · running";
  else if (code?.event === "verification_finished")
    label = `checks · receipt${readiness ? ` · ${readiness}` : ""}`;
  else if (code?.event === "verification_ran")
    label = `checks · result${readiness ? ` · ${readiness}` : ""}`;
  else if (code?.event === "worker_state_changed")
    label = `worker · ${workerActivityLabel(code.metadata ?? {}) ?? (code.metadata?.workerState === "working" ? "working" : "status unknown")}`;
  else if (code?.event === "session_status")
    label = workerActivityLabel(code.metadata ?? {}) ?? readiness;
  else if (code?.event === "task_run_review") label = "review";
  else if (code?.event === "doctor_ran") label = "project · inspection only";
  else if (code?.type === "diff") label = "diff · working changes";
  else if (code?.type === "patch") label = "patch";
  else if (code?.event === "code_lifecycle") {
    label =
      code.status === "submitted"
        ? "task · submitted for review"
        : code.metadata?.reason === "blocked"
          ? "task · blocked"
          : "task";
  } else if (
    !code &&
    !p.command_request_id &&
    (p.kind === "movement" ||
      ["tell", "say", "shout", "broadcast", "connect", "disconnect"].includes(p.tag ?? ""))
  )
    label = "world";
  // Ids and inspect commands belong to what the person asked for, and to a review
  // (the one event a person acts on); a stream notice stays one readable line.
  const evidence =
    code?.event === "task_run_review" ||
    (!!p.command_request_id &&
      ["diff", "patch", "verification", "artifact", "readiness", "list"].includes(
        code?.type ?? "",
      ));
  const selected = !!selectedSessionId && code?.sessionId === selectedSessionId;
  const details = evidence
    ? [
        ...(code?.sessionId
          ? [
              `Session: ${terminalText(code.sessionId).replace(/\s+/g, " ")}${code.metadata?.runId ? ` · Attempt: ${terminalText(code.metadata.runId).replace(/\s+/g, " ")}` : ""}`,
            ]
          : []),
        ...(Array.isArray(code?.commands) ? code.commands : [])
          .filter((command): command is string => typeof command === "string")
          .slice(0, 6)
          .map((command) => {
            const safe = terminalText(command).replace(/\s+/g, " ").slice(0, 240);
            // Suggestions for another session must never appear to act on the
            // current selection. Do not infer actions from prose or sanitize an
            // invalid suggestion into a valid shortcut.
            if (code?.sessionId && selectedSessionId && !selected)
              return `  In session ${terminalText(code.sessionId)}: ${safe}`;
            return `  ${selected && safe === command ? (workflowShortcut(command) ?? `/world ${safe}`) : `/world ${safe}`}`;
          }),
      ].join("\n")
    : "";
  const guidance =
    code?.event === "task_run_review" && selected
      ? "\nReview decisions require the attempt ID above. Approval records the task decision; it does not commit or push files."
      : code?.event === "doctor_ran"
        ? "\nNext: /task <request> · /status · /checks · /review. Inspection runs no model or verification recipe."
        : "";
  return terminalText(
    `${label ? `[${label}] ` : ""}${bodyOf(text)}${details ? `\n${details}` : ""}${guidance}`,
  );
}

/** What the console knows when a run ends: the terminal event's fields and its own measurements. */
export interface RunResult {
  /** `submitted`, `failed`, `interrupted` … from the terminal event. */
  outcome?: string;
  reason?: string;
  detail?: string;
  verification?: string;
  verificationReason?: string;
  budgetForced?: boolean;
  /** The attempt a review decision names (explicit, never inferred later). */
  runId?: string;
  elapsedMs?: number;
  /** The coder's model spend over this run, when the world reports it. */
  costUsd?: number;
  /** The session diff after the run (`code diff`). */
  diff?: DiffPayload;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The end of a run, in one block a person reads top to bottom: how it ended, what
 * changed (the diff itself), whether independent checks passed, what it took, and
 * the exact next commands. Printed as a diff entry so the change is coloured.
 */
export function renderRunResult(r: RunResult): string {
  const submitted = r.outcome === "submitted" || r.outcome === "approved";
  const blocked = r.reason === "blocked";
  const stats = r.diff ? diffStat(r.diff.content) : [];
  const added = stats.reduce((n, f) => n + f.added, 0);
  const removed = stats.reduce((n, f) => n + f.removed, 0);
  const changed = stats.length
    ? `${stats.length} file${stats.length === 1 ? "" : "s"} changed (+${added} −${removed})`
    : "no file changes";
  const checks =
    r.verification === "passed"
      ? "checks passed"
      : r.verification === "failed"
        ? "checks failed"
        : r.verification
          ? `checks ${r.verification}`
          : "no checks recorded";
  const took = [
    r.elapsedMs !== undefined ? duration(r.elapsedMs) : "",
    r.costUsd !== undefined && r.costUsd > 0
      ? `$${r.costUsd.toFixed(r.costUsd < 0.1 ? 3 : 2)}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const head = submitted ? "Done" : blocked ? "Blocked" : "Stopped";
  const flat = (t: string) => terminalText(t).replace(/\s+/g, " ").slice(0, 300);
  const lines = [`──── ${head} · ${changed} · ${checks}${took ? ` · ${took}` : ""} ────`];
  if (!submitted) {
    const why = blocked ? r.detail?.replace(/^Blocked:\s*/, "") : (r.detail ?? r.reason);
    if (why) lines.push(`Why: ${flat(why)}`);
  }
  if (r.budgetForced) lines.push("Best effort: the run's budget ran out before it finished.");
  if (r.verification === "failed" && r.verificationReason)
    lines.push(`Checks: ${flat(r.verificationReason)}`);
  // The edits already showed inline as they happened: the result names the files, /diff
  // shows the whole change again.
  if (r.diff) lines.push("", renderDiff({ ...r.diff, mode: "stat" }));
  lines.push("");
  if (stats.length) {
    const files = stats.map((f) => f.path);
    lines.push("The change is in your files now.");
    lines.push("  /diff  see it again");
    if (submitted && r.runId) {
      lines.push(`  /review approve ${r.runId}  keep it and record your approval`);
      lines.push(`  /review reject ${r.runId}  record that it is not right`);
    }
    lines.push(
      `  undo it: git restore ${files.slice(0, 4).join(" ")}${files.length > 4 ? " …" : ""}`,
    );
  }
  lines.push(
    submitted ? "Type a follow-up to keep going." : "Type what to do next, or /status for details.",
  );
  return lines.join("\n");
}
