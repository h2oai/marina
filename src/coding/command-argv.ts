// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Parse argv grouping only. Never expands variables, substitutions, globs or operators. */
export function parseCommandArgv(text: string): string[] {
  if (text.trimStart().startsWith("--argv ")) {
    const value: unknown = JSON.parse(text.trimStart().slice(7));
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      throw new Error("--argv requires a nonempty JSON array of argument strings.");
    return value;
  }
  const argv: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\0") throw new Error("Command contains a null byte.");
    if (char === "\\" && quote !== "'") {
      const next = text[i + 1];
      if (next === undefined) throw new Error("Command ends with an incomplete escape.");
      // Double quotes preserve backslashes in Python/JSON escapes such as \n.
      if (!quote || ['"', "\\", "$", "`"].includes(next)) {
        word += next;
        i++;
      } else word += char;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Command has an unmatched quote.");
  if (started) argv.push(word);
  return argv;
}
