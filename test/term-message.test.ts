// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Messages in the terminal (`marina connect`): the shared grammar laid out
// as lines, a bar in the sender's colour, grouping, mentions of you, day
// rules, `channel history` as a conversation, and command output that keeps
// the server's own colours.

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Conversation } from "../scripts/connect-repl";
import type { TermCaps } from "../scripts/term-caps";
import { messageLines, paintSpans } from "../scripts/term-message";
import { decorate, MESSAGE_MEASURE, renderPerception } from "../scripts/term-render";
import { plainText } from "../scripts/term-sanitize";
import { createTheme } from "../scripts/term-theme";
import type { Perception } from "../src/sdk/client";
import { parseInline } from "../src/sdk/message-format";

const caps = (over: Partial<TermCaps> = {}): TermCaps => ({
  color: 3,
  unicode: true,
  links: false,
  background: "dark",
  columns: 120,
  ...over,
});
const theme = createTheme(caps());
const plain = createTheme(caps({ color: 0 }));
const ESC = "\x1b";
const at = Date.UTC(2026, 10, 4, 15, 0);

const channelMsg = (sender: string, message: string, timestamp = at): Perception =>
  ({
    kind: "message",
    tag: "channel",
    timestamp,
    data: { senderName: sender, message, channel: "general", text: message },
  }) as Perception;

const long =
  "Reviewed against the newer text, not the cited note. Two findings from my seat: 1. The cursor parameter is named cursor and is parsed by the service. 2. Staleness is not self-inflicted, another write moved it. Not claimed: any conclusion about gate placement.";

describe("message bodies", () => {
  const opts = { theme, width: 120, self: "Ann" };

  test("a long message: header, then a bar in the sender's colour on every body line", () => {
    const lines = renderPerception(channelMsg("Critic", long), opts, { own: false });
    expect(plainText(lines[0]!)).toMatch(/^● Critic #general {2}\d\d:\d\d$/);
    const body = lines.slice(1).map(plainText);
    expect(body.every((l) => l.startsWith("▎ "))).toBe(true);
    expect(body).toContain(
      "▎ 1. The cursor parameter is named cursor and is parsed by the service.",
    );
    expect(body.some((l) => l.startsWith("▎ Not claimed: any conclusion"))).toBe(true);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(MESSAGE_MEASURE + 2);
  });

  test("verdicts are chips in messages and keep their words", () => {
    const lines = renderPerception(channelMsg("Critic", "#21 REVIEWED AND APPROVED — done"), opts, {
      own: false,
    });
    expect(lines[0]).toContain(`${ESC}[1;7;${theme.params("success")}m REVIEWED AND APPROVED `);
  });

  test("a message that names you is flagged and its mention highlighted", () => {
    const lines = renderPerception(channelMsg("Builder", `@Ann ${long}`), opts, { own: false });
    expect(plainText(lines[0]!)).toContain("◂ you");
    expect(lines[1]).toContain(`${ESC}[1;7;${theme.params("warning")}m @Ann `);
    expect(lines[1]!.startsWith(theme.fg("warning")("▎"))).toBe(true);
  });

  test("continued messages from one sender drop the header", () => {
    const conv = new Conversation(() => opts);
    const first = conv.render(channelMsg("Critic", long));
    const second = conv.render(channelMsg("Critic", long, at + 60_000));
    expect(plainText(first[0]!)).toContain("● Critic");
    expect(plainText(second[0]!)).toStartWith("▎ ");
    conv.reset();
    expect(plainText(conv.render(channelMsg("Critic", long, at + 120_000))[0]!)).toContain(
      "● Critic",
    );
    const other = conv.render(channelMsg("Builder", long, at + 130_000));
    expect(plainText(other[0]!)).toContain("● Builder");
  });

  test("a new day gets a rule between messages", () => {
    const conv = new Conversation(() => opts);
    conv.render(channelMsg("Critic", "hi"));
    const next = conv.render(channelMsg("Critic", "next day", at + 86_400_000));
    expect(plainText(next[0]!)).toMatch(/^── .+ ──+$/);
  });

  test("channel history renders as a conversation", () => {
    const p = {
      kind: "message",
      timestamp: at,
      data: {
        text: "History: general\n  Critic: hi",
        channelHistory: {
          channel: "general",
          messages: [
            { senderName: "Critic", content: "first", createdAt: at },
            { senderName: "Critic", content: long, createdAt: at + 1000 },
            { senderName: "Builder", content: "ok", createdAt: at + 2000 },
          ],
        },
      },
    } as Perception;
    const text = renderPerception(p, opts, { own: true }).map(plainText);
    expect(text[0]).toBe("#general");
    expect(text.filter((l) => l.includes("● Critic"))).toHaveLength(1);
    expect(text.some((l) => l.startsWith("● Builder"))).toBe(true);
  });

  test("with colour off a message is its text, markers kept, no escapes", () => {
    const lines = messageLines("**Done:** run `look` (now)", plain, { chips: true }, { width: 80 });
    expect(lines).toEqual(["**Done:** run `look` (now)"]);
    const rendered = renderPerception(
      channelMsg("Critic", long),
      { ...opts, theme: plain },
      {
        own: false,
      },
    );
    expect(rendered.join("")).not.toContain(ESC);
  });
});

describe("command output", () => {
  test("verdict colours apply only where the server set no colour", () => {
    const bare = decorate("status PASS", theme);
    expect(bare).toContain(theme.params("success"));
    const coloured = decorate(`${ESC}[36mstatus PASS${ESC}[0m`, theme);
    expect(coloured).not.toContain(theme.params("success"));
  });

  test("a Markdown link shows its label and, without terminal links, its address", () => {
    const plain = paintSpans(parseInline("see [the FAQ](https://example.com/faq)"), theme, {});
    expect(plain).toContain("the FAQ");
    expect(plain).toContain("(https://example.com/faq)");
    expect(plain).not.toContain("[the FAQ]");
    const linked = paintSpans(parseInline("see [the FAQ](https://example.com/faq)"), theme, {
      link: (label, url) => `<${label}|${url}>`,
    });
    expect(linked).toContain("<the FAQ|https://example.com/faq>");
  });

  test("an aside's colour comes back after a ref inside it", () => {
    const out = paintSpans(parseInline("x (see #12 now) y"), theme, {});
    const muted = `${ESC}[${theme.params("muted")}m`;
    expect(out).toContain(`${muted}(see `);
    expect(out).toContain(`${ESC}[0m${muted} now)`);
  });
});
