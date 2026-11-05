// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one grammar for how a message reads on a screen. `parseMessage` turns a
 * message body (a channel post, tell, board post, agent answer) into blocks
 * (paragraphs, lists, quotes, code, tables) and inline spans (code, links,
 * mentions, references, verdicts, quiet asides, quoted output, ids). Every
 * surface people read renders the SAME parse its own way: the terminal with
 * theme colours (`scripts/term-render.ts`), the dashboard as React
 * (`dashboard/src/components/MessageBody.tsx`), telnet with 16 colours, the
 * Discord and Telegram bridges in their own markup.
 *
 * Display only. The stored message never changes, copy copies the original,
 * and agents never read through this module: they get the text as written.
 *
 * Pure, dependency-free and total: any string parses, nothing throws, and
 * every span keeps the exact source slice it came from (`raw`), so the
 * concatenated raws of a block are its body, character for character.
 *
 * Messages agents wrote before line breaks were kept are one long line; the
 * block pass recovers their structure (inline `1. … 2. …` and `(1) (2)`
 * lists, ". - " bullets, "Label: …" paragraphs) without changing a character.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type Tone = "good" | "bad" | "warn";

export type Span =
  | { kind: "text"; raw: string }
  /** `code`, and identifiers such as `MARINA_AUTONOMY`. `text` is what to show. */
  | { kind: "code"; raw: string; text: string }
  | { kind: "url"; raw: string; href: string }
  | { kind: "mention"; raw: string; name: string }
  /** `#22`, `task #22`, `note #23676`, `#181-#186`, `task:22`. `refKind` when the text names it. */
  | { kind: "ref"; raw: string; refKind?: string; id: string }
  | { kind: "channel"; raw: string; name: string }
  /** A known verdict word or phrase in capitals: PASS, BLOCKED, REVIEWED AND APPROVED. */
  | { kind: "verdict"; raw: string; tone: Tone }
  /** Other shouted capitals (NEW, FIELD): shown as emphasis, not as shouting. */
  | { kind: "caps"; raw: string }
  | { kind: "strong"; raw: string; children: Span[] }
  | { kind: "em"; raw: string; children: Span[] }
  /** A parenthetical aside: read after the main clause. `children` excludes the parens. */
  | { kind: "aside"; raw: string; children: Span[] }
  /** Quoted output or a quoted phrase. `children` excludes the quote marks. */
  | { kind: "quote"; raw: string; children: Span[] }
  /** Hex ids and UUIDs: machine detail, kept quiet. */
  | { kind: "id"; raw: string }
  | { kind: "kv"; raw: string; key: string; sep: string; value: string }
  | { kind: "arrow"; raw: string };

export interface ListItem {
  /** The marker as written: `1.`, `(2)`, `-`, `*`, or "" for a recovered item. */
  marker: string;
  /** The number of an ordered item. */
  n?: number;
  label?: Span[];
  spans: Span[];
}

export type Block =
  | { kind: "paragraph"; label?: Span[]; spans: Span[] }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "table"; header: Span[][]; rows: Span[][][] }
  | { kind: "rule" };

export interface ParsedMessage {
  blocks: Block[];
  /** Long enough that a reader should see it folded first (renderers choose the cut). */
  fold: boolean;
}

