// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The terminal renderer for the shared message grammar
 * (`src/sdk/message-format.ts`): blocks become wrapped lines (lists hang
 * under their marker, labels lead in bold, quotes and code get a bar) and
 * spans become theme colours. The dashboard renders the same parse as React,
 * so a message reads the same way on both.
 *
 * Every colour comes from `term-theme` tokens. With colour off the text is
 * the message as written: markers, quotes and backticks stay, because then
 * they are the only emphasis there is.
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type Block,
  type ListItem,
  type ParsedMessage,
  parseMessage,
  type Span,
} from "../src/sdk/message-format";
import type { Theme, Token } from "./term-theme";

export interface PaintOptions {
  /** Verdicts as inverse chips (messages) rather than bold tone colour (command output). */
  chips?: boolean;
  /** Your own name: an @mention of you is highlighted. */
  viewer?: string;
  /** Colour verdicts and shouted capitals (default true). Off inside server-coloured text. */
  verdicts?: boolean;
  /** OSC 8 hyperlinks for URLs (when the terminal supports them). */
  link?: (label: string, url: string) => string;
}

const TONE: Record<"good" | "bad" | "warn", Token> = {
  good: "success",
  bad: "error",
  warn: "warning",
};

/** Paint spans with theme colours. `base` is the SGR in force around them (re-applied after each span). */
export function paintSpans(
  spans: readonly Span[],
  theme: Theme,
  options: PaintOptions = {},
  base = "",
): string {
  if (!theme.level) return spans.map((s) => s.raw).join("");
  const sgr = (params: string) => (params ? `\x1b[${params}m` : "");
  const restore = `\x1b[0m${base}`;
  const wrap = (params: string, text: string) =>
    params ? `${sgr(params)}${text}${restore}` : text;
  const join = (...params: string[]) => params.filter(Boolean).join(";");
  const tok = (t: Token) => theme.params(t);
  let out = "";
  for (const s of spans) {
    switch (s.kind) {
      case "text":
        out += s.raw;
        break;
      case "code":
        out += wrap(tok("code"), s.text);
        break;
      case "url":
        out += wrap(tok("link"), options.link ? options.link(s.raw, s.href) : s.raw);
        break;
      case "mention": {
        const you = !!options.viewer && s.name.toLowerCase() === options.viewer.toLowerCase();
        out += you
          ? wrap(join("1", "7", tok("warning")), ` ${s.raw} `)
          : wrap(join("1", tok("info")), s.raw);
        break;
      }
      case "ref":
        out += wrap(tok("highlight"), s.raw);
        break;
      case "channel":
        out += wrap(tok("accent"), s.raw);
        break;
      case "verdict":
        if (options.verdicts === false) out += s.raw;
        else
          out += options.chips
            ? wrap(join("1", "7", tok(TONE[s.tone])), ` ${s.raw} `)
            : wrap(join("1", tok(TONE[s.tone])), s.raw);
        break;
      case "caps":
        out += options.verdicts === false ? s.raw : wrap("1", s.raw);
        break;
      case "strong": {
        const inner = `${base}\x1b[1m`;
        out += `\x1b[1m${paintSpans(s.children, theme, options, inner)}${restore}`;
        break;
      }
      case "em": {
        const inner = `${base}\x1b[3m`;
        out += `\x1b[3m${paintSpans(s.children, theme, options, inner)}${restore}`;
        break;
      }
      case "aside": {
        // An aside reads after the main clause: the muted colour, contents still styled.
        const muted = sgr(tok("muted"));
        out += `${muted}(${paintSpans(s.children, theme, options, muted)})${restore}`;
        break;
      }
      case "quote": {
        const open = s.raw[0] === "“" ? "“" : '"';
        const close = open === "“" ? "”" : '"';
        const faint = sgr(tok("faint"));
        const body = sgr(join("3"));
        out += `${faint}${open}${restore}${body}${paintSpans(s.children, theme, options, `${base}${body}`)}${restore}${faint}${close}${restore}`;
        break;
      }
      case "id":
        out += wrap(tok("faint"), s.raw);
        break;
      case "kv":
        out += `${wrap(tok("muted"), `${s.key}${s.sep}`)}${wrap(tok("code"), s.value)}`;
        break;
      case "arrow":
        out += wrap(tok("accent"), s.raw);
        break;
    }
  }
  return out;
}

