// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import {
  inputGuidance,
  terminalCompletion,
  terminalCompletionFor,
} from "../scripts/code-completion";
import { CodeTerminal, terminalText } from "../scripts/code-terminal";
import { parseDispatch } from "../scripts/marina";
import { until } from "./helpers";

class Screen implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  starts = 0;
  stops = 0;
  private buffer = new StdinBuffer();
  resize = () => {};
  start(input: (text: string) => void, resize: () => void) {
    this.starts++;
    this.resize = resize;
    this.buffer.on("data", input);
    this.buffer.on("paste", (text) => input(`\x1b[200~${text}\x1b[201~`));
  }
  send(text: string) {
    this.buffer.process(text);
  }
  stop() {
    this.stops++;
    this.buffer.destroy();
  }
  async drainInput() {}
  write(text: string) {
    this.output += text;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  text() {
    return terminalText(this.output);
  }
}

function workspace() {
  const screen = new Screen();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const lines: string[] = [];
  let closes = 0;
  let interrupts = 0;
  const terminal = new CodeTerminal({
    input,
    output,
    screen,
    tui: true,
    views: true,
    line: (text) => lines.push(text),
    close: () => {
      closes++;
    },
    interrupt: () => {
      interrupts++;
    },
  });
  return {
    screen,
    terminal,
    lines,
    input,
    closed: () => closes,
    interrupted: () => interrupts,
    [Symbol.dispose]() {
      terminal.close();
      input.destroy();
      output.destroy();
    },
  };
}

it("selects the workspace without changing session ownership or one-shot parsing", () => {
  expect(parseDispatch([".", "--tui"])).toEqual({ kind: "code", dir: ".", tui: true });
  expect(parseDispatch(["--tui", "-p", "work"])).toEqual({
    kind: "code",
    dir: undefined,
    tui: true,
    print: "work",
  });
  expect(
    parseDispatch([
      "--url",
      "ws://localhost:3300",
      "--name",
      "Owner",
      "--session",
      "project",
      "--tui",
    ]),
  ).toEqual({
    kind: "code-connected",
    url: "ws://localhost:3300",
    name: "Owner",
    session: "project",
    tui: true,
  });
});

it("keeps completion local, bounded and unable to invent IDs or replace a multiline draft", async () => {
  const options = { signal: new AbortController().signal };
  const suggestions = await terminalCompletion.getSuggestions(["/rev"], 0, 4, options);
  expect(suggestions?.items.map((entry) => entry.value)).toEqual(["/review"]);
  expect(
    terminalCompletion.applyCompletion(["/rev"], 0, 4, suggestions!.items[0]!, "/rev").lines,
  ).toEqual(["/review "]);
  expect(
    await terminalCompletion.getSuggestions(["/review approve id"], 0, 18, options),
  ).toBeNull();
  expect(await terminalCompletion.getSuggestions(["draft", "/rev"], 1, 4, options)).toBeNull();
  expect(await terminalCompletion.getSuggestions(["/world code exec"], 0, 16, options)).toBeNull();
  expect(await terminalCompletion.getSuggestions(["/tmp/secrets"], 0, 12, options)).toBeNull();
  const connected = await terminalCompletionFor(true).getSuggestions(["/"], 0, 1, options);
  expect(connected?.items.some((entry) => entry.value === "/spawn")).toBe(false);
  expect(connected?.items.find((entry) => entry.value === "/use")?.label).toBe("/use marina");
  expect(inputGuidance("/quit", false, true)).toContain(
    "Detach; world agents and tasks keep running",
  );
});

it("shows inline suggestions and requires a separate Enter to execute a selected command", async () => {
  using f = workspace();
  f.screen.send("/rev");
  await until(() => f.screen.text().includes("/review"));
  f.screen.send("\r");
  expect(f.lines).toEqual([]);
  f.screen.send("\r");
  expect(f.lines).toEqual(["/review"]);
  f.screen.send("/view w");
  await until(() => f.screen.text().includes("/view world"));
  f.screen.send("\t");
  expect(f.lines).toEqual(["/review"]);
  f.screen.send("\r");
  f.screen.send("tell Peer hello\r");
  expect(f.lines.at(-1)).toBe("/world tell Peer hello");
});

