// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `@` input shorthand. It only expands into existing verbs, so
 * permissions, audit and attention behave exactly as if typed:
 *
 *   @wren look at the failing test   → agent attention wren look at the failing test
 *   @wren,fern compare notes         → agent attention wren,fern compare notes
 *   @all summarise where you are     → agent attention all summarise where you are
 *   @@channels are open              → say @channels are open
 *
 * `agent attention all` reaches every resident the sender owns, or everyone
 * present when they own none (src/engine/commands/agent.ts).
 */

export type Mention =
  | { kind: "attention"; targets: string[] | "all"; message: string }
  | { kind: "escaped"; text: string };

const NAME = /^[A-Za-z0-9_]{1,20}$/;

/** Parse one line of input; undefined when it is not the shorthand. */
export function parseMention(input: string): Mention | undefined {
  const line = input.trim();
  if (line.startsWith("@@")) {
    const text = line.slice(1);
    return text.length > 1 ? { kind: "escaped", text } : undefined;
  }
  const match = /^@(\S+)\s+([\s\S]+)$/.exec(line);
  if (!match) return undefined;
  const list = match[1]!;
  const message = match[2]!.trim();
  if (!message) return undefined;
  if (list.toLowerCase() === "all") return { kind: "attention", targets: "all", message };
  const targets = [...new Set(list.split(",").filter(Boolean))];
  if (!targets.length || !targets.every((t) => NAME.test(t))) return undefined;
  return { kind: "attention", targets, message };
}

/** The world command a shorthand line stands for; undefined when it is not one. */
export function expandMention(input: string): string | undefined {
  const mention = parseMention(input);
  if (!mention) return undefined;
  if (mention.kind === "escaped") return `say ${mention.text}`;
  const targets = mention.targets === "all" ? "all" : mention.targets.join(",");
  return `agent attention ${targets} ${mention.message}`;
}
