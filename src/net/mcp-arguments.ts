// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { errorText, type McpResult } from "./mcp-types";

// ─── Argument hygiene ─────────────────────────────────────────────────────────
//
// Tool parameters are interpolated into engine command lines, and the engine
// tokenizer splits on whitespace with NO quote grammar — so a `key` or `target`
// containing a space would inject extra tokens (`memory set goal x importance 9`
// from key="goal x importance"). Values destined for a single-token position
// must therefore be single tokens; quoting could not make them one.

/** Raised by {@link quoteArg}; tool handlers surface it as an `isError` result. */
export class McpArgError extends Error {}

/**
 * Validate a value that will occupy ONE token of an engine command. Rejects
 * line breaks / control characters outright and any internal whitespace (the
 * tokenizer cannot preserve a spaced value as a single argument). Returns the
 * value unchanged when it is safe to interpolate.
 */
export function quoteArg(value: string, label = "argument"): string {
  if (hasControlCharacters(value, false)) {
    throw new McpArgError(`${label} must not contain line breaks or control characters`);
  }
  if (value.length === 0) throw new McpArgError(`${label} must not be empty`);
  if (/\s/.test(value)) {
    throw new McpArgError(
      `${label} must be a single token (no spaces) — got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Free-text parameters (messages, values) may contain spaces but never line breaks. */
export function textArg(value: string, label = "text"): string {
  if (hasControlCharacters(value, true)) {
    throw new McpArgError(`${label} must not contain line breaks or control characters`);
  }
  return value;
}

/** C0 controls + DEL; `allowTab` keeps horizontal tabs (free text) legal. */
function hasControlCharacters(value: string, allowTab: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 && allowTab) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Run a tool body, translating {@link McpArgError} into an error result. */
export async function guarded(run: () => Promise<McpResult> | McpResult): Promise<McpResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpArgError) return errorText(`Error: ${error.message}`);
    throw error;
  }
}
