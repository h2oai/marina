// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isTransportFailure } from "../scripts/connect-errors";
import { LoginRefusedError } from "../src/sdk/client";

describe("connect failure classification", () => {
  it("a server refusal is never a transport failure, whatever its text says", () => {
    const refusal = new LoginRefusedError(
      "That name is already in use: it is connected on a websocket connection since 02:00 UTC.",
    );
    expect(isTransportFailure(refusal)).toBe(false);
  });

  it("network errors are transport failures", () => {
    expect(isTransportFailure(new Error("connect ECONNREFUSED 127.0.0.1:3300"))).toBe(true);
    expect(isTransportFailure(new Error("Connection timed out"))).toBe(true);
  });
});
