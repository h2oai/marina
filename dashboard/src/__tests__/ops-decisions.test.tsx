// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DECISIONS_EMPTY_TEXT,
  DECISIONS_OFF_TEXT,
  DecisionsSection,
  signalSummary,
} from "../components/ops/DecisionsSection";
import type { OpsDecisions } from "../lib/ops-types";

const base: OpsDecisions = {
  configured: true,
  backend: "decisions-api",
  model: "typesafe/jev-1.13",
  calibrated: true,
  gate: true,
  verify: false,
  windowMs: 86_400_000,
  counts: {},
  recent: [],
};

describe("Ops → Decisions", () => {
  it("explains how to turn decisions on when no backend is configured", () => {
    render(<DecisionsSection decisions={{ ...base, configured: false, model: null }} />);
    expect(screen.getByText(DECISIONS_OFF_TEXT)).toBeInTheDocument();
  });

  it("shows counts and the recent decisions with their top signals", () => {
    render(
      <DecisionsSection
        decisions={{
          ...base,
          counts: { gate: { allow: 5, ask: 1, block: 2 }, route: { coder: 1 } },
          recent: [
            {
              name: "Scout",
              stage: "gate",
              verdict: "block",
              subject: "marina_command",
              reason: "Blocked by the decision gate (unauthorized 0.87).",
              signals: {
                destructive: 0.84,
                unauthorized: 0.87,
                outsideScope: 0.4,
                irreversible: 0.5,
              },
              model: "typesafe/jev-1.13",
              latencyMs: 268,
              timestamp: Date.now(),
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("8")).toBeInTheDocument(); // gate decisions
    expect(screen.getByText("3")).toBeInTheDocument(); // held or blocked
    expect(screen.getByText("1 · 0")).toBeInTheDocument(); // routes · verifies
    expect(screen.getByText("block")).toBeInTheDocument();
    expect(
      screen.getByText(/unauthorized 0\.87 · destructive 0\.84 · irreversible 0\.50/),
    ).toBeInTheDocument();
  });

  it("says when nothing happened and flags an uncalibrated backend", () => {
    render(
      <DecisionsSection decisions={{ ...base, calibrated: false, model: "openai/gpt-4o-mini" }} />,
    );
    expect(screen.getByText(DECISIONS_EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.getByTitle(/uncalibrated/)).toBeInTheDocument();
  });

  it("summarises only numeric signals, highest first", () => {
    expect(signalSummary({ route: "coder", p_coder: 0.99, p_cheap: 0.01, confidence: 0.98 })).toBe(
      "p_coder 0.99 · confidence 0.98 · p_cheap 0.01",
    );
  });
});
