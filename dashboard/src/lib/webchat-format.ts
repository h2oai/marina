// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const ANSI_COLORS: Record<string, string> = {
  "30": "#4d4d4d",
  "31": "#f44",
  "32": "#4e4",
  "33": "#fd0",
  "34": "#69f",
  "35": "#f6f",
  "36": "#0ff",
  "37": "#d4d4d4",
  "90": "#888",
  "91": "#f66",
  "92": "#8f8",
  "93": "#ff5",
  "94": "#8af",
  "95": "#f8f",
  "96": "#5ff",
  "97": "#fff",
};

export function escHtml(ch: string): string {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === '"') return "&quot;";
  return ch;
}

export function escapeHtml(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += escHtml(text[i]!);
  }
  return result;
}

export function ansiToHtml(text: string): string {
  let result = "";
  let i = 0;
  let openSpans = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        result += escHtml(text[i]!);
        i++;
        continue;
      }
      const codes = text.substring(i + 2, end).split(";");
      i = end + 1;
      const styles: string[] = [];
      for (const code of codes) {
        if (code === "0" || code === "") {
          while (openSpans > 0) {
            result += "</span>";
            openSpans--;
          }
        } else if (code === "1") {
          styles.push("font-weight:bold");
        } else if (code === "3") {
          styles.push("font-style:italic");
        } else if (code === "4") {
          styles.push("text-decoration:underline");
        } else if (ANSI_COLORS[code]) {
          styles.push(`color:${ANSI_COLORS[code]}`);
        }
      }
      if (styles.length > 0) {
        result += `<span style="${styles.join(";")}">`;
        openSpans++;
      }
    } else {
      result += escHtml(text[i]!);
      i++;
    }
  }
  while (openSpans > 0) {
    result += "</span>";
    openSpans--;
  }
  return result;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI SGR codes so copied text is clean
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function codeStatusTone(status?: string): string {
  if (!status) return "border-border/70 bg-bg/45 text-text";
  if (["failed", "denied", "rejected"].includes(status)) {
    return "border-red-500/40 bg-red-950/15 text-red-200";
  }
  if (["pending", "warn", "planned"].includes(status)) {
    return "border-yellow-500/40 bg-yellow-950/15 text-yellow-100";
  }
  if (["applied", "complete", "completed", "ok", "passed", "pinned"].includes(status)) {
    return "border-emerald-500/30 bg-emerald-950/10 text-emerald-100";
  }
  return "border-border/70 bg-bg/45 text-text";
}

export function diffStats(
  content: string,
): { additions: number; deletions: number; files: number } | null {
  if (!content.startsWith("diff --git")) return null;
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions, files };
}

/** Parse a metadata blob that may arrive as a JSON string or an already-parsed
 * object (events vs. artifact rows differ). Never throws. */
export function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Approve/deny status badge classes. pending=amber, approved=emerald, denied/rejected=red. */
export function approvalBadgeTone(status?: string): string {
  const s = (status ?? "").toLowerCase();
  if (s === "approved" || s === "applied")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (s === "denied" || s === "rejected" || s === "failed")
    return "border-red-500/40 bg-red-500/15 text-red-300";
  return "border-yellow-500/40 bg-yellow-500/15 text-yellow-200";
}

/** Crew member rows arrive as [{ agentName, role, source }]; tolerate partial/loose shapes. */
export function parseCrewMembers(
  value: unknown,
): { agentName: string; role?: string; source?: "recruited" | "spawned" }[] {
  if (!Array.isArray(value)) return [];
  const members: { agentName: string; role?: string; source?: "recruited" | "spawned" }[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const agentName =
      typeof m.agentName === "string"
        ? m.agentName
        : typeof m.name === "string"
          ? m.name
          : typeof m.agent === "string"
            ? m.agent
            : undefined;
    if (!agentName) continue;
    const source = m.source === "recruited" || m.source === "spawned" ? m.source : undefined;
    members.push({
      agentName,
      role: typeof m.role === "string" ? m.role : undefined,
      source,
    });
  }
  return members;
}

export interface RoomPerceptionData {
  name?: string;
  short?: string;
  long?: string;
  items?: Record<string, unknown>;
  entities?: { name?: string; short?: string }[];
  exits?: string[];
}

export interface CodeTreeNode {
  active?: boolean;
  children?: CodeTreeNode[];
  id?: string;
  status?: string;
  title?: string;
}

export interface CodeMessageData {
  appliedAt?: number | null;
  appliedBy?: string | null;
  artifactId?: string;
  artifactKind?: string;
  createdBy?: string;
  metadata?: Record<string, unknown> | string | null;
  checks?: {
    detail?: string;
    label?: string;
    status?: "fail" | "info" | "ok" | "warn";
  }[];
  command?: string[];
  commands?: string[];
  content?: string;
  durationMs?: number;
  event?: string;
  events?: {
    actor?: string;
    kind?: string;
    payload?: string;
    timestamp?: number;
  }[];
  exitCode?: number;
  modelTarget?: string;
  parentSessionId?: string;
  phase?: string;
  paths?: string[];
  query?: string;
  rows?: {
    action?: string;
    canonical?: string;
    detail?: string;
    grade?: string;
    id?: string;
    kind?: string;
    line?: number;
    portability?: string;
    path?: string;
    size?: number;
    status?: string;
    text?: string;
    title?: string;
    type?: string;
  }[];
  sessionId?: string;
  status?: string;
  timedOut?: boolean;
  title?: string;
  tree?: CodeTreeNode[];
  truncated?: boolean;
  type?:
    | "approval"
    | "artifact"
    | "command"
    | "crew"
    | "diff"
    | "file"
    | "history"
    | "list"
    | "lifecycle"
    | "model"
    | "note"
    | "patch"
    | "profile"
    | "readiness"
    | "search"
    | "session"
    | "skill"
    | "tree"
    | "verification";
  workspace?: string;
}

export interface CodeContextData {
  assignedAgent?: string;
  latestArtifactId?: string;
  latestArtifactKind?: string;
  latestArtifactLifecycle?: string;
  latestArtifactStatus?: string;
  modelTarget?: string;
  pendingPatches?: number;
  profile?: string;
  sessionId?: string;
  sessionMode?: string;
  sessionStatus?: string;
  sessionTitle?: string;
  workspace?: string;
  writer?: string;
}

/** Plain-text for clipboard: prefer the stored text, else derive it from html. */
export function messageText(m: { text?: string; html: string }): string {
  if (m.text != null) return m.text;
  const el = document.createElement("div");
  el.innerHTML = m.html;
  return el.textContent ?? "";
}

/** Best-effort clipboard write — clipboard API first, textarea+execCommand on
 * insecure contexts (http://…) where navigator.clipboard is unavailable. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
