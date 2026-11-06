// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The shared message grammar (src/sdk/message-format.ts): what each span and
// block means, structure recovered from one-line agent messages, and the
// invariant every renderer relies on: parsing never loses or reorders a
// character of the message.

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  allSpans,
  type Block,
  excerpt,
  hasMarkdown,
  messageMentions,
  parseInline,
  parseMessage,
  type Span,
  spansRaw,
  spansText,
} from "../src/sdk/message-format";
import { propertyOptions } from "./property-options";

const kinds = (spans: Span[]) => spans.filter((s) => s.kind !== "text").map((s) => s.kind);
const find = <K extends Span["kind"]>(spans: Span[], kind: K) =>
  spans.find((s) => s.kind === kind) as Extract<Span, { kind: K }> | undefined;

/** Every non-whitespace character a block came from, markers included. */
function blockSource(b: Block): string {
  switch (b.kind) {
    case "paragraph":
      return (b.label ? spansRaw(b.label) : "") + spansRaw(b.spans);
    case "list":
      return b.items
        .map((i) => i.marker + (i.label ? spansRaw(i.label) : "") + spansRaw(i.spans))
        .join("");
    case "heading":
    case "quote":
      return spansRaw(b.spans);
    case "code":
      return b.text;
    case "table":
      return [b.header, ...b.rows].map((r) => r.map(spansRaw).join("")).join("");
    case "rule":
      return "";
  }
}
const nonWs = (s: string) => s.replace(/\s+/g, "");

describe("inline spans", () => {
  it("code spans, including escaped and doubled backticks", () => {
    expect(find(parseInline("run `task claim 22` now"), "code")?.text).toBe("task claim 22");
    // The bug the old terminal regex had: a backtick escaped inside code.
    expect(find(parseInline("the phrase `read \\`generation 1\\``-style"), "code")?.text).toBe(
      "read `generation 1`",
    );
    expect(find(parseInline("``a `b` c``"), "code")?.text).toBe("a `b` c");
    expect(kinds(parseInline("an ` unclosed tick"))).toEqual([]);
  });

  it("references: bare, typed by a word before them, ranges, and kind:id", () => {
    const spans = parseInline(
      "see task #22, note #23676, #181-#186 and board demo-scenarios #176/#188",
    );
    const refs = spans.filter((s) => s.kind === "ref") as Extract<Span, { kind: "ref" }>[];
    expect(refs.map((r) => [r.refKind, r.id, r.raw])).toEqual([
      ["task", "22", "task #22"],
      ["note", "23676", "note #23676"],
      [undefined, "181", "#181-#186"],
      ["board demo-scenarios", "176", "board demo-scenarios #176/#188"],
    ]);
    expect(find(parseInline("evidence task:22"), "ref")).toMatchObject({
      refKind: "task",
      id: "22",
    });
  });

  it("channels, mentions and URLs", () => {
    const spans = parseInline("@Critic in #general: https://example.com/a_(b). Done");
    expect(find(spans, "mention")?.name).toBe("Critic");
    expect(find(spans, "channel")?.name).toBe("general");
    expect(find(spans, "url")?.href).toBe("https://example.com/a_(b)");
    expect(kinds(parseInline("mail me at a@b.co"))).toEqual([]);
    expect(kinds(parseInline("color #ff8a70"))).toEqual([]);
  });

  it("verdicts by tone, shouted words, acronyms and identifiers", () => {
    const tone = (t: string) =>
      (find(parseInline(t), "verdict") as { tone: string } | undefined)?.tone;
    expect(tone("#21 REVIEWED AND APPROVED — ok")).toBe("good");
    expect(find(parseInline("#21 REVIEWED AND APPROVED — ok"), "verdict")?.raw).toBe(
      "REVIEWED AND APPROVED",
    );
    expect(tone("status: BLOCKED on review")).toBe("bad");
    expect(tone("result PARTIAL")).toBe("warn");
    expect(tone("PASS (non-blocking)")).toBe("good");
    expect(kinds(parseInline("a NEW note describes a FIELD"))).toEqual(["caps"]);
    expect(kinds(parseInline("the JSON and UUID of an API"))).toEqual([]);
    expect(kinds(parseInline("I said A thing"))).toEqual([]);
    expect(find(parseInline("set MARINA_AUTONOMY=open"), "code")?.text).toBe("MARINA_AUTONOMY");
  });

  it("asides, quotes, ids and key=value", () => {
    const spans = parseInline(
      'claimed (Builder, lease 895s) and got "Builder earned 1 standing." from request 03a35b94 with ok:false',
    );
    expect(spansText(find(spans, "aside")!.children)).toBe("Builder, lease 895s");
    expect(spansText(find(spans, "quote")!.children)).toBe("Builder earned 1 standing.");
    expect(find(spans, "id")?.raw).toBe("03a35b94");
    expect(find(spans, "kv")).toMatchObject({ key: "ok", sep: ":", value: "false" });
    // Enumerators and calls are not asides.
    expect(kinds(parseInline("(1) first and fn(x)"))).toEqual([]);
    // Refs inside an aside are still refs.
    expect(kinds(find(parseInline("text (#23693 + #23695) more"), "aside")!.children)).toEqual([
      "ref",
      "ref",
    ]);
  });

  it("strong and em", () => {
    const spans = parseInline("**Done:** shipped *today*");
    expect(spansText(find(spans, "strong")!.children)).toBe("Done:");
    expect(spansText(find(spans, "em")!.children)).toBe("today");
    expect(kinds(parseInline("2 * 3 * 4"))).toEqual([]);
  });
});

