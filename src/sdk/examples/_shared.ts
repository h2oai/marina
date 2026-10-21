// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the SDK examples: the Marina /v1 endpoint, a one-shot
 * chat completion, ANSI stripping and the small text parsers the provider
 * examples use. Not part of the published SDK.
 */

import type { Perception } from "../client";

export const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(
  /\/$/,
  "",
);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
export const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (t: string) => t.replace(ANSI_RE, "");

export interface Message {
  role: string;
  content: string;
}

/** One chat completion through Marina's OpenAI-compatible /v1 endpoint. */
export async function callMarina(
  model: string,
  messages: Message[],
  temperature = 0,
): Promise<string> {
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** `[channel] sender: content` → its parts (ANSI stripped), or undefined. */
export function extractChannelPayload(
  text: string,
): { channel: string; sender: string; content: string } | undefined {
  const clean = stripAnsi(text);
  const match = clean.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.*)/s);
  if (!match) return undefined;
  return { channel: match[1]!, sender: match[2]!.trim(), content: match[3]!.trim() };
}

/** The multiple-choice letter (A–J) a response commits to, or "". */
export function extractLetter(response: string): string {
  const cleaned = response.trim().toUpperCase();
  const explicit = [...cleaned.matchAll(/ANSWER\s*(?:IS|:|=|WOULD BE)\s*\(?\**([A-J])\**\)?/g)];
  if (explicit.length > 0) return explicit[explicit.length - 1]![1]!;
  if (cleaned.length <= 5) {
    const m = cleaned.match(/\b([A-J])\b/);
    if (m) return m[1]!;
  }
  const all = [...cleaned.matchAll(/\b([A-J])\b/g)];
  if (all.length > 0) return all[all.length - 1]![1]!;
  if (cleaned.length > 0 && /[A-J]/.test(cleaned[0]!)) return cleaned[0]!;
  return "";
}

/** The text of a batch of perceptions, ANSI stripped, one per line. */
export function perceptionsToText(ps: Perception[]): string {
  return ps
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .map(stripAnsi)
    .filter((t) => t.length > 0)
    .join("\n");
}
