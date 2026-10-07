// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mechanical labels for failed tool results (lessons from work, `./work.ts`).
 * Pure, no imports: safe on the agent event hot path. Only the label ever
 * leaves these functions; the result text is never kept.
 */

const CLASSES: ReadonlyArray<[string, RegExp]> = [
  ["output-limit", /output limit interrupted/i],
  ["budget", /tool budget reached|per-run cap|budget (?:reached|exhausted)|spend cap/i],
  [
    "unknown-command",
    /unknown (?:command|subcommand|tool)|not a (?:valid )?command|no such command/i,
  ],
  ["rate-limit", /rate.?limit|too many requests|\b429\b|slow down/i],
  ["timeout", /timed? ?out|timeout|deadline exceeded|ETIMEDOUT/i],
  [
    "permission",
    /permission|not allowed|forbidden|unauthori[sz]ed|requires rank|refused|denied|blocked|\bgate\b|\b403\b/i,
  ],
  [
    "invalid-args",
    /^usage:|\busage: |invalid (?:argument|input|value|json|param)|missing (?:argument|required|param)|expected .{0,40}(?:argument|number|string)|validation|malformed|cannot parse|\b400\b/i,
  ],
  [
    "not-found",
    /not found|no such|does not exist|unknown (?:entity|player|room|note|task|id|user)|\b404\b/i,
  ],
  ["conflict", /already exists|conflict|duplicate|\b409\b/i],
  ["network", /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network error|\b50[234]\b/i],
];

/**
 * A short general class for a failed tool result's text (`other` when none
 * matches). Only the label leaves this function; the text is never kept.
 */
export function classifyToolError(result: unknown): string {
  const text = toText(result).slice(0, 2_000);
  for (const [label, re] of CLASSES) if (re.test(text)) return label;
  return "other";
}

/**
 * A soft failure in a result the tool reported as success — command tools
 * answer an unknown command or a usage error in text. Strong leading markers
 * only; undefined for an ordinary result.
 */
export function softFailureClass(result: unknown): string | undefined {
  const head = toText(result).trimStart().slice(0, 200);
  if (
    /^(?:unknown (?:command|subcommand)|usage:|error:|cannot |not found|refused|denied)/i.test(head)
  )
    return classifyToolError(head);
  return undefined;
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const content = (v as { content?: unknown }).content;
    if (Array.isArray(content))
      return content
        .map((c) =>
          c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "",
        )
        .join(" ");
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return v === undefined || v === null ? "" : String(v);
}

/** A tool or program name kept to a general token (never arguments, never a path). */
export function generalToolName(name: string): string {
  const base = name.trim().split(/\s+/)[0] ?? "";
  const leaf = base.split("/").pop() ?? base;
  return (leaf.match(/^[A-Za-z0-9_.:-]{1,48}/)?.[0] ?? "tool").toLowerCase();
}