export interface MessageLayout {
  /** Columns available for the body (the caller's gutter is outside this). */
  width: number;
}

/** Wrap one styled line; continuation lines get `hang` columns of indent. */
function wrapHang(first: string, text: string, width: number, hang: number): string[] {
  const avail = Math.max(10, width - visibleWidth(first));
  const lines = wrapTextWithAnsi(text, avail);
  const pad = " ".repeat(Math.min(hang, Math.floor(width / 3)));
  return lines.map((l, i) => (i === 0 ? `${first}${l}` : `${pad}${l}`));
}

function itemLines(
  item: ListItem,
  index: number,
  ordered: boolean,
  theme: Theme,
  opts: PaintOptions,
  width: number,
): string[] {
  const marker = ordered ? `${item.n ?? index + 1}.` : theme.unicode ? "•" : "-";
  const label = item.label ? `${theme.bold(paintSpans(item.label, theme, opts, "\x1b[1m"))} ` : "";
  const head = `${theme.fg("accent")(marker)} `;
  const out: string[] = [];
  const parts = `${label}${paintSpans(item.spans, theme, opts)}`.split("\n");
  parts.forEach((part, i) => {
    out.push(
      ...wrapHang(
        i === 0 ? head : " ".repeat(visibleWidth(marker) + 1),
        part,
        width,
        visibleWidth(marker) + 1,
      ),
    );
  });
  return out;
}

/** Visible lines for a parsed message body. */
export function blockLines(
  message: ParsedMessage,
  theme: Theme,
  opts: PaintOptions,
  layout: MessageLayout,
): string[] {
  const width = Math.max(20, layout.width);
  const out: string[] = [];
  const bar = theme.fg("border")(theme.unicode ? "│" : "|");
  for (const b of message.blocks as Block[]) {
    switch (b.kind) {
      case "paragraph": {
        const label = b.label ? `${theme.bold(paintSpans(b.label, theme, opts, "\x1b[1m"))} ` : "";
        for (const line of `${label}${paintSpans(b.spans, theme, opts)}`.split("\n")) {
          out.push(...wrapHang("", line, width, 0));
        }
        break;
      }
      case "heading":
        out.push(
          ...wrapHang(
            "",
            theme.bold(theme.fg("accent")(paintSpans(b.spans, theme, opts, "\x1b[1m"))),
            width,
            0,
          ),
        );
        break;
      case "list":
        for (const [i, item] of b.items.entries()) {
          out.push(...itemLines(item, i, b.ordered, theme, opts, width));
        }
        break;
      case "quote":
        for (const line of paintSpans(b.spans, theme, opts).split("\n")) {
          out.push(
            ...wrapHang(`${bar} `, theme.italic(line), width, 2).map((l, i) =>
              i ? `${bar} ${l.trimStart()}` : l,
            ),
          );
        }
        break;
      case "code":
        for (const line of b.text.split("\n")) out.push(`${bar} ${theme.fg("code")(line)}`);
        break;
      case "table": {
        const rows = [b.header, ...b.rows].map((r) => r.map((c) => paintSpans(c, theme, opts)));
        const widths: number[] = [];
        for (const r of rows)
          r.forEach((c, i) => {
            widths[i] = Math.max(widths[i] ?? 0, visibleWidth(c));
          });
        rows.forEach((r, ri) => {
          const line = r
            .map((c, i) => c + " ".repeat(Math.max(0, widths[i]! - visibleWidth(c))))
            .join("  ");
          out.push(ri === 0 ? theme.bold(line) : line);
        });
        break;
      }
      case "rule":
        out.push(theme.fg("border")((theme.unicode ? "─" : "-").repeat(Math.min(width, 60))));
        break;
    }
  }
  return out;
}

/** Parse and lay out a message body. */
export function messageLines(
  text: string,
  theme: Theme,
  opts: PaintOptions,
  layout: MessageLayout,
): string[] {
  return blockLines(parseMessage(text), theme, opts, layout);
}
