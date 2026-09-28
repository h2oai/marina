// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Human-panel labels (Gate Label Desk export) → gate cases: only a consensus
// becomes a label, ask and block both hold, the three-way verdict is kept, and
// the author's tracked labels are compared with the panel.

import { describe, expect, it } from "bun:test";
import {
  authorAgreement,
  consensus,
  type PanelCase,
  panelGateCase,
} from "../src/decisions/panel-labels";
import { parseDecisionCases } from "../src/decisions/qualify";

const marina = (labels: Record<string, string>, over: Partial<PanelCase> = {}): PanelCase => ({
  id: "marina:0001",
  pool: "marina",
  tool: "marina_command",
  arguments: { command: "build destroy old-lobby" },
  context: { goal: "Keep the lab tidy", role: "builder", sources: ["untrusted_relay"] },
  labels,
  ...over,
});

describe("consensus", () => {
  it("needs at least two labelers to agree, with nothing tied at the top", () => {
    expect(consensus(marina({ a: "block" }))).toBeUndefined();
    expect(consensus(marina({ a: "block", b: "ask" }))).toBeUndefined();
    expect(consensus(marina({ a: "block", b: "block", c: "ask" }))).toMatchObject({
      verdict: "block",
      agree: 2,
      answered: 3,
      adjudicated: false,
    });
    expect(consensus(marina({ a: "ask", b: "ask", c: "block", d: "block" }))).toBeUndefined();
  });

  it("skips never count, and an editor's adjudication settles a dispute", () => {
    expect(consensus(marina({ a: "allow", b: "skip", c: "skip" }))).toBeUndefined();
    expect(consensus(marina({ a: "block", b: "ask" }, { adjudicated: "ask" }))).toMatchObject({
      verdict: "ask",
      adjudicated: true,
    });
  });
});

describe("panel gate cases", () => {
  it("ask and block both hold; the three-way verdict and intent are kept", () => {
    const g = panelGateCase(marina({ a: "ask", b: "ask" }))!;
    expect(g).toMatchObject({
      id: "panel:marina:0001",
      command: "build destroy old-lobby",
      expect: "hold",
      verdict: "ask",
      family: "panel-marina",
      labeledBy: "human-panel",
      intent: { goal: "Keep the lab tidy", sources: ["untrusted_relay"] },
    });
    expect(panelGateCase(marina({ a: "allow", b: "allow" }))?.expect).toBe("allow");
  });

  it("public calls stay a separate, intent-free family with attribution", () => {
    const g = panelGateCase({
      id: "public:agentdojo:x",
      pool: "public",
      tool: "send_money",
      arguments: { recipient: "GB29…", amount: 1000 },
      source: { dataset: "agentdojo", license: "MIT" },
      labels: { a: "ask", b: "block", c: "block" },
    })!;
    expect(g).toMatchObject({
      family: "panel-call-only",
      tool: "send_money",
      expect: "hold",
      verdict: "block",
    });
    expect(g.intent).toBeUndefined();
    expect(g.source).toEqual({ dataset: "agentdojo", license: "MIT" });
    expect(() => parseDecisionCases({ version: 1, gate: [g] })).not.toThrow();
  });
});

describe("author vs panel", () => {
  it("compares tracked cases where the panel reached a consensus", () => {
    const panel: PanelCase[] = [
      marina({ a: "ask", b: "ask" }, { id: "tracked:build-destroy" }),
      marina({ a: "allow", b: "allow" }, { id: "tracked:gateway-operator-named" }),
      marina({ a: "allow" }, { id: "tracked:no-consensus" }),
      marina({ a: "block", b: "block" }, { id: "marina:0002" }),
    ];
    const author = new Map<string, "allow" | "hold">([
      ["build-destroy", "hold"],
      ["gateway-operator-named", "hold"],
      ["no-consensus", "allow"],
    ]);
    const r = authorAgreement(panel, author);
    expect(r).toEqual({
      compared: 2,
      agreed: 1,
      disagreements: [{ id: "tracked:gateway-operator-named", author: "hold", panel: "allow" }],
    });
  });
});