describe("blocks", () => {
  it("Markdown structure written with real line breaks", () => {
    const { blocks } = parseMessage(
      "## Status\nVerdict: PASS\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "table",
    ]);
    const para = blocks[1] as Extract<Block, { kind: "paragraph" }>;
    expect(spansRaw(para.label!)).toBe("Verdict:");
    const bullets = blocks[2] as Extract<Block, { kind: "list" }>;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items.map((i) => spansText(i.spans))).toEqual(["one", "two\ncontinued"]);
    const ordered = blocks[3] as Extract<Block, { kind: "list" }>;
    expect(ordered.items.map((i) => i.n)).toEqual([1, 2]);
    expect((blocks[5] as { text: string }).text).toBe("const x = 1;");
    expect((blocks[6] as Extract<Block, { kind: "table" }>).rows.length).toBe(1);
  });

  it("recovers an inline numbered list and labelled paragraphs from one long line", () => {
    const line =
      "Reviewed against the newer text, not the cited note. Two measured findings from my seat: 1. The cursor parameter is named cursor and is parsed by the service. 2. Staleness is not self-inflicted, another principal's write moved it. Not claimed: any conclusion about gate placement.";
    const { blocks } = parseMessage(line);
    // The sentence that introduces the list becomes its own lead-in line.
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "list", "paragraph"]);
    expect(spansText((blocks[1] as Extract<Block, { kind: "paragraph" }>).spans)).toBe(
      "Two measured findings from my seat:",
    );
    const list = blocks[2] as Extract<Block, { kind: "list" }>;
    expect(list.items.map((i) => i.n)).toEqual([1, 2]);
    expect(spansText(list.items[0]!.spans)).toStartWith("The cursor parameter");
    const last = blocks[3] as Extract<Block, { kind: "paragraph" }>;
    expect(spansRaw(last.label!)).toBe("Not claimed:");
  });

  it("a numbered item whose text starts with a label stays an item", () => {
    const line =
      "Reviewed the note against the newer text first. Two findings from my seat: 1. The cursor parameter is named cursor and is parsed (request 03a35b94). 2. Staleness is not self-inflicted: another write moved the generation. Not claimed: anything about gates.";
    const { blocks } = parseMessage(line);
    const list = blocks.find((b) => b.kind === "list") as Extract<Block, { kind: "list" }>;
    expect(list.items.map((i) => i.n)).toEqual([1, 2]);
    expect(spansRaw(list.items[1]!.label!)).toBe("Staleness is not self-inflicted:");
    const last = blocks.at(-1) as Extract<Block, { kind: "paragraph" }>;
    expect(spansRaw(last.label!)).toBe("Not claimed:");
  });

  it("an in-sentence (1) (2) (3) list ends with its sentence", () => {
    const line =
      "So your planned fix needs a new note that (1) quotes the offending phrase, (2) states field = value as you describe, and (3) names the superseded id explicitly. Two constraints bite on this pool specifically and they matter.";
    const { blocks } = parseMessage(line);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "paragraph"]);
    const list = blocks[1] as Extract<Block, { kind: "list" }>;
    expect(list.items.map((i) => i.marker)).toEqual(["(1)", "(2)", "(3)"]);
    expect(spansText((blocks[2] as Extract<Block, { kind: "paragraph" }>).spans)).toStartWith(
      "Two constraints",
    );
  });

  it("recovers '. - ' bullets", () => {
    const line =
      "Final status for the work pulse: DONE except the ledger close. - The note is immutable, so the in-place trim is unreachable. - The satisfiable path was a split into two successors. - Reviewed PASS by the critic.";
    const { blocks } = parseMessage(line);
    const list = blocks.find((b) => b.kind === "list") as Extract<Block, { kind: "list" }>;
    expect(list.items).toHaveLength(3);
    expect(list.items.every((i) => i.marker === "-")).toBe(true);
  });

  it("leaves short and ordinary prose alone", () => {
    expect(parseMessage("ok, merged it").blocks.map((b) => b.kind)).toEqual(["paragraph"]);
    const one = parseMessage("Version 2. It works. Use step 1. first.");
    expect(one.blocks.map((b) => b.kind)).toEqual(["paragraph"]);
    expect(parseMessage("x", { recover: false }).blocks).toHaveLength(1);
  });

  it("flags long messages for folding", () => {
    expect(parseMessage("short").fold).toBe(false);
    expect(parseMessage("word ".repeat(200)).fold).toBe(true);
    expect(parseMessage(Array.from({ length: 14 }, (_, i) => `- item ${i}`).join("\n")).fold).toBe(
      true,
    );
  });
});

