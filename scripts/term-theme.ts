// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's colour system: semantic tokens over named palettes, rendered for
 * the colour depth the terminal has (truecolor → nearest 256 → a fixed
 * 16-colour choice per token). Nothing else in the CLI writes a raw colour.
 */

import type { ColorLevel, TermCaps } from "./term-caps";

export type Token =
  | "text"
  | "muted"
  | "faint"
  | "border"
  | "accent"
  | "accent2"
  | "highlight"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "code"
  | "link";

interface Swatch {
  hex: string;
  /** SGR foreground code used at 16 colours. */
  basic: number;
}

export interface Palette {
  name: string;
  background: "dark" | "light";
  tokens: Record<Token, Swatch>;
  /** Per-participant identity colours, chosen by a stable hash of the name. */
  identities: Swatch[];
  /** Gradient stops for the wordmark and meters, left to right. */
  gradient: string[];
  /** Render with the 16 ANSI colours whatever the terminal supports. */
  ansiOnly?: boolean;
}

const s = (hex: string, basic: number): Swatch => ({ hex, basic });

export const PALETTES: Record<string, Palette> = {
  // Harbor Night: aqua and coral on the terminal's own background.
  harbor: {
    name: "harbor",
    background: "dark",
    tokens: {
      text: s("#d8e2e6", 39),
      muted: s("#8fa3ad", 90),
      faint: s("#5a6e78", 2),
      border: s("#2c3e4a", 90),
      accent: s("#4fd1c5", 36),
      accent2: s("#ff8a70", 91),
      highlight: s("#e8c27a", 33),
      success: s("#7fd69b", 32),
      warning: s("#e8c27a", 33),
      error: s("#f2667a", 31),
      info: s("#7ab8f5", 34),
      code: s("#9be0d0", 36),
      link: s("#7ab8f5", 34),
    },
    identities: [
      s("#5ec4e8", 36),
      s("#f4a261", 35),
      s("#b79cf0", 32),
      s("#8bd17c", 34),
      s("#f08cb8", 33),
      s("#e6d47a", 96),
      s("#6fd3b0", 95),
      s("#a8b8f8", 92),
    ],
    gradient: ["#2ec4b6", "#4fd1c5", "#7ab8f5", "#b79cf0", "#ff8a70"],
  },
  // Harbor Day: for light terminals (reference background #f7f4ec, sand).
  "harbor-light": {
    name: "harbor-light",
    background: "light",
    tokens: {
      text: s("#1f2d36", 39),
      muted: s("#5b6b73", 90),
      faint: s("#8e9ba1", 2),
      border: s("#d5d0c4", 90),
      accent: s("#0e7c7b", 36),
      accent2: s("#d1543b", 31),
      highlight: s("#a86a00", 33),
      success: s("#2e8540", 32),
      warning: s("#a86a00", 33),
      error: s("#c0283a", 31),
      info: s("#2563b0", 34),
      code: s("#0b6e62", 36),
      link: s("#2563b0", 34),
    },
    identities: [
      s("#1f7fb0", 36),
      s("#b5651d", 35),
      s("#7048c0", 32),
      s("#3f8a2e", 34),
      s("#b83d7a", 33),
      s("#8a7400", 96),
      s("#0f8a6e", 95),
      s("#4f5fc0", 92),
    ],
    gradient: ["#0e7c7b", "#2563b0", "#7048c0", "#d1543b"],
  },
};

/**
 * Lighthouse: the 16 ANSI colours only, so the person's own terminal theme
 * (Catppuccin, Tokyo Night, Gruvbox …) decides every hue. `MARINA_THEME=ansi`.
 */
