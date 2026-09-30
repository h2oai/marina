// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { formatPerception } from "../src/net/formatter";
import type { Perception } from "../src/sdk/client";

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
    default:
      return undefined;
  }
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
export function formatCodePerception(p: Perception): string {
  const text = formatPerception(p, "plaintext");
  if (!text) return "";
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
    ["diff", "patch", "verification"].includes(code?.type ?? "") ||
    code?.event === "task_run_review";
  const details = evidence
    ? [
        ...(code?.sessionId
          ? [
              `Session: ${terminalText(code.sessionId).replace(/\s+/g, " ")}${code.metadata?.runId ? ` · Attempt: ${terminalText(code.metadata.runId).replace(/\s+/g, " ")}` : ""}`,
            ]
          : []),
        ...(Array.isArray(code?.commands) ? code.commands : [])
          .filter((command): command is string => typeof command === "string")
          .slice(0, 4)
          .map((command) => `  /world ${terminalText(command).replace(/\s+/g, " ").slice(0, 240)}`),
      ].join("\n")
    : "";
  return terminalText(`${label ? `[${label}] ` : ""}${text}${details ? `\n${details}` : ""}`);
}
