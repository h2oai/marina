// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { parseCommandArgv } from "../src/coding/command-argv";

it("preserves quoted Python programs, empty arguments, escapes and adjacent groups", () => {
  expect(
    parseCommandArgv(`python -c 'import json; print(json.load(open("result.json")))'`),
  ).toEqual(["python", "-c", 'import json; print(json.load(open("result.json")))']);
  expect(parseCommandArgv(`tool "" 'a b' a" b" c\\ d`)).toEqual(["tool", "", "a b", "a b", "c d"]);
  expect(parseCommandArgv('python -c "print(\\"a\\\\nb\\")"')).toEqual([
    "python",
    "-c",
    'print("a\\nb")',
  ]);
});
it("never evaluates shell syntax and round-trips literal JSON argv", () => {
  const args = ["python", "-c", 'print("$HOME `id` $(id) *")', "", "line\nline"];
  expect(parseCommandArgv(`--argv ${JSON.stringify(args)}`)).toEqual(args);
  expect(parseCommandArgv('echo "$HOME" "$(id)" | cat')).toEqual([
    "echo",
    "$HOME",
    "$(id)",
    "|",
    "cat",
  ]);
});
it("rejects malformed grouping and argv before execution", () => {
  for (const input of [
    "tool 'open",
    'tool "open',
    "tool \\",
    "--argv [1]",
    "--argv []",
    '--argv ["\\u0000"]',
  ])
    expect(() => parseCommandArgv(input)).toThrow();
});
