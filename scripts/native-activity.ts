// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A native agent's tool activity in the same plain words Marina's own coder
 * uses (`* Run …`, `* Edit …`; src/engine/commands/code/activity.ts). Each
 * runtime reports work differently — Codex app-server items, Claude SDK
 * `tool_use` blocks, pi tool events — and the terminal shows one step line per
 * action, never a bare protocol event name. Anything that says nothing to a
 * person (reasoning, message bookkeeping, a successful completion) is skipped;
 * the complete native payloads stay in Streams.
 */

import { isAbsolute, relative } from "node:path";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A path as a person reads it: relative to the workspace when inside it. */
function shown(path: string, cwd?: string): string {
  if (!cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** A shell wrapper (`/usr/bin/bash -lc '…'`, `sh -c "…"`) around the real command. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

function command(value: unknown): string | undefined {
  let text = Array.isArray(value) ? value.map(String).join(" ") : str(value);
  if (!text) return undefined;
  const wrapped = SHELL_WRAPPER.exec(text.trim());
  if (wrapped) text = wrapped[2]!;
  return clip(oneLine(text), 72);
}

/** One tool use by name and input — Claude Code's and pi's tool vocabularies. */
function toolStep(name: string, input: Rec, cwd?: string): string | undefined {
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  const at = path ? shown(path, cwd) : undefined;
  switch (name.toLowerCase()) {
    case "bash":
    case "shell": {
      const run = command(input.command);
      return run ? `Run ${run}` : "Run a command";
    }
    case "read":
      return at ? `Read ${at}` : "Read a file";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return at ? `Edit ${at}` : "Edit a file";
    case "write":
      return at ? `Write ${at}` : "Write a file";
    case "grep": {
      const pattern = str(input.pattern);
      return pattern ? `Search for "${clip(oneLine(pattern), 48)}"` : "Search";
    }
    case "glob":
    case "ls":
    case "find": {
      const pattern = str(input.pattern) ?? at;
      return pattern ? `List ${clip(pattern, 60)}` : "List files";
    }
    case "webfetch": {
      const url = str(input.url);
      return url ? `Fetch ${clip(url, 64)}` : "Fetch a page";
    }
    case "websearch": {
      const query = str(input.query);
      return query ? `Search the web for "${clip(oneLine(query), 48)}"` : "Search the web";
    }
    case "todowrite":
      return "Update the plan";
    case "task":
    case "agent":
      return "Start a subagent";
    default:
      return `Use ${name}`;
  }
}

/** Codex app-server `item/started` / `item/completed` items. */
function codexItem(method: string, item: Rec, cwd?: string): string | undefined {
  const type = str(item.type);
  if (method === "item/started") {
    if (type === "commandExecution") {
      const run = command(item.command);
      return run ? `Run ${run}` : "Run a command";
    }
    if (type === "fileChange") {
      const paths = (Array.isArray(item.changes) ? item.changes : [])
        .map((change) => str(rec(change).path))
        .filter((path): path is string => !!path)
        .map((path) => shown(path, cwd));
      return paths.length ? `Edit ${clip(paths.join(", "), 80)}` : "Edit files";
    }
    if (type === "mcpToolCall") {
      const tool = str(item.tool);
      return tool ? `Use ${tool}` : "Use a tool";
    }
    if (type === "webSearch") {
      const query = str(item.query);
      return query ? `Search the web for "${clip(oneLine(query), 48)}"` : "Search the web";
    }
    return undefined;
  }
  if (method === "item/completed" && type === "commandExecution") {
    const code = item.exitCode;
    if (typeof code === "number" && code !== 0) {
      const run = command(item.command);
      return `${run ? run : "The command"} exited ${code}`;
    }
  }
  return undefined;
}

/**
 * The step line for one native event, or undefined when it says nothing to a
 * person. `kind` is the routing event kind (`native.<runtime event>`).
 */
export function nativeActivityStep(
  kind: string,
  payload: unknown,
  cwd?: string,
): string | undefined {
  if (!kind.startsWith("native.")) return undefined;
  const event = kind.slice("native.".length);
  const body = rec(payload);
  // Codex app-server notifications.
  if (event === "item/started" || event === "item/completed")
    return codexItem(event, rec(body.item), cwd);
  // Claude Code SDK: tool uses arrive as `tool_use` blocks of an assistant message.
  if (event === "assistant") {
    const content = rec(body.message).content;
    const steps = (Array.isArray(content) ? content : [])
      .map(rec)
      .filter((block) => block.type === "tool_use" && typeof block.name === "string")
      .map((block) => toolStep(String(block.name), rec(block.input), cwd))
      .filter((step): step is string => !!step);
    return steps.length ? steps.join("\n") : undefined;
  }
  // pi RPC: a tool starts.
  if (event === "tool_execution_start") {
    const name = str(body.toolName);
    return name ? toolStep(name, rec(body.args), cwd) : undefined;
  }
  return undefined;
}

/**
 * Split streamed text into what is ready to show (whole lines) and what stays
 * buffered (the unfinished last line), so a sentence is never broken across
 * terminal lines by a flush timer. `final` releases everything.
 */
export function readyLines(buffer: string, final: boolean): { ready: string; rest: string } {
  if (final) return { ready: buffer, rest: "" };
  const cut = buffer.lastIndexOf("\n");
  if (cut < 0) return { ready: "", rest: buffer };
  return { ready: buffer.slice(0, cut + 1), rest: buffer.slice(cut + 1) };
}
