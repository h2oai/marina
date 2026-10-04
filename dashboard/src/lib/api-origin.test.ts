// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import { apiOrigin } from "./api-origin";

describe("interface API origin", () => {
  it("preserves real web origins", () => {
    expect(apiOrigin({ protocol: "https:", origin: "https://marina.example" })).toBe(
      "https://marina.example",
    );
    expect(apiOrigin({ protocol: "http:", origin: "http://localhost:5173" })).toBe(
      "http://localhost:5173",
    );
  });
  it("gives SDK clients a valid local RPC base on opaque desktop origins", () => {
    const origin = apiOrigin({ protocol: "views:", origin: "null" });
    expect(new URL("/canvas-ws", origin).hostname).toBe("marina.desktop.invalid");
    expect(() => new MarinaRoutingClient({ url: origin, token: "" })).not.toThrow();
  });
});
