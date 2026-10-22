// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Styling for the `marina` dispatcher's own screens (`--help`, `status`,
 * `init`). Each function paints text the caller already built and never
 * changes a word of it, so the plain text (pipes, NO_COLOR, tests) is
 * exactly what it was.
 */

import { decorate, glyphsFor } from "./term-render";
import { fgParams, gradientAt, type Theme, type Token } from "./term-theme";

/** "marina" (or any word) across the palette gradient, bold. */
export function wordmark(word: string, theme: Theme): string {
  if (theme.level < 2) return theme.bold(theme.fg("accent")(word));
  const chars = [...word];
  const span = Math.max(1, chars.length - 1);
  return `${chars
    .map(
      (ch, i) =>
        `\x1b[1;${fgParams(gradientAt(theme.palette.gradient, i / span), theme.level)}m${ch}`,
    )
    .join("")}\x1b[0m`;
}

const SECTION = /^([A-Z][^:]{0,40}):$/;
// "  marina connect <name> [...]  description" / "  --flag <x>   description" / "  0  meaning"
const ENTRY = /^(\s{2})((?:marina|--|-[a-z]|[A-Z_]{3,}|[0-9]\b)\S*(?: [^\s].*?)?)(\s{2,})(\S.*)$/;
const BARE_ENTRY = /^(\s{2})((?:marina|--|-[a-z])\S*(?: [^\s].*?)?)\s*$/;

/** `marina --help`: sections, commands and flags in the command colour, descriptions plain. */
export function styleUsage(text: string, theme: Theme): string {
  if (theme.level === 0) return text;
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        const [word, ...rest] = line.split(" ");
        return `${wordmark(word!, theme)} ${theme.italic(theme.fg("muted")(rest.join(" ")))}`;
      }
      const section = line.match(SECTION);
      if (section) return theme.bold(theme.fg("accent")(line));
      const entry = line.match(ENTRY);
      if (entry)
        return `${entry[1]}${theme.fg("code")(entry[2]!)}${entry[3]}${decorate(entry[4]!, theme)}`;
      const bare = line.match(BARE_ENTRY);
      if (bare) return `${bare[1]}${theme.fg("code")(bare[2]!)}`;
      return decorate(line, theme);
    })
    .join("\n");
}

const STATUS_ROW = /^(\s{2})(ok|degraded|off|optional)(\s+)(.*)$/;
const KEY_ROW = /^(\s{2})([a-z]+)(\s{2,})(.*)$/;

/** `marina status`: the health line, aligned keys, and one glyph and tone per capability. */
export function styleStatusReport(text: string, theme: Theme): string {
  if (theme.level === 0) return text;
  const g = glyphsFor(theme);
  const tone: Record<string, Token> = {
    ok: "success",
    degraded: "warning",
    off: "error",
    optional: "faint",
  };
  const glyph: Record<string, string> = { ok: g.ok, degraded: g.warn, off: g.error, optional: "○" };
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        const m = line.match(/^Marina at (\S+): (\S+)$/);
        if (!m) return line;
        const healthy = m[2] === "ok";
        return `${wordmark("Marina", theme)} ${theme.fg("muted")("at")} ${theme.fg("link")(m[1]!)}${theme.fg("muted")(":")} ${theme.fg(healthy ? "success" : "error")(`${healthy ? g.voice : g.error} ${m[2]}`)}`;
      }
      if (/^\s{2}status\s+capability$/.test(line)) return theme.fg("faint")(line);
      const row = line.match(STATUS_ROW);
      if (row) {
        const kind = row[2]!;
        // The word stays (never colour alone); the glyph leads it.
        return `${row[1]}${theme.fg(tone[kind]!)(`${glyph[kind]} ${kind}`)}${row[3]!.slice(2)}${decorate(row[4]!, theme)}`;
      }
      if (/^\s+→ /.test(line)) return theme.fg("faint")(line);
      const key = line.match(KEY_ROW);
      if (key) return `${key[1]}${theme.fg("muted")(key[2]!)}${key[3]}${decorate(key[4]!, theme)}`;
      return decorate(line, theme);
    })
    .join("\n");
}

/** Small helpers for `marina init`'s interactive screens. */
export function initStyles(theme: Theme) {
  const g = glyphsFor(theme);
  return {
    banner: (title: string) =>
      theme.level === 0
        ? title
        : `\n${wordmark("marina", theme)} ${theme.fg("muted")(title)}\n${theme.fg("border")(g.rule.repeat(Math.min(theme.columns, 48)))}`,
    section: (text: string) => (theme.level ? theme.bold(theme.fg("accent")(text)) : text),
    choice: (number: string, name: string, description: string) =>
      theme.level
        ? `  ${theme.fg("highlight")(number)} ${theme.fg("code")(name)}${theme.fg("muted")(description)}`
        : `  ${number} ${name}${description}`,
    ask: (prompt: string) =>
      theme.level
        ? prompt.replace(
            /([^\n]*?)(\[[^\]]*\]|\([^)]*\))?(:\s*)$/,
            (_, q, def = "", colon) =>
              `${theme.bold(q)}${def ? theme.fg("muted")(def) : ""}${theme.fg("accent")(colon)}`,
          )
        : prompt,
    ok: (text: string) => (theme.level ? theme.fg("success")(text) : text),
    fail: (text: string) => (theme.level ? theme.fg("error")(text) : text),
    muted: (text: string) => (theme.level ? theme.fg("muted")(text) : text),
  };
}
