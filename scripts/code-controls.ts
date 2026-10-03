// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { WORKFLOW_CONTROLS } from "./code-workflow";

/** Explicit world input is independent of a coding task or pending approval answer. */
export function isWorldInput(text: string): boolean {
  return /^\/world(?:\s|$)/.test(text.trimStart());
}

/** Local terminal controls only; world commands still use the server capability manifest. */
export const TERMINAL_CONTROLS = [
  { name: "/help", usage: "/help", help: "Show terminal controls and keyboard shortcuts" },
  {
    name: "/view",
    usage: "/view coding|world|approvals|panel|older|newer",
    help: "Switch conversation or read local history",
  },
  {
    name: "/task",
    usage: "/task <request>",
    help: "Work toward candidate verification before review",
  },
  {
    name: "/panel",
    usage: "/panel desk|publish|list|open|views|use|resources|refresh|field|act|confirm|close",
    help: "Inspect and use published panels beside coding and world conversations",
  },
  ...WORKFLOW_CONTROLS,
  { name: "/agents", usage: "/agents", help: "Show agents, status and workspace" },
  {
    name: "/spawn",
    usage: "/spawn claude|codex|pi [name]",
    help: "Add a native agent in an isolated Git worktree",
  },
  { name: "/use", usage: "/use marina|claude|codex|pi|name", help: "Select an agent" },
  { name: "/stop", usage: "/stop", help: "Interrupt the selected agent" },
  { name: "/dashboard", usage: "/dashboard", help: "Open the dashboard" },
  {
    name: "/world",
    usage: "/world <command>",
    help: "Send a Marina world command without leaving this view",
  },
  {
    name: "/harness",
    usage: "/harness [save|use|list|export]",
    help: "Inspect or select runtime, model and dialect",
  },
  { name: "/quit", usage: "/quit", help: "Exit; connected worlds keep running, owned agents stop" },
];
export const TERMINAL_COMMANDS = TERMINAL_CONTROLS.map((control) => control.name);

export function terminalControls(connected = false) {
  return TERMINAL_CONTROLS.filter((control) => !connected || control.name !== "/spawn").map(
    (control) => {
      if (connected && control.name === "/use")
        return { ...control, usage: "/use marina", help: "Select the server-side coding agent" };
      if (connected && control.name === "/quit")
        return { ...control, help: "Detach; world agents and tasks keep running" };
      return control;
    },
  );
}

export function terminalHelp(connected = false): string {
  return `Type a task to work with the selected agent. End a line with \\ for multiple lines.
${terminalControls(connected)
  .map((control) => `${control.usage.padEnd(39)} ${control.help}`)
  .join("\n")}
/review approve|reject <id>              Decide an explicit submitted attempt (server rechecks)
/verify candidate dependencies:bun      Explicitly prepare locked Bun dependencies in the snapshot
/harness save <name>                    Remember this harness for future launches here
/harness use <name-or-path>              Load a saved or explicitly supplied JSON harness
/panel list                             List canvases; /panel list <canvas> lists publications
/panel desk [session]                    Open a personal desk (defaults to selected Marina session)
/panel publish <canvas> [session]        Publish and open a shared coding desk
/panel views | use <number>              Switch local views; drafts and reviews stay independent
/panel resources [filter]                Discover data sources for coded panel compositions
/panel open <canvas> <node>              Open an existing publication; /panel close closes only its view
F6 switches coding/world; F7 opens pending requests; F8 focuses the published panel. Switching preserves each draft.
Tab completes terminal commands. Ctrl+C interrupts active work; again exits.
Workspace (--tui): type / for suggestions. Tab or Enter inserts; another Enter sends.
F1 opens this help; PageUp/PageDown scroll; Alt+Up/Down reads older/newer retained pages.
In the panel, Tab/Shift+Tab selects controls; type to edit; Space toggles a checkbox.
Enter on a button opens review, initially on Cancel. Select Confirm to submit; Escape cancels.
Ctrl+D exits an empty composer. Omit --tui for ordinary terminal scrollback.
Use /world during a launch or approval prompt to keep participating; the approval stays pending.
${connected ? "" : "Native agents retain their own tools and permission rules. Additional worktrees start at committed HEAD."}`;
}

export const TERMINAL_HELP = terminalHelp();
