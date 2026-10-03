// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnimatedNumber } from "../components/AnimatedNumber";

describe("AnimatedNumber", () => {
  it("renders the initial value as text", () => {
    render(<AnimatedNumber value={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("respects decimals prop", () => {
    render(<AnimatedNumber value={Math.PI} decimals={2} />);
    expect(screen.getByText("3.14")).toBeInTheDocument();
  });

  it("uses a custom format function when provided", () => {
    render(<AnimatedNumber value={67} format={(n) => `${Math.round(n)}%`} />);
    expect(screen.getByText("67%")).toBeInTheDocument();
  });

  it("forwards className to the rendered span", () => {
    const { container } = render(<AnimatedNumber value={1} className="text-cyan-500" />);
    const span = container.querySelector("span");
    expect(span).toBeTruthy();
    expect(span?.className).toContain("text-cyan-500");
  });
});
