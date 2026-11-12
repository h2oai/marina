// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// What a coding agent is doing, in words a person reads: one line per action
// ("Read paginate.js", "Edit paginate.js", "Run bun test"), and for a change
// the change itself, as a small diff built from the call's own arguments.
// Bookkeeping (status reads, artifact lookups, memory) is marked quiet: a
// person's view leaves it out, a verbose view can still show it.

export type ActivityKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "patch"
  | "run"
  | "verify"
  | "plan"
  | "summary"
  | "other";

export interface CodingActivity {
  kind: ActivityKind;
  /** One line, plain words: "Edit paginate.js". */
  label: string;
  /** The file the action touches, when it names one. */
  path?: string;
  /** For a change: unified-diff body lines (`-old` / `+new` / ` context`), capped. */
  diff?: string[];
  /** Lines the diff left out past its cap. */
  more?: number;
  /** Bookkeeping a person does not need to watch. */
  quiet?: boolean;
}

/** Lines of a change shown inline; the full change is in the session diff. */
export const ACTIVITY_DIFF_LINES = 12;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function clip(value: string, max = 72): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function capped(lines: string[]): Pick<CodingActivity, "diff" | "more"> {
  if (lines.length <= ACTIVITY_DIFF_LINES) return { diff: lines };
  return { diff: lines.slice(0, ACTIVITY_DIFF_LINES), more: lines.length - ACTIVITY_DIFF_LINES };
}

/** A replacement as diff lines: the removed text, then the added text. */
export function replacementDiff(oldText: string, newText: string): string[] {
  const split = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const before = split(oldText);
  const after = split(newText);
  // Lines both sides share at the edges are context, not change.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return [
    ...before.slice(Math.max(0, head - 1), head).map((l) => ` ${l}`),
    ...before.slice(head, before.length - tail).map((l) => `-${l}`),
    ...after.slice(head, after.length - tail).map((l) => `+${l}`),
    ...before.slice(before.length - tail, before.length - tail + 1).map((l) => ` ${l}`),
  ];
}

/** The body lines of a unified diff (headers dropped, hunk markers kept). */
function patchBody(diff: string): string[] {
  return diff
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^(diff --git |index |--- |\+\+\+ )/.test(l) && l !== "");
}

/** Describe one coding tool call for a person. Unknown tools get their own name. */
export function describeCodingCall(
  toolName: string,
  args: Record<string, unknown>,
): CodingActivity {
  const typed = toolName.replace(/^marina_(code_)?/, "");
  const action = toolName === "marina_code" ? (str(args.action) ?? "") : typed;
  const path = str(args.path);
  const target = path ?? "";
  switch (action) {
    case "read":
    case "read_file":
      return { kind: "read", label: `Read ${target || "a file"}`, ...(path ? { path } : {}) };
    case "files":
    case "list_files":
      return { kind: "read", label: path ? `List ${path}` : "List files", quiet: !path };
    case "search":
      return { kind: "search", label: `Search for "${clip(str(args.query) ?? "", 48)}"` };
    case "edit": {
      const diff = replacementDiff(str(args.oldText) ?? "", String(args.newText ?? ""));
      return { kind: "edit", label: `Edit ${target}`, ...(path ? { path } : {}), ...capped(diff) };
    }
    case "write": {
      const content = String(args.content ?? "");
      const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
      return {
        kind: "write",
        label: `Write ${target} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
        ...(path ? { path } : {}),
        ...capped(lines.map((l) => `+${l}`)),
      };
    }
    case "patch": {
      const body = patchBody(str(args.diff) ?? "");
      const title = str(args.title);
      return {
        kind: "patch",
        label: `Propose a patch${title ? `: ${clip(title, 60)}` : ""}`,
        ...capped(body),
      };
    }
    case "apply":
    case "apply_patch":
      return { kind: "patch", label: "Apply the patch" };
    case "reject":
    case "reject_patch":
      return { kind: "patch", label: "Discard the patch" };
    case "run": {
      const command = str(args.command);
      return { kind: "run", label: command ? `Run ${clip(command, 64)}` : "Run a command" };
    }
    case "verify":
      return { kind: "verify", label: "Run checks on a snapshot of the change" };
    case "plan":
      return { kind: "plan", label: "Write a plan" };
    case "summary":
      return { kind: "summary", label: "Write the summary" };
    case "blocked":
      return { kind: "other", label: "Report a blocker" };
    case "observe":
      return { kind: "other", label: "Note an observation", quiet: true };
    case "diff":
      return { kind: "read", label: "Review the changes so far" };
    default:
      // Session status, artifacts, history, show, memory and the like: bookkeeping.
      return {
        kind: "other",
        label: action
          ? action.replace(/_/g, " ")
          : toolName.replace(/^marina_/, "").replace(/_/g, " "),
        quiet: true,
      };
  }
}

/** What a person calls the session's coding agent: a spawned `code_coder_<session>` is "Coder". */
export function coderDisplayName(agentName: string): string {
  return /^code_coder_/i.test(agentName) ? "Coder" : agentName;
}
