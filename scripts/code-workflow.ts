// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Terminal adapters to existing server operations. No local task/evidence authority. */
export const WORKFLOW_CONTROLS = [
  {
    name: "/project",
    usage: "/project",
    help: "Inspect workspace, model, instructions and check recipe",
  },
  { name: "/status", usage: "/status", help: "Show the current Marina session and task" },
  { name: "/diff", usage: "/diff", help: "Inspect the current Marina workspace diff" },
  {
    name: "/verify",
    usage: "/verify [candidate|live]",
    help: "Start snapshot checks (default) or live checks",
  },
  {
    name: "/checks",
    usage: "/checks",
    help: "List recorded checks; /status shows checks in progress",
  },
  { name: "/history", usage: "/history", help: "List recent task attempts in this session" },
  {
    name: "/show",
    usage: "/show <artifact-id>",
    help: "Read a recorded summary, check, candidate or attempt",
  },
  {
    name: "/review",
    usage: "/review [attempt-id]",
    help: "Inspect an attempt and freshly assess its evidence",
  },
] as const;

const REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REVIEW_ACTIONS = ["approve", "reject", "accept-unverified"];

function reference(value: string | undefined): value is string {
  return !!value && REFERENCE.test(value) && !["last", ...REVIEW_ACTIONS].includes(value);
}

/** Explicit IDs for mutations; never infer a reviewed attempt from a streaming event. */
export function workflowCommand(verb: string, argument: string): string | undefined {
  const control = WORKFLOW_CONTROLS.find((entry) => entry.name === verb);
  if (!control) return undefined;
  const words = argument.split(/\s+/).filter(Boolean);
  switch (verb) {
    case "/show":
      if (words.length === 1 && reference(words[0])) return `code show ${words[0]}`;
      break;
    case "/review":
      if (!argument) return "code review";
      if (words.length === 1 && reference(words[0])) return `code review ${words[0]}`;
      if (words.length === 2 && ["approve", "reject"].includes(words[0]!) && reference(words[1]))
        return `code review ${words.join(" ")}`;
      throw new Error(
        "Usage: /review [attempt-id] or /review approve|reject <attempt-id>. Decisions require an explicit attempt ID. Unverified acceptance remains /world code review accept-unverified <attempt-id> <reason>.",
      );
    case "/verify":
      if (!argument || argument === "candidate") return "code verify candidate";
      if (argument === "live") return "code verify start";
      if (["dependencies:bun", "candidate dependencies:bun"].includes(words.join(" ")))
        return "code verify candidate dependencies:bun";
      throw new Error(
        "Usage: /verify [candidate|live], or /verify candidate dependencies:bun for explicit frozen dependency preparation. No dependencies are installed by default.",
      );
    default:
      if (!argument) {
        const commands: Record<string, string> = {
          "/project": "code doctor",
          "/status": "code status",
          "/diff": "code diff",
          "/checks": "code artifacts kind verification",
          "/history": "code artifacts kind task_run",
        };
        return commands[verb];
      }
  }
  throw new Error(`Usage: ${control.usage}`);
}

export const WORKFLOW_COMPLETIONS = [
  "/verify candidate",
  "/verify live",
  "/verify candidate dependencies:bun",
  "/review approve",
  "/review reject",
];

/** Translate only exact known suggestions; rendered text never dispatches a command. */
export function workflowShortcut(command: string): string | undefined {
  const fixed: Record<string, string> = {
    "code doctor": "/project",
    "code status": "/status",
    "code diff": "/diff",
    "code review": "/review",
    "code artifacts kind verification": "/checks",
    "code artifacts kind task_run": "/history",
    "code verify candidate": "/verify",
  };
  if (fixed[command]) return fixed[command];
  const match = /^code (show|review) (.+)$/.exec(command);
  if (!match) return undefined;
  try {
    const shortcut = `/${match[1]} ${match[2]}`;
    return workflowCommand(`/${match[1]}`, match[2]!) === command ? shortcut : undefined;
  } catch {
    return undefined;
  }
}
