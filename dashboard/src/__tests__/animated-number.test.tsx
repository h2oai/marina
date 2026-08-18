// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnimatedNumber, AnimatedSvgNumber } from "../components/AnimatedNumber";

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

describe("AnimatedSvgNumber", () => {
  it("renders the initial value inside an SVG text element", () => {
    const { container } = render(
      <svg>
        <title>Test</title>
        <AnimatedSvgNumber value={7} x={10} y={20} />
      </svg>,
    );
    const text = container.querySelector("text");
    expect(text).toBeTruthy();
    expect(text?.textContent).toBe("7");
  });

  it("forwards SVG props (x, y, fill)", () => {
    const { container } = render(
      <svg>
        <title>Test</title>
        <AnimatedSvgNumber value={1} x={42} y={99} fill="red" />
      </svg>,
    );
    const text = container.querySelector("text");
    expect(text?.getAttribute("x")).toBe("42");
    expect(text?.getAttribute("y")).toBe("99");
    expect(text?.getAttribute("fill")).toBe("red");
  });
});
