// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server text is data, not terminal instructions. Command output carries SGR
 * colour for telnet, but a participant's `say` can carry anything — window
 * titles, OSC 52 clipboard writes, cursor moves, hidden text. This keeps only
 * a vetted set of SGR attributes, re-expressed in the active theme, and drops
 * every other escape and control byte (newline and tab stay).
 */

import { type Theme, type Token, to256 } from "./term-theme";

// Server 16-colour codes → theme tokens. The server styles headers cyan, ids
// yellow, success green; the theme decides what those look like here.
const BASIC: Record<number, Token> = {
  30: "faint",
  31: "error",
  32: "success",
  33: "highlight",
  34: "info",
  35: "accent2",
  36: "accent",
  37: "text",
  90: "faint",
  91: "error",
  92: "success",
  93: "warning",
  94: "info",
  95: "accent2",
  96: "accent",
  97: "text",
};

// `src/net/ansi.ts` ENTITY_PALETTE indices → identity slots, so a name keeps
// one colour whether the server or the client painted it.
const SERVER_IDENTITY = [208, 117, 183, 220, 155, 210, 114, 75];

const KEEP = new Set([0, 1, 3, 4, 9, 22, 23, 24, 29, 39]);

/** One SGR parameter list → the theme's equivalent ("" when nothing survives). */
function remapSgr(raw: string, theme: Theme): string {
  if (theme.level === 0) return "";
  const parts = raw === "" ? [0] : raw.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (!Number.isInteger(code)) return "";
    if (KEEP.has(code)) out.push(String(code));
    else if (code === 2) out.push(theme.params("muted"));
    else if (BASIC[code]) out.push(theme.params(BASIC[code]!));
    else if (code === 38 && parts[i + 1] === 5) {
      const n = parts[i + 2] ?? -1;
      i += 2;
      const slot = SERVER_IDENTITY.indexOf(n);
      if (slot >= 0) {
        const swatch = theme.palette.identities[slot % theme.palette.identities.length]!;
        out.push(theme.level === 1 ? String(swatch.basic) : identityParams(theme, swatch.hex));
      } else if (n >= 0 && n <= 255 && theme.level >= 2) out.push(`38;5;${n}`);
    } else if (code === 38 && parts[i + 1] === 2) {
      const [r, g, b] = [parts[i + 2], parts[i + 3], parts[i + 4]];
      i += 4;
      if ([r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255) && theme.level === 3)
        out.push(`38;2;${r};${g};${b}`);
    }
    // Backgrounds, blink, reverse, conceal and everything unknown are dropped.
  }
  return out.filter(Boolean).join(";");
}

function identityParams(theme: Theme, hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return theme.level === 3
    ? `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`
    : `38;5;${to256Cached(hex)}`;
}

const cache = new Map<string, number>();
function to256Cached(hex: string): number {
  let v = cache.get(hex);
  if (v === undefined) cache.set(hex, (v = to256(hex)));
  return v;
}

/** Terminal-safe text: vetted SGR in theme colours, nothing else that is not printable. */
export function sanitizeServerText(text: string, theme: Theme): string {
  let out = "";
  let styled = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b || ch === 0x9b) {
      const csi = ch === 0x9b ? i + 1 : text[i + 1] === "[" ? i + 2 : -1;
      if (csi >= 0) {
        let j = csi;
        while (j < text.length && /[0-9;:<=>?]/.test(text[j]!)) j++;
        const params = text.slice(csi, j);
        while (j < text.length && /[ -/]/.test(text[j]!)) j++;
        const final = text[j];
        if (final === "m" && /^[0-9;:]*$/.test(params)) {
          const mapped = remapSgr(params, theme);
          if (mapped) {
            out += `\x1b[${mapped}m`;
            styled = mapped !== "0";
          }
        }
        i = j + 1;
        continue;
      }
      const kind = text[i + 1];
      if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
        // String sequences run to BEL or ST (ESC \); unterminated ones swallow the rest.
        let j = i + 2;
        while (
          j < text.length &&
          text.charCodeAt(j) !== 0x07 &&
          !(text[j] === "\x1b" && text[j + 1] === "\\")
        )
          j++;
        i = text.charCodeAt(j) === 0x07 ? j + 1 : j + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === 0x0a || ch === 0x09) out += text[i];
    else if (
      ch >= 0x20 &&
      !(ch >= 0x7f && ch <= 0x9f) &&
      !(ch >= 0x202a && ch <= 0x202e) &&
      !(ch >= 0x2066 && ch <= 0x2069)
    )
      out += text[i];
    i++;
  }
  // Never let a participant's colour bleed into the next line we print.
  return styled ? `${out}\x1b[0m` : out;
}

/** Remove every escape sequence (for width measurement and plain output). */
export function plainText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape stripping needs ESC
  return text.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, "");
}