describe("helpers", () => {
  it("mentions of the viewer, anywhere in the message", () => {
    const m = parseMessage("Status (for @operator): done");
    expect(messageMentions(m, "Operator")).toBe(true);
    expect(messageMentions(m, "bob")).toBe(false);
    expect(messageMentions(m, undefined)).toBe(false);
    expect(allSpans(m).some((s) => s.kind === "aside")).toBe(true);
  });

  it("excerpt is one line, cut with an ellipsis", () => {
    expect(excerpt("a\nb  c")).toBe("a b c");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("properties", () => {
  const alphabet = fc.constantFrom(
    ...'abcAB XYZ PASS BLOCKED #12 task #3 @Ann (aside) "q" `c` 1. 2. (1) (2) . - : ok:1 deadbeef9 ** * _ → https://x.io/p \n \n\n | > - # ``` é 中'.split(
      " ",
    ),
    " ",
    "\n",
  );
  const message = fc.array(alphabet, { maxLength: 60 }).map((parts) => parts.join(" "));

  it("never throws, on any string at all", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        parseMessage(s);
      }),
      propertyOptions(300),
    );
    fc.assert(
      fc.property(message, (s) => {
        parseMessage(s);
      }),
      propertyOptions(300),
    );
  });

  it("a one-line message loses and reorders no character", () => {
    const line = message.map((s) => `x ${s.replace(/\n/g, " ")}`);
    fc.assert(
      fc.property(line, (s) => {
        const source = parseMessage(s).blocks.map(blockSource).join("");
        expect(nonWs(source)).toBe(nonWs(s));
      }),
      propertyOptions(400),
    );
  });

  it("inline raws concatenate back to the input exactly", () => {
    fc.assert(
      fc.property(fc.oneof(message, fc.string({ maxLength: 200 })), (s) => {
        expect(spansRaw(parseInline(s))).toBe(s);
      }),
      propertyOptions(400),
    );
  });

  it("parsing is deterministic", () => {
    fc.assert(
      fc.property(message, (s) => {
        expect(parseMessage(s)).toEqual(parseMessage(s));
      }),
      propertyOptions(100),
    );
  });
});

describe("Markdown links", () => {
  it("reads [label](https://…) as one link span that keeps every character", () => {
    const text =
      "See the [Commission factpage](https://digital-strategy.ec.europa.eu/en/x_(y)) now.";
    const spans = parseInline(text);
    const link = spans.find((s) => s.kind === "url");
    expect(link).toMatchObject({
      kind: "url",
      label: "Commission factpage",
      href: "https://digital-strategy.ec.europa.eu/en/x_(y)",
    });
    expect(spansRaw(spans)).toBe(text);
    expect(spansText(spans)).toBe("See the Commission factpage now.");
  });

  it("never links a non-http target", () => {
    const spans = parseInline("[click](javascript:alert(1)) and [x](data:text/html,hi)");
    expect(spans.some((s) => s.kind === "url")).toBe(false);
  });
});

describe("hasMarkdown", () => {
  it("is true for headings, bold, links and fences", () => {
    expect(hasMarkdown("## 1. Enforcement started")).toBe(true);
    expect(hasMarkdown("You chose **Vendor B**.")).toBe(true);
    expect(hasMarkdown("([FAQ](https://example.com/faq))")).toBe(true);
    expect(hasMarkdown("```ts\nx\n```")).toBe(true);
  });

  it("is false for preformatted command output", () => {
    expect(hasMarkdown('Tools on "deepwiki"\n  read_wiki_contents — View docs')).toBe(false);
    expect(hasMarkdown("#12 [score=1.35 imp=6] (Builder): Task #1 launch plan")).toBe(false);
    expect(hasMarkdown("a * b * c")).toBe(false);
  });
});

describe("abbreviations are not sentence ends", () => {
  const labels = (text: string) =>
    parseMessage(text)
      .blocks.filter((b) => b.kind === "paragraph" && b.label)
      .map((b) => (b.kind === "paragraph" && b.label ? spansText(b.label) : ""));

  it("keeps a figure after U.S. in one paragraph, with no label", () => {
    const cpi =
      "2026-09-01 — FRED CPIAUCSL (Consumer Price Index for All Urban Consumers: All Items in U.S. City Average): 336.298 Index 1982-1984=100 for 2026-09-01, as published by 2026-11-06";
    expect(parseMessage(cpi).blocks).toHaveLength(1);
    expect(labels(cpi)).toEqual([]);
  });

  it("does not split after e.g., i.e., vs. or Inc.", () => {
    for (const abbr of ["e.g.", "i.e.", "vs.", "Inc."]) {
      const text = `The comparison we ran across the three vendors this quarter used ${abbr} Main Result: a flat curve for every region we priced.`;
      expect(labels(text)).toEqual([]);
    }
  });

  it("still starts a labelled paragraph after a real sentence end", () => {
    const text =
      "We reviewed the memo end to end for the board and the auditors this week. Next step: send it to legal for the final read before Friday.";
    expect(labels(text)).toEqual(["Next step:"]);
  });
});
