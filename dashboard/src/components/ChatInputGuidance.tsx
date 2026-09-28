// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useChatState } from "../hooks/use-chat-state";
import { useFeedState } from "../hooks/use-feed-state";
import { useWorldState } from "../hooks/use-world-state";
import { parseSpeech } from "../lib/perception";

interface CodingVerb {
  verb: string;
  hint: string;
  /** When true, the verb needs an argument: prompt for it before sending. */
  arg?: string;
}

// Canonical Code Mode verbs (MVP). The per-profile alias map lives server-side
// in the entity's `code_profile_aliases` property and is not exposed to the
// dashboard client, so we surface the canonical verbs that every profile maps
// onto — the profile prompt itself (claude>/codex>/pi>/code>) signals vocab.
const CODING_PALETTE_VERBS: CodingVerb[] = [
  { verb: "start", hint: "Start a coding session", arg: "title" },
  { verb: "files", hint: "List workspace files" },
  { verb: "read", hint: "Read a file", arg: "path" },
  { verb: "search", hint: "Search the workspace", arg: "query" },
  { verb: "diff", hint: "Review pending changes" },
  { verb: "run", hint: "Run a command", arg: "command" },
  { verb: "verify", hint: "Run verification checks" },
  { verb: "patch", hint: "Propose a patch", arg: "instruction" },
  { verb: "approve", hint: "Approve a pending artifact", arg: "id" },
  { verb: "deny", hint: "Deny a pending artifact", arg: "id" },
  { verb: "status", hint: "Show session status" },
  { verb: "exit", hint: "Leave Code Mode" },
];

export function CodingPalette({
  prompt,
  hasSession,
  onExecute,
}: {
  prompt: string;
  hasSession: boolean;
  onExecute: (command: string) => boolean;
}) {
  const run = (command: string) => {
    if (!onExecute(command)) {
      window.alert("Unable to send command — chat is not connected.");
    }
  };
  // In Code Mode the "code" prefix is omitted; commands are sent bare.
  return (
    <div className="border-t border-border px-2 py-1.5 text-[11px] text-text">
      <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
        <span>{prompt}&gt; palette</span>
        <span>{hasSession ? "session active" : "no session"}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {CODING_PALETTE_VERBS.map((entry) => (
          <button
            key={entry.verb}
            type="button"
            title={entry.hint}
            onClick={() => {
              if (entry.arg) {
                const value = window.prompt(`${entry.verb} — ${entry.hint}`, "");
                const trimmed = value?.trim();
                if (trimmed) run(`${entry.verb} ${trimmed}`);
              } else {
                run(entry.verb);
              }
            }}
            className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:border-primary hover:bg-primary/15"
          >
            {entry.verb}
            {entry.arg ? <span className="text-text-dim">…</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

interface CompassSuggestion {
  key: string;
  label: string;
  hint?: string;
  mode: "command" | "prompt";
  command: string;
}

export function ContextualCompass({ onExecute }: { onExecute: (command: string) => boolean }) {
  const loggedIn = useChatState((s) => s.loggedIn);
  const messages = useChatState((s) => s.messages);
  const feedEvents = useFeedState((s) => s.events);
  const thinkingAgents = useWorldState((s) => s.thinkingAgents);

  const suggestions = useMemo(() => {
    if (!loggedIn) return [] as CompassSuggestion[];
    const recentFeed = feedEvents.slice(0, 30);
    const map = new Map<string, CompassSuggestion>();

    const add = (suggestion: CompassSuggestion) => {
      if (!map.has(suggestion.key)) {
        map.set(suggestion.key, suggestion);
      }
    };

    add({
      key: "brief",
      label: "Brief",
      hint: "Compass snapshot of entities and tasks",
      mode: "command",
      command: "brief",
    });

    add({
      key: "readiness",
      label: "Readiness",
      hint: "Capability health check",
      mode: "command",
      command: "readiness",
    });

    const agentNames = Object.keys(thinkingAgents);
    if (agentNames.length > 0) {
      add({
        key: `status-${agentNames[0]}`,
        label: `Status: ${agentNames[0]}`,
        hint: "Inspect the active agent's loop",
        mode: "command",
        command: `agent status ${agentNames[0]}`,
      });
    }

    if (recentFeed.some((event) => /task/i.test(event.summary))) {
      add({
        key: "tasks",
        label: "Tasks",
        hint: "Review coordination pipeline",
        mode: "command",
        command: "task list",
      });
    }

    if (recentFeed.some((event) => /intent/i.test(event.summary))) {
      add({
        key: "intents",
        label: "Canvas intents",
        hint: "View open work requests",
        mode: "command",
        command: "canvas intent list",
      });
    }

    if (recentFeed.some((event) => /chronicle/i.test(event.summary))) {
      add({
        key: "chronicle",
        label: "Chronicle",
        hint: "Check pending narration",
        mode: "command",
        command: "chronicle pending",
      });
    }

    if (recentFeed.some((event) => event.kind?.startsWith("media_"))) {
      add({
        key: "media",
        label: "Media jobs",
        hint: "Review recent media generations",
        mode: "command",
        command: "media jobs",
      });
    }

    const lastOtherMessage = [...messages]
      .reverse()
      .map((m) => ({ meta: parseSpeech(m.text, m.tag, m.perception), raw: m }))
      .find((m) => m.meta && m.meta.perspective === "other");
    if (lastOtherMessage?.meta?.speaker) {
      add({
        key: "reply",
        label: `Reply to ${lastOtherMessage.meta.speaker}`,
        hint:
          lastOtherMessage.meta.body?.slice(0, 80) ?? `Respond to ${lastOtherMessage.meta.speaker}`,
        mode: "prompt",
        command: "say ",
      });
    }

    return Array.from(map.values());
  }, [feedEvents, loggedIn, messages, thinkingAgents]);

  if (!loggedIn || suggestions.length === 0) return null;

  const runCommand = (command: string) => {
    if (!onExecute(command)) {
      window.alert("Unable to send command — chat is not connected.");
    }
  };

  return (
    <div className="border-t border-border px-2 py-1.5 text-[11px] text-text">
      <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
        <span>Contextual compass</span>
        <span>{suggestions.length} suggestions</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.key}
            type="button"
            onClick={() => {
              if (suggestion.mode === "command") {
                runCommand(suggestion.command);
              } else {
                const reply = window.prompt(suggestion.hint ?? suggestion.label, "");
                const trimmed = reply?.trim();
                if (trimmed) {
                  runCommand(`${suggestion.command}${trimmed}`);
                }
              }
            }}
            className="rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-text hover:border-primary hover:text-primary transition-colors"
            title={suggestion.hint}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  );
}
