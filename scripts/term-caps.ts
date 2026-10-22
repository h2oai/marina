// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the terminal on the other end of a stream can show. Every styled CLI
 * surface asks here once, so `NO_COLOR`, `FORCE_COLOR`, `--color` and a pipe
 * mean the same thing everywhere (https://no-color.org, https://clig.dev).
 */

/** 0 = plain text, 1 = 16 colours, 2 = 256 colours, 3 = 24-bit truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export type ColorChoice = "auto" | "always" | "never";

export interface TermCaps {
  color: ColorLevel;
  /** Box drawing, braille spinners and geometric markers render; else ASCII. */
  unicode: boolean;
  /** OSC 8 hyperlinks. Only emitted for terminals known to support them. */
  links: boolean;
  /** Background brightness, when the environment says (COLORFGBG / MARINA_THEME). */
  background: "dark" | "light";
  columns: number;
}

type Env = Record<string, string | undefined>;

interface Stream {
  isTTY?: boolean;
  columns?: number;
}

const TRUECOLOR_PROGRAMS = new Set([
  "ghostty",
  "iTerm.app",
  "WezTerm",
  "vscode",
  "Hyper",
  "Tabby",
  "rio",
  "WarpTerminal",
  "kitty",
]);

const LINK_PROGRAMS = new Set([
  "ghostty",
  "iTerm.app",
  "WezTerm",
  "vscode",
  "Hyper",
  "Tabby",
  "rio",
  "WarpTerminal",
  "kitty",
]);

/** `--color=<choice>` / `--color <choice>` / `--no-color` from argv; undefined when absent. */
export function colorChoiceFromArgs(argv: readonly string[]): ColorChoice | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-color") return "never";
    const value = arg.startsWith("--color=") ? arg.slice(8) : arg === "--color" ? argv[i + 1] : "";
    if (value === "auto" || value === "always" || value === "never") return value;
  }
  return undefined;
}

/** Colour depth for one stream. An explicit choice wins, then NO_COLOR, FORCE_COLOR, TTY. */
export function colorLevel(
  stream: Stream | undefined,
  env: Env = process.env,
  choice?: ColorChoice,
): ColorLevel {
  if (choice === "never") return 0;
  const depth = detectedDepth(env);
  if (choice === "always") return depth === 0 ? 1 : depth;
  // NO_COLOR: present and not empty disables colour (no-color.org).
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    const n = Number(force);
    if (n >= 1 && n <= 3) return n as ColorLevel;
    return depth === 0 ? 1 : depth;
  }
  if (env.CLICOLOR_FORCE !== undefined && env.CLICOLOR_FORCE !== "0")
    return depth === 0 ? 1 : depth;
  if (!stream?.isTTY) return 0;
  if (env.TERM === "dumb") return 0;
  return depth;
}

function detectedDepth(env: Env): ColorLevel {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (env.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return 3;
  const term = env.TERM ?? "";
  if (/^xterm-(ghostty|kitty)$|direct|truecolor/.test(term)) return 3;
  if (/256/.test(term)) return 2;
  if (env.WT_SESSION) return 3;
  if (term === "dumb") return 0;
  return term ? 1 : 2;
}

/** UTF-8 locale and not the Linux console: geometric glyphs and box drawing are safe. */
export function unicodeSupported(env: Env = process.env, platform = process.platform): boolean {
  if (env.MARINA_ASCII === "1" || env.MARINA_ASCII === "true") return false;
  if (env.TERM === "linux") return false;
  if (platform === "win32") return !!(env.WT_SESSION || env.TERM_PROGRAM || env.TERM);
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return locale === "" || /utf-?8/i.test(locale);
}

/** Dark unless the terminal or the person says light (MARINA_THEME, COLORFGBG "fg;bg"). */
export function backgroundFromEnv(env: Env = process.env): "dark" | "light" {
  const theme = (env.MARINA_THEME ?? "").toLowerCase();
  if (theme.endsWith("light") || theme === "dawn" || theme === "day") return "light";
  if (theme) return "dark";
  const bg = Number((env.COLORFGBG ?? "").split(";").at(-1));
  // rxvt convention: 7 and 9–15 are light backgrounds.
  if (Number.isFinite(bg) && (bg === 7 || (bg >= 9 && bg <= 15))) return "light";
  return "dark";
}

export function termCaps(
  stream: Stream | undefined,
  env: Env = process.env,
  choice?: ColorChoice,
): TermCaps {
  const color = colorLevel(stream, env, choice);
  return {
    color,
    unicode: unicodeSupported(env),
    links:
      color > 0 &&
      !!stream?.isTTY &&
      (LINK_PROGRAMS.has(env.TERM_PROGRAM ?? "") || /ghostty|kitty/.test(env.TERM ?? "")),
    background: backgroundFromEnv(env),
    columns: Math.max(20, stream?.columns || Number(env.COLUMNS) || 80),
  };
}
