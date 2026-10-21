// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Code Mode's terminal styling, on the same theme as `marina connect`
 * (`term-theme.ts`). Entries arrive here already sanitised and labelled by
 * `formatCodePerception` (`[label] text`); this only paints them: a glyph and
 * colour per label, a muted key column, command-coloured suggestions, and the
 * inline decoration the connect renderer uses. Colour comes from structure,
 * never from bytes in the text. Plain output (pipes, NO_COLOR) is unchanged.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { termCaps } from "./term-caps";
import { decorate, glyphsFor, looksLikeMarkdown, markdownLines, wrap } from "./term-render";
import { createTheme, fgParams, gradientAt, type Theme, type Token } from "./term-theme";

/** The theme for one output stream (cached per stream). */
const themes = new WeakMap<object, Theme>();
export function themeFor(stream: { isTTY?: boolean; columns?: number } | undefined): Theme {
  if (!stream) return createTheme(termCaps(undefined));
  let theme = themes.get(stream);
  if (!theme || theme.columns !== Math.max(20, stream.columns || 80)) {
    theme = createTheme(termCaps(stream));
    themes.set(stream, theme);
  }
  return theme;
}

interface LabelStyle {
  glyph: string;
  tone: Token;
}

/** Each `formatCodePerception` label family gets a glyph and a tone (never colour alone). */
export function labelStyle(label: string, theme: Theme): LabelStyle {
  const g = glyphsFor(theme);
  const l = label.toLowerCase();
  if (l === "error") return { glyph: g.error, tone: "error" };
  if (l.startsWith("approval")) return { glyph: g.approval, tone: "warning" };
  if (/needs? attention|blocked|stopped|paused|unavailable|unknown/.test(l))
    return { glyph: g.warn, tone: "warning" };
  if (/ready for review|approved|submitted/.test(l)) return { glyph: g.ok, tone: "success" };
  if (l.startsWith("checks") || l.startsWith("verification"))
    return { glyph: g.voice, tone: "info" };
  if (l.startsWith("worker")) return { glyph: g.agent, tone: "accent2" };
  if (l.startsWith("diff") || l === "patch")
    return { glyph: theme.unicode ? "±" : "+-", tone: "accent" };
  if (l.startsWith("project")) return { glyph: g.system, tone: "muted" };
  if (l === "world") return { glyph: g.voice, tone: "accent2" };
  return { glyph: g.voice, tone: "accent" };
}

const LABEL = /^\[([^\]\n]{1,80})\] ?/;
const KEY_LINE = /^(\s*)([A-Z][A-Za-z0-9 /-]{1,30}):(\s)/;
const COMMAND_LINE = /^(\s{2,})(\/[a-z][\w-]*(?: <[^>]+>| \[[^\]]+\])*)(\s+)(.*)$/;
const SUGGESTION = /^(\s{2,})((?:\/world|In session \S+:) .+)$/;
const RULE = /^\s*─{8,}\s*$/;

