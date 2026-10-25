// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { judgeOpinion } from "../src/decisions/policy";

describe("judgeOpinion — the judge's own view, not the policy's action", () => {
  it("passes only when quality and every support question clear the bar", () => {
    expect(judgeOpinion({ quality: 1.8, delivered: 0.9 }, ["delivered"])).toBe("pass");
    expect(judgeOpinion({ quality: 1.8, delivered: 0.2 }, ["delivered"])).toBe("fail");
    expect(judgeOpinion({ quality: 0.4, delivered: 0.9 }, ["delivered"])).toBe("fail");
  });
  it("gives no opinion without usable numbers — an outage is never a pass", () => {
    expect(judgeOpinion({}, ["delivered"])).toBe("none");
    expect(judgeOpinion({ quality: 1.9 }, ["delivered", "grounded"])).toBe("none");
  });
});