export interface ParseOptions {
  /** Recover lists and labelled paragraphs inside one-line messages. Default true. */
  recover?: boolean;
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Verdict words, from what agents actually write (`#general`, Nov 2026:
 * PASS ×611, ABSTAINED, BLOCKED, OPEN, PARTIAL, CONDITIONAL, FAIL …).
 * Extend from measured usage, never by guess.
 */
const GOOD = new Set(
  "PASS PASSES PASSED APPROVED APPROVE CONFIRMED DONE CLOSED SUPPORTED MEASURED ANSWERED VERIFIED COMPLETE COMPLETED RESOLVED FIXED MERGED OK GREEN SHIPPED ACCEPTED".split(
    " ",
  ),
);
const BAD = new Set(
  "FAIL FAILS FAILED FAILING BLOCKED WITHDRAWN RETRACTION RETRACTED REJECTED REJECT DENIED BROKEN WRONG INVALID ERROR REFUSED RED REGRESSION".split(
    " ",
  ),
);
const WARN = new Set(
  "PARTIAL CONDITIONAL UNKNOWN INFERRED OPEN PENDING ABSTAINED ABSTAIN REVISION REQUIRED ACTION CAVEAT CAVEATS CORRECTION UNRUN UNVERIFIED UNTESTED STALE PROPOSAL REVIEWED REVIEW WARNING WARN TODO WIP HOLD HELD DEFERRED".split(
    " ",
  ),
);
/** Capitals that are names, not shouting. */
const ACRONYMS = new Set(
  "JSON UUID URL URI API HTTP HTTPS MCP CLI SDK LLM PR PRS CI CD ID IDS SQL DB FTS CSS HTML ANSI UTF ACP REST WAL CSV PDF TTL UTC GPU CPU RAM SSH TLS DNS IP AWS EC2 S3 GCP OS UI UX AI ML RL NLP SSE CORS JWT OAUTH OIDC SSRF XSS CSRF CVE GHSA PID TCP UDP YAML TOML XML MD NPM BUN TS JS RFC FAQ ETA EOD AND OR NOT USD EUR".split(
    " ",
  ),
);
const CAPS_JOINERS = new Set(["AND", "OR", "NOT", "BUT", "WITH", "NO"]);

/** Reference kinds a message may name before `#N`. */
const REF_WORDS =
  "task|tasks|note|notes|post|posts|board(?: [a-z][\\w-]*)?|chronicle|trace|challenge|tell|issue|pr|PR|step|item|message|msg|run|round|project|canvas|answer|helper answer";
const TYPED_REF = /^(task|note|chronicle|trace|challenge|tell|channel_msg|board|post|run):([\w-]+)/;

// ── Inline pass ──────────────────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (ch: string | undefined) => !!ch && WORD.test(ch);

function matchCode(t: string, i: number): { body: string; end: number } | undefined {
  let n = 0;
  while (t[i + n] === "`") n++;
  let j = i + n;
  while (j < t.length) {
    const ch = t[j]!;
    if (ch === "\n" && t[j + 1] === "\n") return undefined;
    if (ch === "\\" && t[j + 1] === "`") {
      j += 2;
      continue;
    }
    if (ch === "`") {
      let k = 0;
      while (t[j + k] === "`") k++;
      if (k === n) {
        const body = t.slice(i + n, j).replace(/\\`/g, "`");
        // `` `a` `` style: one space of padding on both sides is not content.
        const trimmed = n > 1 && /^ .* $/s.test(body) ? body.slice(1, -1) : body;
        return trimmed ? { body: trimmed, end: j + k } : undefined;
      }
      j += k;
      continue;
    }
    j++;
  }
  return undefined;
}

function matchClose(t: string, i: number, open: string, close: string, max: number): number {
  let depth = 0;
  for (let j = i; j < t.length && j < i + max; j++) {
    const ch = t[j]!;
    if (ch === "\n") return -1;
    if (ch === "`") {
      const code = matchCode(t, j);
      if (code) {
        j = code.end - 1;
        continue;
      }
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

const URL_AT = /^https?:\/\/[^\s<>"'`]+/;
function urlAt(t: string, i: number): string | undefined {
  const m = URL_AT.exec(t.slice(i, i + 2048));
  if (!m) return undefined;
  let url = m[0];
  for (;;) {
    const last = url.at(-1)!;
    if (".,;:!?'\"*_".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else break;
  }
  return url.length > 8 ? url : undefined;
}
const count = (s: string, ch: string) => s.split(ch).length - 1;

const REF_AT = new RegExp(
  `^(?:(?<word>${REF_WORDS}) )?#(?<id>\\d{1,9})(?:(?:-|–|/)#?\\d{1,9})*(?![\\w])`,
);
const CHANNEL_AT = /^#(?<name>[a-z][\w-]{1,48})(?![\w-])/;
const MENTION_AT = /^@(?<name>[A-Za-z][\w-]{0,47})/;
const CAPS_AT = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*(?: (?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*))*(?![\w])/u;
const IDENT_AT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w])/;
const HEX_AT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,40})(?![\w-])/;
const KV_AT =
  /^(?<key>[a-z_][\w.]{0,40})(?<sep>[=:])(?<value>"[^"\s]{1,80}"|<[\w-]{1,40}>|[\w.<>/+-]{1,80})/;
const ARROW_AT = /^(?:→|->|=>)(?=\s)/;

function classifyCaps(raw: string): Span {
  const words = raw.split(/\s+/);
  // Strip joiners off the ends: "PASS AND" → keep only a phrase that starts and ends on a word.
  const core = (w: string) => w.replace(/-+$/, "");
  const has = (set: Set<string>) => words.some((w) => set.has(core(w)));
  if (has(BAD)) return { kind: "verdict", raw, tone: "bad" };
  if (has(GOOD)) return { kind: "verdict", raw, tone: "good" };
  if (has(WARN)) return { kind: "verdict", raw, tone: "warn" };
  const shouted = words.filter((w) => !ACRONYMS.has(core(w)) && !CAPS_JOINERS.has(w));
  if (shouted.some((w) => core(w).replace(/[^A-Z]/g, "").length >= 4)) return { kind: "caps", raw };
  return { kind: "text", raw };
}

/** Longest caps phrase at `i` that does not end on a joiner (`PASS AND` → `PASS`). */
function capsAt(t: string, i: number): string | undefined {
  const m = CAPS_AT.exec(t.slice(i, i + 200));
  if (!m) return undefined;
  const words = m[0].split(/( )/);
  // "A NEW note": a one-letter word is a word; the phrase starts after it.
  if (words.length > 1 && words[0]!.length === 1) return undefined;
  while (words.length > 1 && CAPS_JOINERS.has(words.at(-1)!)) words.splice(-2, 2);
  const raw = words.join("");
  // One capital letter is a word ("A", "I"), not shouting.
  return raw.length >= 2 ? raw : undefined;
}

/**
 * Inline spans of one line or paragraph. `depth` stops nested asides from
 * recursing without bound.
 */
export function parseInline(t: string, depth = 0): Span[] {
  const out: Span[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", raw: text });
    text = "";
  };
  const push = (span: Span) => {
    flush();
    out.push(span);
  };
  let i = 0;
  while (i < t.length) {
    const ch = t[i]!;
    const prev = i > 0 ? t[i - 1] : undefined;
    const atBoundary = !isWord(prev);

    if (ch === "`") {
      const code = matchCode(t, i);
      if (code) {
        push({ kind: "code", raw: t.slice(i, code.end), text: code.body });
        i = code.end;
        continue;
      }
    }
    if (ch === "h" && atBoundary) {
      const url = urlAt(t, i);
      if (url) {
        push({ kind: "url", raw: url, href: url });
        i += url.length;
        continue;
      }
    }
    if (ch === "*" && t[i + 1] === "*" && depth < 3) {
      const end = t.indexOf("**", i + 2);
      if (end > i + 2 && end - i < 400 && !t.slice(i + 2, end).includes("\n") && t[i + 2] !== " ") {
        push({
          kind: "strong",
          raw: t.slice(i, end + 2),
          children: parseInline(t.slice(i + 2, end), depth + 1),
        });
        i = end + 2;
        continue;
      }
    }
    if (
      (ch === "*" || ch === "_") &&
      atBoundary &&
      t[i + 1] !== ch &&
      t[i + 1] !== " " &&
      depth < 3
    ) {
      const end = t.indexOf(ch, i + 1);
      if (
        end > i + 1 &&
        end - i < 200 &&
        !isWord(t[end + 1]) &&
        t[end - 1] !== " " &&
        !t.slice(i + 1, end).includes("\n")
      ) {
        push({
          kind: "em",
          raw: t.slice(i, end + 1),
          children: parseInline(t.slice(i + 1, end), depth + 1),
        });
        i = end + 1;
        continue;
      }
    }
    if (ch === "(" && depth < 3 && (prev === undefined || /[\s"“'([{—–-]/.test(prev))) {
      const end = matchClose(t, i, "(", ")", 400);
      const inner = end > 0 ? t.slice(i + 1, end) : "";
      // `(1)` and `(a)` are enumerators; `()` and `( )` are not asides.
      if (end > 0 && inner.trim() && !/^\s*(\d{1,2}|[a-z]|[ivx]{1,4})\s*$/.test(inner)) {
        push({ kind: "aside", raw: t.slice(i, end + 1), children: parseInline(inner, depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (
      (ch === '"' || ch === "“") &&
      depth < 3 &&
      (prev === undefined || /[\s([{:—–-]/.test(prev))
    ) {
      const closeCh = ch === "“" ? "”" : '"';
      const end = t.indexOf(closeCh, i + 1);
      const inner = end > 0 ? t.slice(i + 1, end) : "";
      if (
        end > i + 1 &&
        end - i <= 400 &&
        !inner.includes("\n") &&
        inner.trim() === inner &&
        !isWord(t[end + 1])
      ) {
        push({ kind: "quote", raw: t.slice(i, end + 1), children: parseInline(inner, depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "@" && atBoundary) {
      const m = MENTION_AT.exec(t.slice(i, i + 50));
      if (m) {
        push({ kind: "mention", raw: m[0], name: m.groups!.name! });
        i += m[0].length;
        continue;
      }
    }
    if (atBoundary && (ch === "#" || /[a-zA-Z]/.test(ch))) {
      const m = REF_AT.exec(t.slice(i, i + 80));
      if (m && (ch === "#" || m.groups!.word)) {
        push({ kind: "ref", raw: m[0], refKind: m.groups!.word?.toLowerCase(), id: m.groups!.id! });
        i += m[0].length;
        continue;
      }
      const typed = TYPED_REF.exec(t.slice(i, i + 80));
      if (typed && !isWord(t[i + typed[0].length])) {
        push({ kind: "ref", raw: typed[0], refKind: typed[1], id: typed[2]! });
        i += typed[0].length;
        continue;
      }
    }
    if (ch === "#" && atBoundary) {
      const m = CHANNEL_AT.exec(t.slice(i, i + 50));
      if (m && !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(m[0])) {
        push({ kind: "channel", raw: m[0], name: m.groups!.name! });
        i += m[0].length;
        continue;
      }
    }
    if (atBoundary && ch >= "A" && ch <= "Z") {
      const ident = IDENT_AT.exec(t.slice(i, i + 80));
      if (ident) {
        push({ kind: "code", raw: ident[0], text: ident[0] });
        i += ident[0].length;
        continue;
      }
      const caps = capsAt(t, i);
      if (caps) {
        const span = classifyCaps(caps);
        if (span.kind === "text") text += caps;
        else push(span);
        i += caps.length;
        continue;
      }
    }
    if (atBoundary && /[0-9a-f]/.test(ch)) {
      const m = HEX_AT.exec(t.slice(i, i + 40));
      if (m && /\d/.test(m[0]) && /[a-f]/.test(m[0])) {
        push({ kind: "id", raw: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (atBoundary && /[a-z_]/.test(ch)) {
      const m = KV_AT.exec(t.slice(i, i + 140));
      if (m && !isWord(t[i + m[0].length]) && !/^https?$/.test(m.groups!.key!)) {
        const { key, sep, value } = m.groups!;
        push({ kind: "kv", raw: m[0], key: key!, sep: sep!, value: value! });
        i += m[0].length;
        continue;
      }
      // Skip the rest of a plain word so its letters are never re-tested mid-word.
      const word = /^[\p{L}\p{N}_]+/u.exec(t.slice(i, i + 100))![0];
      text += word;
      i += word.length;
      continue;
    }
    if ((ch === "-" || ch === "=" || ch === "→") && (prev === " " || prev === undefined)) {
      const m = ARROW_AT.exec(t.slice(i, i + 3));
      if (m) {
        push({ kind: "arrow", raw: m[0] });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ── Block pass ───────────────────────────────────────────────────────────────

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const BULLET = /^(\s*)([-*•])\s+(.*)$/s;
const ORDERED = /^(\s*)(\d{1,3})([.)])\s+(.*)$/s;
const HEADING = /^(#{1,4})\s+(.*)$/;
const QUOTE_LINE = /^>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_─━])(\s*\1){2,}\s*$/;
/** "Label: rest" at the start of a paragraph: up to six words, then a colon and a space. */
const LABEL = /^((?:[A-Z@#][\w'#@.()/+-]*)(?: [\w'#@.()/+-]+){0,5}):\s+(?=\S)/;

/** Where a recovered list or labelled paragraph starts inside one line. */
const NEW = "\u0000";

function splitSequence(t: string, at: (n: number) => RegExp, tail: boolean): string {
  const hits: { at: number; len: number }[] = [];
  let pos = 0;
  for (let n = 1; n < 100; n++) {
    const m = at(n).exec(t.slice(pos));
    if (!m) break;
    const start = pos + m.index + m[1]!.length;
    hits.push({ at: start, len: m[0].length - m[1]!.length });
    pos = start + 1;
  }
  if (hits.length < 2) return t;
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += `${t.slice(last, h.at)}${NEW}`;
    last = h.at;
  }
  let rest = t.slice(last);
  if (tail) {
    // An in-sentence `(1) … (2) …` ends with its sentence; what follows is a paragraph.
    const end = rest.search(/[.!?]["”)]? (?=[A-Z])/);
    if (end >= 0) {
      const cut = rest.indexOf(" ", end) + 1;
      rest = `${rest.slice(0, cut)}${NEW}${rest.slice(cut)}`;
    }
  }
  return out + rest;
}

/**
 * Structure inside one long line: labelled sentences start paragraphs,
 * `1. … 2. …` / `(1) … (2) …` runs become items, ". - " runs become bullets.
 * Only inserts break markers; never changes a character.
 */
function recoverStructure(line: string): string {
  if (line.length < 80) return line;
  let t = line;
  // Numbered items first: a label pass that ran earlier would put its break
  // between "2." and the item's text and hide the marker.
  t = splitSequence(t, (n) => new RegExp(`(^|[\\s:;.${NEW}])${n}[.)] (?=[A-Z\`"“#(@*])`), false);
  // "Label: …" after a sentence end, never after an item number ("2. Label: …").
  t = t.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0000 is this pass's own break marker (NEW)
    /(?<![\s(\u0000]\d{1,3})([.!?]["”)]?) (?=(?:[A-Z][\w'#-]*)(?: [\w'#()+-]+){0,5}: \S)/g,
    (_m, end: string) => `${end} ${NEW}`,
  );
  t = splitSequence(t, (n) => new RegExp(`(^|[\\s${NEW}])\\(${n}\\) (?=\\S)`), true);
  if ((t.match(/[.:;] - (?=\S)/g) ?? []).length >= 2) {
    t = t.replace(/([.:;]) (- (?=\S))/g, (_m, end: string, dash: string) => `${end} ${NEW}${dash}`);
  }
  return t;
}

function labelled(text: string): { label?: Span[]; spans: Span[] } {
  const m = LABEL.exec(text);
  // A label is short and is not itself a sentence ("Note that x: y" is prose).
  if (!m || m[1]!.length > 48 || /^(https?|[a-z]+:\/\/)/i.test(text))
    return { spans: parseInline(text) };
  return { label: parseInline(`${m[1]}:`), spans: parseInline(text.slice(m[0].length)) };
}

function itemOf(text: string): ListItem | undefined {
  const ord = /^(\d{1,3})([.)]) ([\s\S]*)$/.exec(text) ?? /^\((\d{1,2})\)() ([\s\S]*)$/.exec(text);
  if (ord) {
    const marker = ord[2] ? `${ord[1]}${ord[2]}` : `(${ord[1]})`;
    return { marker, n: Number(ord[1]), ...labelled(ord[3]!) };
  }
  const bullet = /^([-*•]) ([\s\S]*)$/.exec(text);
  if (bullet) return { marker: bullet[1]!, ...labelled(bullet[2]!) };
  return undefined;
}

function cells(row: string): Span[][] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));
}

/** Parse a message body into blocks for display. Total: never throws. */
export function parseMessage(input: string, options: ParseOptions = {}): ParsedMessage {
  const recover = options.recover !== false;
  const text = (typeof input === "string" ? input : String(input ?? "")).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | undefined;

  const closeList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = undefined;
  };
  const addItem = (item: ListItem) => {
    const ordered = item.n !== undefined;
    if (!list || list.ordered !== ordered) {
      closeList();
      list = { ordered, items: [] };
    }
    list.items.push(item);
  };
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join("\n");
    para = [];
    const pieces = recover ? recoverStructure(joined).split(NEW) : [joined];
    for (const piece of pieces) {
      const p = piece.trim();
      if (!p) continue;
      const item = pieces.length > 1 ? itemOf(p) : undefined;
      if (item) addItem(item);
      else {
        closeList();
        blocks.push({ kind: "paragraph", ...labelled(p) });
      }
    }
    if (pieces.length > 1) closeList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      closeList();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(fence[1]!.slice(0, 3)))
        body.push(lines[j++]!);
      blocks.push({ kind: "code", ...(fence[2] ? { lang: fence[2] } : {}), text: body.join("\n") });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      flushPara();
      closeList();
      const header = cells(line);
      const rows: Span[][][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) rows.push(cells(lines[j++]!));
      blocks.push({ kind: "table", header, rows });
      i = j - 1;
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      closeList();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      closeList();
      blocks.push({ kind: "heading", level: heading[1]!.length, spans: parseInline(heading[2]!) });
      continue;
    }
    const quote = QUOTE_LINE.exec(line);
    if (quote) {
      flushPara();
      closeList();
      const body = [quote[1]!];
      while (i + 1 < lines.length && QUOTE_LINE.test(lines[i + 1]!))
        body.push(QUOTE_LINE.exec(lines[++i]!)![1]!);
      blocks.push({ kind: "quote", spans: parseInline(body.join("\n")) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? undefined : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const item: ListItem = bullet
        ? { marker: bullet[2]!, ...labelled(bullet[3]!) }
        : {
            marker: `${ordered![2]}${ordered![3]}`,
            n: Number(ordered![2]),
            ...labelled(ordered![4]!),
          };
      addItem(item);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // An indented line continues the last item.
      const last = list.items.at(-1)!;
      last.spans.push({ kind: "text", raw: "\n" }, ...parseInline(line.trim()));
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();

  const lineCount = blocks.reduce(
    (n, b) =>
      n +
      (b.kind === "list"
        ? b.items.length
        : b.kind === "code"
          ? b.text.split("\n").length
          : b.kind === "table"
            ? b.rows.length + 1
            : 1),
    0,
  );
  return { blocks, fold: text.length > 700 || lineCount > 12 };
}

// ── Helpers for renderers ────────────────────────────────────────────────────

/** The source text of spans, exactly as written. */
export function spansRaw(spans: readonly Span[]): string {
  return spans.map((s) => s.raw).join("");
}

/** The visible text of spans (code without backticks, asides with parens). */
export function spansText(spans: readonly Span[]): string {
  return spans
    .map((s) => {
      switch (s.kind) {
        case "code":
          return s.text;
        case "strong":
        case "em":
          return spansText(s.children);
        case "aside":
          return `(${spansText(s.children)})`;
        case "quote":
          return `“${spansText(s.children)}”`;
        default:
          return s.raw;
      }
    })
    .join("");
}

/** True when `name` (a mention) addresses `viewer`, case-insensitively. */
export function mentionsViewer(spans: readonly Span[], viewer: string | undefined): boolean {
  if (!viewer) return false;
  const v = viewer.toLowerCase();
  return spans.some(
    (s) =>
      (s.kind === "mention" && s.name.toLowerCase() === v) ||
      ((s.kind === "strong" || s.kind === "em" || s.kind === "aside" || s.kind === "quote") &&
        mentionsViewer(s.children, viewer)),
  );
}

/** Every span of a parsed message, depth-first (for mention checks and tests). */
export function allSpans(message: ParsedMessage): Span[] {
  const out: Span[] = [];
  const walk = (spans: readonly Span[]) => {
    for (const s of spans) {
      out.push(s);
      if (s.kind === "strong" || s.kind === "em" || s.kind === "aside" || s.kind === "quote")
        walk(s.children);
    }
  };
  for (const b of message.blocks) {
    if (b.kind === "paragraph") {
      if (b.label) walk(b.label);
      walk(b.spans);
    } else if (b.kind === "heading" || b.kind === "quote") walk(b.spans);
    else if (b.kind === "list")
      for (const item of b.items) {
        if (item.label) walk(item.label);
        walk(item.spans);
      }
    else if (b.kind === "table")
      for (const row of [b.header, ...b.rows]) for (const c of row) walk(c);
  }
  return out;
}

/** Does this message address `viewer` with an @mention? */
export function messageMentions(message: ParsedMessage, viewer: string | undefined): boolean {
  return mentionsViewer(allSpans(message), viewer);
}

/** A one-line excerpt for a reply preview: plain visible text, cut at `max`. */
export function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
