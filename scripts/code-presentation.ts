// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { formatPerception } from "../src/net/formatter";
import type { Perception } from "../src/sdk/client";
import { diffPayloadFor, renderDiff } from "./code-diff";
import type { EntryFormat } from "./code-views";
import { workflowShortcut } from "./code-workflow";

/** "diff" when a perception carries structured diff content the terminal renders itself. */
export function codePerceptionFormat(p: Perception): EntryFormat | undefined {
  const code = p.data?.code;
  return code && typeof code === "object" && diffPayloadFor(code as Record<string, unknown>)
    ? "diff"
    : undefined;
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
  const evidence =
    ["diff", "patch", "verification", "artifact", "readiness", "list"].includes(code?.type ?? "") ||
    code?.event === "task_run_review";
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
    `${label ? `[${label}] ` : ""}${text}${details ? `\n${details}` : ""}${guidance}`,
  );
}
