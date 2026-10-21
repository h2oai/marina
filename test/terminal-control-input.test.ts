// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { stripAnsi, stripControlSequences } from "../src/net/ansi";
import { createTestEngine } from "./engine-fixture";

const ESC = "\x1b";
const HOSTILE =
  `hi ${ESC}[31mred${ESC}[0m ${ESC}]0;pwned\x07title ${ESC}]52;c;aGk=${ESC}\\clip ` +
  `${ESC}[2J${ESC}[Hclear \x9b31mc1 ${ESC}(Bcs ${ESC}]8;;https://evil${ESC}\\link‮flip lone\rcr`;

describe("stripControlSequences", () => {
  test("removes every escape sequence and control byte, whole", () => {
    const out = stripControlSequences(HOSTILE);
    expect(out).toBe("hi red title clip clear c1 cs linkflip lonecr");
  });

  test("keeps newline, tab and CRLF", () => {
    expect(stripControlSequences("a\nb\tc\r\nd")).toBe("a\nb\tc\r\nd");
  });

  test("keepSgr keeps the server's own colour and nothing else", () => {
    const out = stripControlSequences(HOSTILE, { keepSgr: true });
    expect(out).toContain(`${ESC}[31mred${ESC}[0m`);
    expect(stripAnsi(out)).toBe(stripControlSequences(HOSTILE));
  });

  test("an unterminated string sequence swallows the rest rather than leaking it", () => {
    expect(stripControlSequences(`ok ${ESC}]0;never-closed`)).toBe("ok ");
  });
});

describe("command input reaching other participants", () => {
  let dispose: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  test("a say from one transport reaches others with no terminal controls", async () => {
    const world = createTestEngine();
    dispose = world.dispose;
    const ada = world.login("Ada");
    const bob = world.login("Bob");
    bob.connection.messages.length = 0;
    await world.engine.dispatchCommand(ada.entityId, `say ${HOSTILE}`);
    const heard = bob.connection.messages.filter((p) => p.tag === "say");
    expect(heard.length).toBe(1);
    const text = (heard[0]!.data as { text: string }).text;
    expect(stripAnsi(text)).toBe("Ada says: hi red title clip clear c1 cs linkflip lonecr");
    // The server's own styling of the speaker's name is the only SGR left.
    for (const banned of [`${ESC}]`, `${ESC}[2J`, `${ESC}[H`, "\x9b", "\u202e", "\r", `${ESC}[31m`])
      expect(text).not.toContain(banned);
  });
});
