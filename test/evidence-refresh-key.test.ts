// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { evidenceHash } from "../src/research/evidence";
import { withoutReadTimes } from "../src/research/refresh";

describe("evidence refresh key", () => {
  it("ignores when inputs were read, never what was read", () => {
    const origin = (fetchedAt: string, value: number) => ({
      civiqs_net_approval: {
        reading: { date: "2026-10-23", value },
        fetchedAt,
        daily: [{ date: "2026-10-22", value, checkedAt: fetchedAt }],
        asOf: "2026-10-23",
      },
    });
    const key = (o: unknown) => evidenceHash(withoutReadTimes({ origins: o }));
    expect(key(origin("2026-10-23T05:00:00Z", -27.2))).toBe(
      key(origin("2026-10-23T09:30:00Z", -27.2)),
    );
    expect(key(origin("2026-10-23T05:00:00Z", -27.2))).not.toBe(
      key(origin("2026-10-23T05:00:00Z", -27.4)),
    );
    // A data vintage (`asOf`) is an input: it stays in the key.
    expect(withoutReadTimes({ asOf: "2026-10-23", fetchedAt: "x" })).toEqual({
      asOf: "2026-10-23",
    });
  });
});