it("preserves Unicode drafts and world input during live output and explicit request cancellation", async () => {
  using f = workspace();
  const signal = new AbortController();
  let answers = 0;
  const first = f.terminal.ask("Session A: execute?", signal.signal).then((answer) => {
    answers++;
    return answer;
  });
  const second = f.terminal.ask("Session B: execute?");
  f.screen.send("repair 界 suffix\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D");
  f.screen.send("\x1b[17~");
  f.screen.send("tell Peer live\r");
  expect(f.lines).toEqual(["/world tell Peer live"]);
  expect(answers).toBe(0);
  f.screen.send("world draft");
  f.terminal.write("worker-private-output", "coding");
  await until(() => f.screen.text().includes("Coding (1)"));
  expect(f.screen.text()).not.toContain("worker-private-output");
  f.screen.columns = 28;
  f.screen.rows = 12;
  f.screen.resize();
  f.screen.send("\x1b[18~");
  f.screen.send("yes");
  f.screen.send("\x1b[17~");
  f.screen.send(" continued\r");
  expect(f.lines.at(-1)).toBe("/world world draft continued");
  signal.abort();
  expect(await first).toBe("");
  f.screen.send("\x1b[18~");
  f.screen.send("no\r");
  expect(await second).toBe("no");
  f.screen.send("\x1b[17~");
  f.screen.send("new-\x1b[F\r");
  expect(f.lines.at(-1)).toBe("repair 界 new-suffix");
  await until(() => f.screen.text().includes("worker-private-output"));
});

it("pastes multiline tasks atomically, keeps request history empty and restores terminal modes on close", async () => {
  using f = workspace();
  f.screen.send("\x1b[200~line one\nline two\x1b[201~");
  expect(f.lines).toEqual([]);
  f.screen.send("\r");
  expect(f.lines).toEqual(["line one\nline two"]);
  const answer = f.terminal.ask("Request one");
  f.screen.send("\x1b[18~no\r");
  expect(await answer).toBe("no");
  const pending = f.terminal.ask("Request two");
  f.screen.send("\x1b[18~\x1b[A\r");
  expect(await pending).toBe("");
  const closing = f.terminal.ask("Never accepted on close");
  f.screen.send("\x03");
  expect(f.interrupted()).toBe(1);
  f.screen.send("\x04");
  expect(await closing).toBe("");
  expect(f.closed()).toBe(1);
  expect(f.screen.stops).toBe(1);
  expect(f.screen.output).toContain("\x1b[?1049l");
});

it("keeps redirected output continuous and never enables a screen for one-shot mode", async () => {
  for (const tty of [false, true]) {
    const input = Object.assign(new PassThrough(), { isTTY: tty });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    const screen = new Screen();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    const terminal = new CodeTerminal({
      input,
      output,
      screen,
      tui: true,
      views: false,
      line() {},
      close() {},
      interrupt() {},
    });
    try {
      terminal.write("world message", "world");
      terminal.write("coding output", "coding");
      expect(await terminal.ask("not visible")).toBe("");
      expect(screen.starts).toBe(0);
      expect(text).toBe("world message\ncoding output\n");
    } finally {
      terminal.close();
      input.destroy();
      output.destroy();
    }
  }
});

it("renders untrusted output as text and keeps shared failures visible during a request", async () => {
  using f = workspace();
  f.terminal.write("Output \x1b]52;c;clipboard-attack\x07\x1b[2Jmessage\u202e", "coding");
  await until(() => f.screen.text().includes("Output message"));
  expect(f.screen.output).not.toContain("clipboard-attack");
  expect(f.screen.output).not.toContain("\u202e");
  const request = f.terminal.ask("Approve this specific command?");
  f.screen.send("\x1b[18~");
  f.terminal.write("Connection unavailable; delivery unconfirmed", "all", true);
  await until(() => f.screen.text().includes("Connection unavailable; delivery unconfirmed"));
  f.terminal.close();
  expect(await request).toBe("");
});