// A command, not a path: nothing path-like follows the word.
const SLASH = /(^|[\s(])(\/[a-z][\w-]*)(?![\w/-]|\.\w)/g;

/** `/task`, `/diff` … in running text, in the command colour. */
function slashes(line: string, theme: Theme): string {
  return line.replace(SLASH, (_, pre: string, cmd: string) => `${pre}${theme.fg("code")(cmd)}`);
}

function styleLine(line: string, theme: Theme, width: number): string {
  if (RULE.test(line))
    return theme.fg("border")(
      Number.isFinite(width) ? "─".repeat(Math.min(width, 100)) : line.trim(),
    );
  // A runnable suggestion first: the whole command is one thing to copy.
  const suggestion = line.match(SUGGESTION);
  if (suggestion) return `${suggestion[1]}${theme.fg("code")(suggestion[2]!)}`;
  const command = line.match(COMMAND_LINE);
  if (command)
    return `${command[1]}${theme.fg("code")(command[2]!)}${command[3]}${theme.fg("muted")(command[4]!)}`;
  const key = line.match(KEY_LINE);
  if (key)
    return `${key[1]}${theme.fg("muted")(`${key[2]}:`)}${key[3]}${decorate(slashes(line.slice(key[0].length), theme), theme)}`;
  return decorate(slashes(line, theme), theme);
}

/**
 * One transcript entry for a terminal. `text` is already terminal-safe.
 * Labelled entries become `● label  first line` with the rest indented under
 * it; unlabelled ones keep their shape and gain inline styling. Diffs are left
 * to `colorizeDiff` and never indented, so a patch still copies cleanly.
 */
export function styleCodeEntry(
  text: string,
  theme: Theme,
  options: { width?: number; wrap?: boolean } = {},
): string {
  // The terminal soft-wraps by default, as Code Mode always has; `wrap` hangs
  // continuation lines under the gutter instead. Rules size to `width`.
  const width = options.width ?? theme.columns;
  if (theme.level === 0) return text;
  const match = text.match(LABEL);
  const rest = match ? text.slice(match[0].length) : text;
  const indent = match ? 2 : 0;
  const body = looksLikeMarkdown(rest)
    ? markdownLines(rest, { theme, width }, indent)
    : rest.split("\n").flatMap((line) => {
        const styled = styleLine(line, theme, width - indent);
        return options.wrap && Number.isFinite(width) ? wrap(styled, width - indent) : [styled];
      });
  if (!match) return body.join("\n");
  const { glyph, tone } = labelStyle(match[1]!, theme);
  const head = `${theme.fg(tone)(glyph)} ${theme.bold(theme.fg(tone)(match[1]!))}`;
  const [first = "", ...more] = body;
  // A short first line rides next to the label; a heading sits under it.
  const inline = first && visibleWidth(head) + 2 + visibleWidth(first) <= width;
  return [
    inline ? `${head}  ${first}` : head,
    ...(inline ? more : body).map((line) => (line ? `  ${line}` : line)),
  ].join("\n");
}

/** The Code Mode prompt: folder, agent and status in their tones, the chevron in accent. */
export function stylePrompt(
  parts: {
    destination: string;
    folder?: string;
    agent?: string;
    status?: string;
    badge?: string;
    more?: boolean;
  },
  theme: Theme,
): string {
  const dot = theme.fg("faint")(" · ");
  if (theme.level === 0) {
    return `${parts.destination}${parts.badge ? ` · ${parts.badge}` : ""}${parts.more ? " …" : ""} › `;
  }
  const pieces = parts.folder
    ? [
        theme.bold(theme.fg("info")(parts.folder)),
        ...(parts.agent ? [theme.fg("accent2")(parts.agent)] : []),
        ...(parts.status ? [statusTone(parts.status, theme)] : []),
      ]
    : [theme.fg("accent2")(parts.destination)];
  const badge = parts.badge ? `${dot}${theme.fg("warning")(parts.badge)}` : "";
  const more = parts.more ? theme.fg("muted")(" …") : "";
  return `${pieces.join(dot)}${badge}${more} ${theme.bold(theme.fg("accent")("›"))} `;
}

function statusTone(status: string, theme: Theme): string {
  const s = status.toLowerCase();
  const tone: Token = /error|fail|blocked|rejected/.test(s)
    ? "error"
    : /paused|waiting|attention|recovering|required/.test(s)
      ? "warning"
      : /working|running|checks/.test(s)
        ? "accent2"
        : /approved|ready for review/.test(s)
          ? "success"
          : "muted";
  return theme.fg(tone)(status);
}

/** Startup lines (`Starting Marina in …`, the summary, tips) in the shared palette. */
export function styleStartupLine(line: string, theme: Theme): string {
  if (theme.level === 0) return line;
  const summary = line.match(/^Marina (\S+) · (.*)$/);
  if (summary) {
    const word = "Marina";
    const mark =
      theme.level >= 2
        ? `${[...word]
            .map(
              (ch, i) =>
                `\x1b[1;${fgParams(gradientAt(theme.palette.gradient, i / (word.length - 1)), theme.level)}m${ch}`,
            )
            .join("")}\x1b[0m`
        : theme.bold(theme.fg("accent")(word));
    const [folder, ...rest] = summary[2]!.split(" · ");
    return `${mark} ${theme.fg("faint")(summary[1]!)} ${theme.fg("faint")("·")} ${theme.bold(theme.fg("info")(folder!))}${rest.length ? ` ${theme.fg("faint")("·")} ${theme.fg("muted")(rest.join(" · "))}` : ""}`;
  }
  if (/^Starting Marina in /.test(line)) return theme.fg("muted")(line);
  if (/^Tip: /.test(line))
    return `${theme.fg("faint")("Tip:")} ${decorate(slashes(line.slice(5), theme), theme)}`;
  if (/^(No LLM provider key|Exec ·)/.test(line)) return theme.fg("warning")(line);
  return decorate(slashes(line, theme), theme);
}
