// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { busyLabel } from "../scripts/connect-repl";
import {
  colorChoiceFromArgs,
  colorLevel,
  type TermCaps,
  termCaps,
  unicodeSupported,
} from "../scripts/term-caps";
import { card, PANELS } from "../scripts/term-panels";
import { parseFormat, renderFormat, type SegmentContext } from "../scripts/term-prompt";
import { looksLikeMarkdown, renderPerception, wrap } from "../scripts/term-render";
import { plainText, sanitizeServerText } from "../scripts/term-sanitize";
import { createTheme, gradientAt, nameHash, PALETTES, to256 } from "../scripts/term-theme";
import type { Perception } from "../src/sdk/client";

const caps = (over: Partial<TermCaps> = {}): TermCaps => ({
  color: 3,
  unicode: true,
  links: false,
  background: "dark",
  columns: 80,
  ...over,
});
const truecolor = createTheme(caps());
const plain = createTheme(caps({ color: 0 }));
const ESC = "\x1b";

describe("terminal capabilities", () => {
  const tty = { isTTY: true };
  test("NO_COLOR, FORCE_COLOR, CLICOLOR_FORCE, TERM=dumb and pipes", () => {
    expect(colorLevel(tty, { COLORTERM: "truecolor" })).toBe(3);
    expect(colorLevel(tty, { TERM: "xterm-256color" })).toBe(2);
    expect(colorLevel(tty, { NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(0);
    // An empty NO_COLOR does not disable colour (no-color.org).
    expect(colorLevel(tty, { NO_COLOR: "", TERM: "xterm-256color" })).toBe(2);
    expect(colorLevel({ isTTY: false }, { COLORTERM: "truecolor" })).toBe(0);
    expect(colorLevel({ isTTY: false }, { FORCE_COLOR: "2" })).toBe(2);
    expect(colorLevel(tty, { FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe(0);
    expect(colorLevel({ isTTY: false }, { CLICOLOR_FORCE: "1", TERM: "xterm" })).toBe(1);
    expect(colorLevel(tty, { TERM: "dumb" })).toBe(0);
  });

  test("an explicit --color choice wins over the environment", () => {
    expect(colorChoiceFromArgs(["me", "--color", "never"])).toBe("never");
    expect(colorChoiceFromArgs(["--color=always"])).toBe("always");
    expect(colorChoiceFromArgs(["--no-color"])).toBe("never");
    expect(colorChoiceFromArgs(["me"])).toBeUndefined();
    expect(colorLevel(tty, { COLORTERM: "truecolor" }, "never")).toBe(0);
    expect(colorLevel({ isTTY: false }, { NO_COLOR: "1" }, "always")).toBeGreaterThan(0);
  });

  test("unicode follows the locale; the Linux console and MARINA_ASCII get ASCII", () => {
    expect(unicodeSupported({ LANG: "en_US.UTF-8" }, "linux")).toBe(true);
    expect(unicodeSupported({ LANG: "C" }, "linux")).toBe(false);
    expect(unicodeSupported({ TERM: "linux", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
    expect(unicodeSupported({ MARINA_ASCII: "1", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
  });

  test("COLORFGBG and MARINA_THEME pick the light palette", () => {
    expect(termCaps(tty, { COLORFGBG: "0;15" }).background).toBe("light");
    expect(termCaps(tty, { COLORFGBG: "15;0" }).background).toBe("dark");
    expect(termCaps(tty, { MARINA_THEME: "harbor-light" }).background).toBe("light");
  });
});

describe("theme", () => {
  test("colours degrade by depth: truecolor, nearest 256, a fixed 16-colour code", () => {
    expect(truecolor.fg("error")("x")).toBe(`${ESC}[38;2;242;102;122mx${ESC}[0m`);
    expect(createTheme(caps({ color: 2 })).fg("error")("x")).toBe(
      `${ESC}[38;5;${to256("#f2667a")}mx${ESC}[0m`,
    );
    expect(createTheme(caps({ color: 1 })).fg("error")("x")).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(plain.fg("error")("x")).toBe("x");
    expect(plain.gradient("marina")).toBe("marina");
  });

  test("body text stays in the terminal's own foreground", () => {
    expect(truecolor.params("text")).toBe("39");
  });

  test("the ansi palette never emits more than 16 colours", () => {
    const ansi = createTheme(caps(), PALETTES.ansi);
    expect(ansi.fg("accent")("x")).toBe(`${ESC}[36mx${ESC}[0m`);
  });

  test("to256, gradients and identity colours are deterministic", () => {
    expect(to256("#000000")).toBe(16);
    expect(to256("#ffffff")).toBe(231);
    expect(to256("#808080")).toBeGreaterThanOrEqual(232);
    expect(gradientAt(["#000000", "#ffffff"], 0)).toBe("#000000");
    expect(gradientAt(["#000000", "#ffffff"], 1)).toBe("#ffffff");
    expect(nameHash("Ada")).toBe(nameHash("Ada"));
    expect(truecolor.identity("Ada")("Ada")).toBe(truecolor.identity("Ada")("Ada"));
  });
});

describe("server text is data, never terminal instructions", () => {
  const hostile =
    `hello ${ESC}[31mred${ESC}[0m ${ESC}]0;pwned${ESC}\\ title ${ESC}]52;c;aGk=\x07 clip ` +
    `${ESC}[2J${ESC}[H clear \x9b31m c1 ${ESC}[8mhidden${ESC}[0m ${ESC}[41mbg${ESC}[0m \u202eevil\x07\r`;

  test("only vetted SGR survives, re-expressed in the theme", () => {
    const out = sanitizeServerText(hostile, truecolor);
    expect(out).not.toContain(`${ESC}]`);
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[H`);
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain(`${ESC}[8m`);
    expect(out).not.toContain(`${ESC}[41m`);
    expect(out).not.toContain("\u202e");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\r");
    // Red is the theme's error colour, not the server's raw 31.
    expect(out).toContain(`${ESC}[38;2;242;102;122mred`);
    expect(plainText(out)).toBe("hello red  title  clip  clear  c1 hidden bg evil");
  });

  test("with colour off nothing but printable text, newlines and tabs remains", () => {
    const out = sanitizeServerText(`${hostile}\n\tnext`, plain);
    expect(out).not.toContain(ESC);
    expect(out.endsWith("\n\tnext")).toBe(true);
  });

  test("a participant's colour never bleeds past its text", () => {
    expect(sanitizeServerText(`${ESC}[31munclosed`, truecolor).endsWith(`${ESC}[0m`)).toBe(true);
  });

  test("server entity colours map onto the client's identity palette", () => {
    const out = sanitizeServerText(`${ESC}[1m${ESC}[38;5;75mAda${ESC}[0m says: hi`, truecolor);
    expect(out).toContain("38;2;");
    expect(out).not.toContain("38;5;75");
  });
});

const message = (over: Partial<Perception>): Perception =>
  ({ kind: "message", timestamp: Date.UTC(2026, 9, 21, 14, 2), data: {}, ...over }) as Perception;

describe("perception rendering", () => {
  const opts = { theme: truecolor, width: 80, self: "Jeff" };

  test("your command's result hangs off ⎿ and continues under it", () => {
    const lines = renderPerception(message({ data: { text: "Open Tasks\n#17 review" } }), opts, {
      own: true,
    });
    expect(plainText(lines[0]!)).toBe("  ⎿  Open Tasks");
    expect(plainText(lines[1]!)).toBe("     #17 review");
  });

  test("a refused command is marked ✗ in the error colour", () => {
    const lines = renderPerception(message({ data: { text: "Unknown command: frob" } }), opts, {
      own: true,
      failed: true,
    });
    expect(plainText(lines[0]!)).toBe("  ⎿  ✗ Unknown command: frob");
    expect(lines[0]).toContain("38;2;242;102;122");
  });

  test("speech from another participant: ● name, message, time on one line", () => {
    const lines = renderPerception(
      message({
        tag: "say",
        data: { text: "Ada says: hi", senderName: "Ada", message: "hi there" },
      }),
      opts,
      { own: false },
    );
    expect(lines).toHaveLength(1);
    expect(plainText(lines[0]!)).toMatch(/^● Ada {2}hi there +\d\d:\d\d$/);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
  });

  test("a private tell is ◆ name → you; agents get ✦", () => {
    const tell = renderPerception(
      message({ tag: "tell", data: { senderName: "Ada", message: "psst" } }),
      opts,
      { own: false },
    );
    expect(plainText(tell[0]!)).toMatch(/^◆ Ada → you {2}psst/);
    const agent = renderPerception(
      message({ tag: "say", data: { senderName: "Scout", message: "claimed" } }),
      { ...opts, isAgent: (n) => n === "Scout" },
      { own: false },
    );
    expect(plainText(agent[0]!)).toMatch(/^✦ Scout agent {2}claimed/);
  });

  test("a hostile sender name or message cannot smuggle escapes through speech", () => {
    const lines = renderPerception(
      message({ tag: "say", data: { senderName: `Ada${ESC}]0;x\x07`, message: `${ESC}[2Jhi` } }),
      opts,
      { own: false },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain(`${ESC}]`);
    expect(joined).not.toContain(`${ESC}[2J`);
  });

  test("presence is faint scenery; movement uses arrows", () => {
    const join = renderPerception(
      message({ tag: "connect", data: { text: "Ada connects." } }),
      opts,
      { own: false },
    );
    expect(plainText(join[0]!)).toBe("  → Ada connects");
    const leave = renderPerception(
      {
        kind: "movement",
        timestamp: 0,
        data: { entity: "Ada", direction: "leave", exit: "north" },
      } as Perception,
      opts,
      { own: false },
    );
    expect(plainText(leave[0]!)).toBe("  ← Ada leaves north");
  });

  test("Markdown in a message is rendered; server-styled output never is", () => {
    expect(looksLikeMarkdown("## Plan\n\n- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("```ts\nconst x = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown(`${ESC}[1m## not markdown${ESC}[0m`)).toBe(false);
    expect(looksLikeMarkdown("plain sentence")).toBe(false);
    const lines = renderPerception(
      message({ tag: "tell", data: { senderName: "Ada", message: "## Plan\n\n- **one**\n- two" } }),
      opts,
      { own: false },
    );
    const text = lines.map(plainText).join("\n");
    expect(text).toContain("Plan");
    expect(text).not.toContain("**");
    expect(text).not.toContain("## ");
  });

  test("inline code, refs and status glyphs are styled, including inside server colour", () => {
    const [line] = renderPerception(
      message({ data: { text: `${ESC}[2m  ✓ run \`look\` for task:41${ESC}[0m` } }),
      opts,
      { own: true },
    );
    expect(plainText(line!)).toBe("  ⎿    ✓ run look for task:41");
    expect(line).toContain(truecolor.params("code"));
    expect(line).toContain(truecolor.params("success"));
  });

  test("rule-only lines stretch to the content width", () => {
    const lines = renderPerception(message({ data: { text: `Head\n${"─".repeat(40)}` } }), opts, {
      own: true,
    });
    expect(visibleWidth(lines[1]!)).toBe(80);
  });

  test("wrapping keeps a list line's hanging indent and never exceeds the width", () => {
    const lines = wrap(`  - ${"word ".repeat(40)}`, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    expect(lines[1]!.startsWith("    ")).toBe(true);
    const prose = wrap("word ".repeat(40), 40);
    expect(prose[1]!.startsWith(" ")).toBe(false);
  });

  test("with colour off the rendered lines carry no escapes", () => {
    const lines = renderPerception(
      message({ tag: "say", data: { senderName: "Ada", message: "hi `x`" } }),
      { ...opts, theme: plain },
      { own: false },
    );
    expect(lines.join("")).not.toContain(ESC);
  });

  test("ASCII glyphs replace Unicode where it is unsupported", () => {
    const ascii = createTheme(caps({ unicode: false }));
    const lines = renderPerception(
      message({ data: { text: "ok" } }),
      { ...opts, theme: ascii },
      { own: true },
    );
    expect(plainText(lines[0]!)).toBe("  `  ok");
  });
});

const context = (over: Partial<SegmentContext> = {}): SegmentContext => ({
  theme: truecolor,
  name: "Jeff",
  connected: true,
  queued: 0,
  snapshot: {
    at: {},
    health: {
      status: "ok",
      uptimeMs: 3_600_000,
      connections: 3,
      agents: 2,
      tickAgoMs: 40,
      tickErrors: 0,
    },
    system: {
      rooms: 5,
      entities: { total: 4, agents: 2, npcs: 0 },
      tasks: { open: 7, claimed: 1, submitted: 2, completed: 9 },
      projects: 1,
      connectors: 0,
    },
    ops: {
      scope: "privileged",
      agents: [
        {
          name: "Scout",
          state: "autonomous",
          health: null,
          role: "scout",
          model: "marina/default",
          uptimeMs: 60_000,
          toolCalls: 3,
          tokens: { input: 1200, output: 300 },
          cost: { totalUsd: 0.12, lastHourUsd: 0.12 },
          consecutiveErrors: 0,
          paused: null,
        },
      ],
      spend: {
        todayUsd: 4,
        capUsd: 10,
        lastHourUsd: 1,
        scopes: [{ scope: "agents", spentUsd: 4 }],
      },
    },
    alerts: [
      {
        severity: "warning",
        title: "Held",
        detail: "",
        remedy: null,
        attention: "approval",
        occurrences: 1,
      },
      {
        severity: "critical",
        title: "Down",
        detail: "x",
        remedy: "fix",
        attention: null,
        occurrences: 2,
      },
    ],
    profile: { rank: 2, standing: 12.5, kind: "person", achievements: 1, actions: 10, gates: 3 },
  },
  room: "Workbench",
  here: 2,
  cwd: "/tmp",
  ...over,
});

describe("starship-style formats", () => {
  test("segments, styles and optional groups", () => {
    const c = context();
    expect(plainText(renderFormat("$room $character ", c))).toBe("Workbench ❯ ");
    expect(plainText(renderFormat("($room)( · $queued)", c))).toBe("Workbench");
    expect(plainText(renderFormat("($room)( · $queued)", context({ queued: 2 })))).toBe(
      "Workbench · 2 queued",
    );
    expect(renderFormat("[$room](bold #ff0000)", c)).toBe(
      `${ESC}[1;38;2;255;0;0mWorkbench${ESC}[0m`,
    );
    expect(renderFormat("\\$room \\[x\\]", c)).toBe("$room [x]");
    // Unknown segments render nothing; unbalanced brackets are literal.
    expect(renderFormat("a$nope b", c)).toBe("a b");
    expect(plainText(renderFormat("[oops $room", c))).toBe("[oops Workbench");
    expect(parseFormat("(x)")).toEqual([
      { kind: "optional", children: [{ kind: "text", text: "x" }] },
    ]);
  });

  test("live segments read the snapshot", () => {
    const c = context();
    const seg = (name: string) => plainText(renderFormat(`$${name}`, c));
    expect(seg("agents")).toBe("✦ 1 agent");
    expect(seg("tasks")).toBe("◇ 7 open 2 to review");
    // Without the holds endpoint, an operator's approval alerts still count.
    expect(seg("approvals")).toBe("⚑ 1 to approve");
    expect(seg("held")).toBe("");
    expect(seg("alerts")).toBe("✗ 1 alert");
    expect(seg("spend")).toMatch(/^\$4\.00\/\$10\.00 /);
    expect(seg("standing")).toBe("◈ 12.5 r2");
    expect(seg("health")).toBe("● live");
    expect(seg("cwd")).toBe("/tmp");
  });

  test("held actions come from the caller's own holds", () => {
    const c = context();
    const hold = {
      token: "t1",
      kind: "gate",
      requester: "Ada",
      summary: "x",
      reason: "y",
      expiresAt: 0,
    };
    c.snapshot.challenges = { answerable: [hold, hold], raised: [hold] };
    expect(plainText(renderFormat("$approvals", c))).toBe("⚑ 2 to approve");
    expect(plainText(renderFormat("$held", c))).toBe("⧗ 1 held");
    c.snapshot.challenges = { answerable: [], raised: [] };
    expect(renderFormat("($approvals)($held)", c)).toBe("");
  });

  test("the chevron turns red after a refused command; took appears past 2 s", () => {
    const failed = context({ last: { ok: false, ms: 3_400 } });
    expect(renderFormat("$character", failed)).toContain(truecolor.params("error"));
    expect(plainText(renderFormat("$took", failed))).toBe("took 3.4s");
    expect(renderFormat("$took", context({ last: { ok: true, ms: 300 } }))).toBe("");
  });

  test("a stalled or disconnected world is said in words, not colour alone", () => {
    const stalled = context();
    stalled.snapshot.health = { ...stalled.snapshot.health!, tickAgoMs: 60_000 };
    expect(plainText(renderFormat("$health", stalled))).toBe("✗ stalled");
    expect(plainText(renderFormat("$connection", context({ connected: false })))).toBe("○ offline");
  });
});

describe("panels", () => {
  test("every panel renders inside its card, with data and without", () => {
    for (const panel of PANELS) {
      for (const c of [context(), context({ snapshot: { at: {} } })]) {
        const lines = panel.render(c);
        expect(lines.length).toBeGreaterThan(2);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
        expect(plainText(lines[0]!).startsWith("╭─")).toBe(true);
        expect(plainText(lines.at(-1)!).startsWith("╰")).toBe(true);
      }
    }
  });

  test("a card truncates long lines rather than breaking its border", () => {
    const narrow = createTheme(caps({ columns: 40 }));
    for (const line of card(narrow, "T", ["x".repeat(200)])) expect(visibleWidth(line)).toBe(40);
  });

  test("busy lines use plain verbs", () => {
    expect(busyLabel("ask what now")).toBe("Asking…");
    expect(busyLabel("frob x")).toBe("Running frob…");
  });
});
