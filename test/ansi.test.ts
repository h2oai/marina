import { describe, expect, it } from "bun:test";
import {
  A,
  arrival,
  boardTag,
  bold,
  category,
  channel,
  channelSelf,
  connects,
  departure,
  dim,
  disconnects,
  emote,
  entity,
  error,
  exits,
  header,
  id,
  npcSays,
  rank,
  roomTitle,
  say,
  saySelf,
  separator,
  shout,
  shoutSelf,
  status,
  success,
  tell,
} from "../src/net/ansi";
import { stripAnsi } from "./helpers";

describe("ANSI Utilities", () => {
  // ─── Entity name coloring ──────────────────────────────────────────────────

  describe("entity()", () => {
    it("returns deterministic color for the same name", () => {
      expect(entity("Alice")).toBe(entity("Alice"));
    });

    it("strips to just the name", () => {
      expect(stripAnsi(entity("Alice"))).toBe("Alice");
    });

    it("includes bold escape", () => {
      expect(entity("Alice")).toContain(A.bold);
    });

    it("includes reset escape", () => {
      expect(entity("Alice")).toContain(A.reset);
    });

    it("assigns different colors to different names", () => {
      const names = [
        "Alice",
        "Bob",
        "Charlie",
        "Diana",
        "Eve",
        "Frank",
        "Grace",
        "Hank",
        "Ivy",
        "Jack",
      ];
      const colors = new Set(names.map((n) => entity(n)));
      expect(colors.size).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── Semantic formatting ───────────────────────────────────────────────────

  describe("semantic functions", () => {
    const semanticCases: [string, (t: string) => string, string, string[]][] = [
      ["header", header, "Title", [A.bold, A.cyan]],
      ["category", category, "Label", [A.bold, A.yellow]],
      ["dim", dim, "muted", [A.dim]],
      ["bold", bold, "strong", [A.bold]],
      ["success", success, "ok", [A.green]],
      ["error", error, "fail", [A.red]],
    ];

    for (const [name, fn, input, codes] of semanticCases) {
      it(`${name}() contains expected codes and strips cleanly`, () => {
        const result = fn(input);
        for (const code of codes) expect(result).toContain(code);
        expect(stripAnsi(result)).toBe(input);
      });
    }

    it("id() → bold yellow #N", () => {
      const i = id(42);
      expect(i).toContain(A.bold);
      expect(i).toContain(A.yellow);
      expect(stripAnsi(i)).toBe("#42");
    });

    it("separator() → dim line of given width", () => {
      expect(separator(20)).toContain(A.dim);
      expect(stripAnsi(separator(20))).toBe("─".repeat(20));
    });

    it("separator() defaults to 40", () => {
      expect(stripAnsi(separator())).toBe("─".repeat(40));
    });

    const statusCases: [string, "active" | "done" | "fail" | "info" | "warn", string][] = [
      ["ACTIVE", "active", A.green],
      ["DONE", "done", A.brightGreen],
      ["FAIL", "fail", A.red],
      ["INFO", "info", A.cyan],
      ["WARN", "warn", A.yellow],
    ];

    for (const [label, variant, code] of statusCases) {
      it(`status("${label}", "${variant}") → colored badge`, () => {
        expect(stripAnsi(status(label, variant))).toBe(`[${label}]`);
        expect(status(label, variant)).toContain(code);
      });
    }

    const rankCases: [number, string, string | null][] = [
      [0, "[Newcomer]", A.brightBlack],
      [1, "[Canvas]", null],
      [2, "[Coordinator]", A.cyan],
      [3, "[Organizer]", A.green],
      [4, "[Builder]", A.green],
    ];

    for (const [level, text, code] of rankCases) {
      it(`rank(${level}) → ${text}`, () => {
        expect(stripAnsi(rank(level))).toBe(text);
        if (code) expect(rank(level)).toContain(code);
      });
    }
  });

  // ─── Communication formatters ─────────────────────────────────────────────

  describe("communication", () => {
    const simpleCases: [string, () => string, string][] = [
      ["say", () => say("Alice", "hello"), "Alice says: hello"],
      ["saySelf", () => saySelf("hello"), "You say: hello"],
      ["tell from", () => tell("Alice", "secret", "from"), "> Alice tells you: secret"],
      ["tell to", () => tell("Alice", "secret", "to"), "> You tell Alice: secret"],
      ["shout", () => shout("Bob", "HEY"), "Bob shouts: HEY"],
      ["shoutSelf", () => shoutSelf("HEY"), "You shout: HEY"],
      ["emote", () => emote("Alice", "waves"), "* Alice waves"],
      ["channel", () => channel("general", "Alice", "hello"), "[general] Alice: hello"],
      ["channelSelf", () => channelSelf("general", "hello"), "[general] You: hello"],
      ["npcSays", () => npcSays("Guide", "Welcome!"), 'Guide says: "Welcome!"'],
    ];

    for (const [name, fn, expected] of simpleCases) {
      it(`${name}() strips to '${expected}'`, () => {
        expect(stripAnsi(fn())).toBe(expected);
      });
    }

    it("saySelf() is dim", () => {
      expect(saySelf("hello")).toContain(A.dim);
    });

    it("shout() is bright yellow", () => {
      expect(shout("Bob", "HEY")).toContain(A.brightYellow);
    });

    it("emote() is italic cyan", () => {
      expect(emote("Alice", "waves")).toContain(A.italic);
      expect(emote("Alice", "waves")).toContain(A.cyan);
    });

    it("channel() is green", () => {
      expect(channel("general", "Alice", "hello")).toContain(A.green);
    });

    it("npcSays() is magenta", () => {
      expect(npcSays("Guide", "Welcome!")).toContain(A.magenta);
    });
  });

  // ─── Movement formatters ──────────────────────────────────────────────────

  describe("movement", () => {
    const movementCases: [string, () => string, string, string[]][] = [
      ["arrival", () => arrival("Alice"), "Alice arrives.", [A.dim, A.italic]],
      ["departure", () => departure("Alice", "north"), "Alice leaves north.", []],
      ["connects", () => connects("Alice"), "Alice connects.", [A.green]],
      ["disconnects", () => disconnects("Alice"), "Alice disconnects.", [A.red]],
    ];

    for (const [name, fn, expected, codes] of movementCases) {
      it(`${name}() strips to '${expected}'`, () => {
        expect(stripAnsi(fn())).toBe(expected);
        for (const code of codes) expect(fn()).toContain(code);
      });
    }
  });

  // ─── Room formatters ──────────────────────────────────────────────────────

  describe("room", () => {
    const roomCases: [string, () => string, string, string][] = [
      ["roomTitle", () => roomTitle("The Nexus"), "The Nexus", A.cyan],
      ["exits", () => exits("north, south"), "Exits: north, south", A.yellow],
      ["boardTag", () => boardTag("general"), "[Boards: general]", A.magenta],
    ];

    for (const [name, fn, expected, code] of roomCases) {
      it(`${name}() strips to '${expected}'`, () => {
        expect(stripAnsi(fn())).toBe(expected);
        expect(fn()).toContain(code);
      });
    }
  });
});
