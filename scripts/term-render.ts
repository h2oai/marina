// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Perception → styled terminal lines for an interactive CLI. The layout
 * follows the agentic coding CLIs people already read fluently (Claude Code,
 * Codex): your command's result hangs off `⎿`, other voices get a coloured
 * `●` marker, every kind has a glyph as well as a colour, and long text wraps
 * under its gutter. Every server byte passes `sanitizeServerText` first.
 */

import {
  Markdown,
  type MarkdownTheme,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Perception } from "../src/sdk/client";
import { messageMentions, parseInline, parseMessage } from "../src/sdk/message-format";
import { blockLines, paintSpans } from "./term-message";
import { plainText, sanitizeServerText } from "./term-sanitize";
import type { Theme } from "./term-theme";

export interface Glyphs {
  prompt: string;
  result: string;
  resultCont: string;
  voice: string;
  tell: string;
  agent: string;
  system: string;
  error: string;
  ok: string;
  warn: string;
  approval: string;
  arrive: string;
  leave: string;
  rule: string;
  dot: string;
  ellipsis: string;
  spinner: string[];
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

const UNICODE: Glyphs = {
  prompt: "❯",
  result: "⎿",
  resultCont: " ",
  voice: "●",
  tell: "◆",
  agent: "✦",
  system: "·",
  error: "✗",
  ok: "✓",
  warn: "▲",
  approval: "⚑",
  arrive: "→",
  leave: "←",
  rule: "─",
  dot: "·",
  ellipsis: "…",
  // Pulse, bounced: the same rhythm Claude Code's ✻ uses.
  spinner: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"],
  box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};

const ASCII: Glyphs = {
  prompt: ">",
  result: "`",
  resultCont: " ",
  voice: "*",
  tell: "@",
  agent: "+",
  system: "-",
  error: "x",
  ok: "ok",
  warn: "!",
  approval: "[?]",
  arrive: ">",
  leave: "<",
  rule: "-",
  dot: "|",
  ellipsis: "...",
  spinner: ["-", "\\", "|", "/"],
  box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

export function glyphsFor(theme: Pick<Theme, "unicode">): Glyphs {
  return theme.unicode ? UNICODE : ASCII;
}

export interface RenderOptions {
  theme: Theme;
  /** The connected participant's own name (to recognise echoes of what you said). */
  self?: string;
  /** Total columns available. */
  width: number;
  /** Names known to be agents (marked ✦ instead of ●). */
  isAgent?: (name: string) => boolean;
}

export interface RenderContext {
  /** Output of the command you just ran. */
  own: boolean;
  failed?: boolean;
  /** The same sender spoke just before in the same place: no repeated header. */
  continued?: boolean;
}

/** Widest a message body runs, whatever the terminal width: long lines are hard to read. */
export const MESSAGE_MEASURE = 100;

/** Visible lines for one perception. `own` = output of the command you just ran. */
export function renderPerception(
  p: Perception,
  options: RenderOptions,
  context: RenderContext,
): string[] {
  const { theme } = options;
  const g = glyphsFor(theme);
  const text = typeof p.data?.text === "string" ? p.data.text : "";

  if (p.kind === "movement") {
    const d = p.data as { entity?: string; direction?: string; exit?: string };
    const who = sanitizeServerText(d.entity ?? "Someone", theme);
    const line =
      d.direction === "arrive"
        ? `${g.arrive} ${who} arrives`
        : `${g.leave} ${who} leaves${d.exit ? ` ${sanitizeServerText(d.exit, theme)}` : ""}`;
    return [`  ${theme.fg("faint")(line)}`];
  }

  if (p.kind === "room") return renderRoom(p, options);

  // Presence notices are scenery: faint, one line, never competing with speech.
  if (!context.own && ["connect", "disconnect", "leave", "move"].includes(p.tag ?? "")) {
    const glyph = p.tag === "connect" ? g.arrive : g.leave;
    const line = plainText(sanitizeServerText(text, theme)).replace(/\.$/, "");
    return line ? [`  ${theme.fg("faint")(`${glyph} ${line}`)}`] : [];
  }
  if (!context.own && p.tag === "emote" && text) {
    const line = plainText(sanitizeServerText(text, theme)).replace(/^\* /, "");
    return wrap(theme.italic(theme.fg("muted")(line)), options.width - 2).map(
      (l, i) => `${i === 0 ? `${theme.fg("faint")(g.voice)} ` : "  "}${l}`,
    );
  }

  const voice = voiceOf(p);
  if (voice && !context.own) return renderVoice(voice, p, options, context.continued);

  const history = channelHistoryOf(p);
  if (history && !(context.own && context.failed)) return renderHistory(history, options);

  if (p.kind === "error" || p.kind === "auth_error" || (context.own && context.failed)) {
    const body = bodyLines(text || JSON.stringify(p.data), options, 4, "error");
    return gutter(body, `${theme.fg("error")(g.error)} `, "  ", options, context.own);
  }

  if (p.data?.execApproval || /^\s*(challenge|approval)\b.*\btoken\b/i.test(plainText(text))) {
    const body = bodyLines(text, options, 4);
    return gutter(body, `${theme.fg("warning")(g.approval)} `, "  ", options, context.own);
  }

  if (p.kind === "system" && !context.own) {
    const body = bodyLines(text, options, 4, "muted");
    return body.map((line, i) => `${i === 0 ? `${theme.fg("muted")(g.system)} ` : "  "}${line}`);
  }

  const raw = text || (p.data && Object.keys(p.data).length ? JSON.stringify(p.data) : "");
  if (!raw) return [];
  const body = looksLikeMarkdown(raw) ? markdownLines(raw, options, 5) : bodyLines(raw, options, 5);
  if (context.own) return gutter(body, "", "", options, true);
  // Ambient output that is not speech: a world notice addressed to you.
  return body.map((line, i) => `${i === 0 ? `${theme.fg("accent")(g.voice)} ` : "  "}${line}`);
}

/** `⎿  first` / `   rest` under your command; ambient blocks keep their own marker. */
function gutter(
  body: string[],
  marker: string,
  indent: string,
  options: RenderOptions,
  own: boolean,
): string[] {
  const g = glyphsFor(options.theme);
  if (!own) return body.map((line, i) => `${i === 0 ? marker : indent}${line}`);
  const hook = options.theme.fg("faint")(g.result);
  return body.map((line, i) =>
    i === 0 ? `  ${hook}  ${marker}${line}` : `     ${marker ? indent : ""}${line}`,
  );
}

interface Voice {
  name: string;
  message: string;
  kind: "say" | "tell" | "shout" | "emote" | "channel" | "broadcast";
  channel?: string;
}

/** Structured speech, when the server sent it (sender and message as separate fields). */
function voiceOf(p: Perception): Voice | undefined {
  const tag = p.tag ?? "";
  const d = p.data as {
    senderName?: unknown;
    message?: unknown;
    channel?: unknown;
    text?: unknown;
  };
  if (typeof d.senderName !== "string" || typeof d.message !== "string") return undefined;
  if (!["say", "tell", "shout", "emote", "channel", "broadcast"].includes(tag)) return undefined;
  return {
    name: d.senderName,
    message: d.message,
    kind: tag as Voice["kind"],
    channel: typeof d.channel === "string" ? d.channel : undefined,
  };
}

function renderVoice(v: Voice, p: Perception, options: RenderOptions, continued = false): string[] {
  const { theme } = options;
  const g = glyphsFor(theme);
  const name = sanitizeServerText(v.name, theme);
  const paint = theme.identity(plainText(name));
  const agent = options.isAgent?.(plainText(name)) ?? false;
  const self = !!options.self && plainText(name) === options.self;
  // The body is plain text through the shared grammar (any escapes are dropped).
  const parsed = parseMessage(plainText(sanitizeServerText(v.message, theme)));
  const mentioned = !self && messageMentions(parsed, options.self);
  const marker =
    v.kind === "tell"
      ? theme.fg("accent2")(g.tell)
      : agent
        ? paint(g.agent)
        : self
          ? theme.fg("faint")(g.voice)
          : paint(g.voice);
  const via =
    v.kind === "tell"
      ? theme.fg("muted")(" → you")
      : v.kind === "channel" && v.channel
        ? theme.fg("muted")(` #${sanitizeServerText(v.channel, theme)}`)
        : v.kind === "shout"
          ? theme.fg("warning")(" shouts")
          : "";
  const time = theme.fg("faint")(clock(p.timestamp));
  if (v.kind === "emote") {
    const body = wrap(
      theme.italic(`${name} ${sanitizeServerText(v.message, theme)}`),
      options.width - 2,
    );
    return body.map((line, i) => `${i === 0 ? `${marker} ` : "  "}${line}`);
  }
  const head = `${marker} ${paint(plainText(name))}${via}${agent ? theme.fg("faint")(" agent") : ""}`;
  const measure = Math.min(options.width, MESSAGE_MEASURE) - 2;
  const lines = blockLines(
    parsed,
    theme,
    { chips: true, viewer: options.self, link: theme.link },
    { width: measure },
  ).map((line) => (v.kind === "shout" ? theme.bold(line) : line));
  // One line when it fits next to the name (chat), else a header and the body
  // under a bar in the sender's colour (yours in the warning colour when it
  // names you), so where one message ends and the next begins is plain.
  const headWidth = visibleWidth(head);
  if (
    !continued &&
    lines.length === 1 &&
    parsed.blocks[0]?.kind === "paragraph" &&
    headWidth + 2 + visibleWidth(lines[0]!) + 8 <= options.width
  ) {
    const pad = Math.max(
      2,
      options.width - headWidth - 2 - visibleWidth(lines[0]!) - visibleWidth(time) - 1,
    );
    return [`${head}  ${lines[0]}${" ".repeat(pad)}${time}`];
  }
  const barGlyph = theme.unicode ? "▎" : "|";
  const bar = mentioned
    ? theme.fg("warning")(barGlyph)
    : self
      ? theme.fg("faint")(barGlyph)
      : paint(barGlyph);
  const body = lines.map((line) => `${bar} ${line}`);
  if (continued) return body;
  const flag = mentioned ? theme.fg("warning")(theme.unicode ? " ◂ you" : " < you") : "";
  return [`${head}${flag}  ${time}`, ...body];
}

interface HistoryMessage {
  senderName: string;
  content: string;
  createdAt?: number;
}

/** `channel history`'s structured payload, when the server sent one. */
function channelHistoryOf(
  p: Perception,
): { channel: string; messages: HistoryMessage[] } | undefined {
  const h = p.data?.channelHistory as { channel?: unknown; messages?: unknown } | undefined;
  if (!h || typeof h.channel !== "string" || !Array.isArray(h.messages)) return undefined;
  const messages = h.messages.filter(
    (m): m is HistoryMessage =>
      !!m &&
      typeof (m as HistoryMessage).senderName === "string" &&
      typeof (m as HistoryMessage).content === "string",
  );
  return { channel: h.channel, messages };
}

/** A channel's history as a conversation: day lines, grouped senders, the same bodies. */
function renderHistory(
  h: { channel: string; messages: HistoryMessage[] },
  options: RenderOptions,
): string[] {
  const { theme } = options;
  const out: string[] = [
    theme.bold(theme.fg("accent")(`#${sanitizeServerText(h.channel, theme)}`)),
  ];
  let lastDay = "";
  let last: HistoryMessage | undefined;
  for (const m of h.messages) {
    const day = m.createdAt ? dayLabel(m.createdAt) : "";
    if (day && day !== lastDay) {
      out.push(dayRule(day, options));
      lastDay = day;
      last = undefined;
    }
    const continued =
      !!last &&
      last.senderName === m.senderName &&
      !!m.createdAt &&
      !!last.createdAt &&
      m.createdAt - last.createdAt < GROUP_MS;
    out.push(
      ...renderVoice(
        { name: m.senderName, message: m.content, kind: "say" },
        { kind: "message", tag: "say", timestamp: m.createdAt ?? 0, data: {} } as Perception,
        options,
        continued,
      ),
    );
    last = m;
  }
  return out;
}

/** Consecutive messages from one sender within this window share a header. */
export const GROUP_MS = 5 * 60_000;

export function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** `── Wed, Nov 4 ──────` between messages of different days. */
export function dayRule(label: string, options: RenderOptions): string {
  const { theme } = options;
  const g = glyphsFor(theme);
  const width = Math.min(options.width, MESSAGE_MEASURE);
  const lead = `${g.rule.repeat(2)} ${label} `;
  return theme.fg("faint")(`${lead}${g.rule.repeat(Math.max(2, width - visibleWidth(lead)))}`);
}

function renderRoom(p: Perception, options: RenderOptions): string[] {
  const { theme } = options;
  const g = glyphsFor(theme);
  const d = p.data as {
    short?: string;
    long?: string;
    exits?: string[];
    entities?: { name: string; short: string }[];
    items?: Record<string, string>;
  };
  const clean = (s: string) => sanitizeServerText(s, theme);
  const lines: string[] = [];
  if (d.short) lines.push(theme.bold(theme.fg("accent")(clean(d.short))));
  if (d.long) lines.push(...wrap(clean(d.long), options.width - 5));
  const label = (t: string) => theme.fg("muted")(t.padEnd(8));
  if (d.items && Object.keys(d.items).length)
    lines.push(
      `${label("objects")}${Object.keys(d.items)
        .map(clean)
        .join(theme.fg("faint")(` ${g.dot} `))}`,
    );
  if (d.entities?.length)
    lines.push(
      `${label("present")}${d.entities.map((e) => theme.identity(plainText(e.name))(clean(e.name))).join(", ")}`,
    );
  if (d.exits?.length)
    lines.push(`${label("exits")}${d.exits.map((e) => theme.fg("accent")(clean(e))).join(" ")}`);
  return lines.map((line, i) => (i === 0 ? `${theme.fg("accent")(g.voice)} ${line}` : `  ${line}`));
}

// ── Body text ────────────────────────────────────────────────────────────────

const RULE_ONLY = /^[\s]*[─━-]{8,}[\s]*$/;
const STATUS_GLYPH: Record<string, "success" | "warning" | "error" | "faint" | "info"> = {
  "✓": "success",
  "✔": "success",
  "⚠": "warning",
  "▲": "warning",
  "✗": "error",
  "✘": "error",
  "○": "faint",
  "◌": "faint",
  "→": "info",
  "↳": "info",
};

/**
 * Server text → wrapped, themed lines. Server colour survives (remapped to the
 * theme); plain lines additionally get inline code, links and status glyphs.
 */
export function bodyLines(
  text: string,
  options: RenderOptions,
  indent: number,
  tone?: "error" | "muted",
): string[] {
  const { theme } = options;
  const g = glyphsFor(theme);
  const width = Math.max(20, options.width - indent);
  const out: string[] = [];
  const clean = sanitizeServerText(text.replace(/\r\n?/g, "\n").replace(/\s+$/, ""), theme);
  for (const line of clean.split("\n")) {
    if (RULE_ONLY.test(plainText(line))) {
      out.push(theme.fg("border")(g.rule.repeat(Math.min(width, 100))));
      continue;
    }
    let styled = decorate(line, theme);
    if (tone && !line.includes("\x1b")) styled = theme.fg(tone)(styled);
    out.push(...wrap(styled.replace(/\t/g, "  "), width));
  }
  return out;
}

/**
 * Inline decoration: status glyphs, `code`, **bold**, links and #refs. Works
 * inside server colour too — after each decorated span the colour that was
 * active before it is re-applied, so a muted line stays muted.
 */
export function decorate(line: string, theme: Theme): string {
  let active = "";
  let out = "";
  let first = true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: split on SGR sequences
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      active = part === "\x1b[0m" ? "" : active + part;
      continue;
    }
    if (!part) continue;
    const span = (style: (t: string) => string) => (t: string) => `${style(t)}${active}`;
    let text = part;
    let head = "";
    if (first) {
      first = false;
      const lead = text.match(/^(\s*)(\S)/);
      if (lead && STATUS_GLYPH[lead[2]!]) {
        head = `${lead[1]}${span(theme.fg(STATUS_GLYPH[lead[2]!]!))(lead[2]!)}`;
        text = text.slice(lead[0].length);
      }
    } else if (/\S/.test(part)) first = false;
    // The shared grammar styles code, links, refs, asides and ids; verdict
    // colours only where the server set no colour of its own.
    text = paintSpans(parseInline(text), theme, { verdicts: !active, link: theme.link }, active);
    out += head + text;
  }
  return out;
}

