// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatch } from "../scripts/marina";
import { routingCachedToken } from "../scripts/route";

it("routes the new CLI without changing connect or default code dispatch", () => {
  expect(parseDispatch(["route", "--name", "Alice", "discover"])).toEqual({
    kind: "route",
    rest: ["--name", "Alice", "discover"],
  });
  expect(parseDispatch(["connect", "Alice"])).toEqual({ kind: "connect", rest: ["Alice"] });
  expect(parseDispatch([]).kind).toBe("code");
});
it("requires a named credential bound to the same server and rejects path traversal", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-route-cli-"));
  try {
    writeFileSync(
      join(directory, "Alice.json"),
      JSON.stringify({ token: "fixture", url: "ws://localhost:3300" }),
    );
    expect(routingCachedToken("Alice", "http://localhost:3300", directory)).toBe("fixture");
    expect(routingCachedToken("Alice", "https://remote.example", directory)).toBeUndefined();
    expect(routingCachedToken("Bob", "ws://localhost:3300", directory)).toBeUndefined();
    expect(() => routingCachedToken("../Alice", "ws://localhost:3300", directory)).toThrow(
      "Account name",
    );
    writeFileSync(join(directory, "Alice.json"), JSON.stringify({ token: "unbound" }));
    expect(routingCachedToken("Alice", "ws://localhost:3300", directory)).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