PALETTES.ansi = { ...PALETTES.harbor!, name: "ansi", ansiOnly: true };

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 index (6×6×6 cube or the grey ramp, whichever is closer). */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const levels = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [cube(r), cube(g), cube(b)];
  const cubeIndex = 16 + 36 * cr + 6 * cg + cb;
  const cubeDist = (levels[cr]! - r) ** 2 + (levels[cg]! - g) ** 2 + (levels[cb]! - b) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const greyStep = grey < 8 ? 0 : grey > 238 ? 23 : Math.round((grey - 8) / 10);
  const greyValue = 8 + greyStep * 10;
  const greyDist = (greyValue - r) ** 2 + (greyValue - g) ** 2 + (greyValue - b) ** 2;
  return greyDist < cubeDist ? 232 + greyStep : cubeIndex;
}

/** SGR foreground parameters for one swatch at a colour depth ("" at depth 0). */
export function fgParams(swatch: Swatch | string, level: ColorLevel): string {
  const hex = typeof swatch === "string" ? swatch : swatch.hex;
  if (level === 0) return "";
  if (level === 3) {
    const [r, g, b] = rgb(hex);
    return `38;2;${r};${g};${b}`;
  }
  if (level === 2) return `38;5;${to256(hex)}`;
  return String(typeof swatch === "string" ? 39 : swatch.basic);
}

const RESET = "\x1b[0m";

export type Style = (text: string) => string;

export interface Theme {
  palette: Palette;
  level: ColorLevel;
  unicode: boolean;
  links: boolean;
  columns: number;
  fg(token: Token): Style;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  /** Raw SGR parameter string for a token (for the server-text remapper). */
  params(token: Token): string;
  identity(name: string): Style;
  /** Text painted across the palette gradient, one colour step per character. */
  gradient(text: string): string;
  /** OSC 8 link when supported; otherwise the label (plus the URL when they differ). */
  link(label: string, url: string): string;
}

/** FNV-1a: stable across runs and machines, so a person keeps one colour. */
export function nameHash(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function lerp(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[mix(ar, br), mix(ag, bg), mix(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Colour at position t ∈ [0, 1] along a multi-stop gradient. */
export function gradientAt(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0]!;
  const scaled = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(scaled);
  return lerp(stops[i]!, stops[i + 1]!, scaled - i);
}

export function paletteFor(caps: Pick<TermCaps, "background">, env = process.env): Palette {
  const requested = (env.MARINA_THEME ?? "").toLowerCase();
  const named =
    PALETTES[requested === "dark" ? "harbor" : requested === "light" ? "harbor-light" : requested];
  if (named) return named;
  return caps.background === "light" ? PALETTES["harbor-light"]! : PALETTES.harbor!;
}

export function createTheme(caps: TermCaps, palette: Palette = paletteFor(caps)): Theme {
  const level: ColorLevel = palette.ansiOnly && caps.color > 1 ? 1 : caps.color;
  const wrap = (open: string, text: string) =>
    level === 0 || !open || !text ? text : `\x1b[${open}m${text}${RESET}`;
  // Body text stays in the terminal's own foreground (clig.dev: colour carries meaning).
  const params = (token: Token) =>
    token === "text" ? (level ? "39" : "") : fgParams(palette.tokens[token], level);
  return {
    palette,
    level,
    unicode: caps.unicode,
    links: caps.links,
    columns: caps.columns,
    fg: (token) => (text) => wrap(params(token), text),
    bold: (text) => wrap("1", text),
    dim: (text) => wrap(params("muted"), text),
    italic: (text) => wrap("3", text),
    underline: (text) => wrap("4", text),
    params,
    identity: (name) => {
      const swatch = palette.identities[nameHash(name) % palette.identities.length]!;
      return (text) => wrap(`1;${fgParams(swatch, level)}`, text);
    },
    gradient: (text) => {
      if (level < 2) return wrap(params("accent"), text);
      const chars = [...text];
      const span = Math.max(1, chars.length - 1);
      return (
        chars
          .map((ch, i) =>
            ch === " "
              ? ch
              : `\x1b[${fgParams(gradientAt(palette.gradient, i / span), level)}m${ch}`,
          )
          .join("") + RESET
      );
    },
    link: (label, url) => {
      if (caps.links) return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
      return label === url ? label : `${label} (${url})`;
    },
  };
}