/** Heuristic: model answers and agent messages in Markdown, never server-styled output. */
export function looksLikeMarkdown(text: string): boolean {
  if (text.includes("\x1b")) return false;
  return /^```|^#{1,4} \S|^\s*[-*] \S[\s\S]*\n\s*[-*] \S|^\s*\d+\. \S[\s\S]*\n\s*\d+\. \S|\*\*[^*\n]+\*\*|^\|.+\|\s*$/m.test(
    text,
  );
}

export function markdownLines(text: string, options: RenderOptions, indent: number): string[] {
  const { theme } = options;
  const clean = plainText(sanitizeServerText(text, theme));
  const md = new Markdown(clean, 0, 0, markdownTheme(theme));
  return md
    .render(Math.max(20, options.width - indent))
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, i, all) => !(line === "" && (i === 0 || all[i - 1] === "")));
}

function markdownTheme(theme: Theme): MarkdownTheme {
  const fg = theme.fg;
  return {
    heading: (t) => theme.bold(fg("accent")(t)),
    link: (t) => fg("link")(theme.underline(t)),
    linkUrl: (t) => fg("faint")(t),
    code: fg("code"),
    codeBlock: fg("code"),
    codeBlockBorder: fg("faint"),
    quote: (t) => theme.italic(fg("muted")(t)),
    quoteBorder: fg("border"),
    hr: fg("border"),
    listBullet: fg("accent"),
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: (t) => (theme.level ? `\x1b[9m${t}\x1b[29m` : t),
    underline: theme.underline,
  };
}

/** Wrap to width; continuation lines hang two columns past the line's own indent. */
export function wrap(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const [first, ...rest] = wrapTextWithAnsi(text, Math.max(10, width));
  if (!rest.length) return [first!];
  // Prose wraps flush; an indented or list line hangs under its own text.
  const indent = plainText(text).match(/^\s*/)?.[0].length ?? 0;
  if (!indent) return [first!, ...rest];
  const lead = indent + 2;
  const hang = " ".repeat(Math.min(lead, Math.floor(width / 3)));
  const tail = wrapTextWithAnsi(
    rest.map((l) => l.trimStart()).join(" "),
    Math.max(10, width - hang.length),
  );
  return [first!, ...tail.map((l) => `${hang}${l}`)];
}

function clock(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
