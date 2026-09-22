// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** Throws on its first render only; a controlled retry then renders normally. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("kaboom: panel exploded");
  return <div>panel content</div>;
}

/** Parent that flips the child to healthy when the boundary resets. */
function Harness() {
  const [broken, setBroken] = useState(true);
  return (
    <ErrorBoundary fallbackTitle="Test panel crashed" onReset={() => setBroken(false)}>
      <Bomb shouldThrow={broken} />
    </ErrorBoundary>
  );
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React logs the caught error and the boundary logs componentStack; keep
    // the test output quiet without hiding unrelated failures.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the fallback card with the error message when a child throws", () => {
    render(
      <ErrorBoundary fallbackTitle="Widget crashed">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Widget crashed");
    expect(alert).toHaveTextContent("kaboom: panel exploded");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("uses a default title when none is given", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });

  it("resets and re-renders children on Try again, calling onReset", () => {
    render(<Harness />);
    expect(screen.getByRole("alert")).toHaveTextContent("Test panel crashed");

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("panel content")).toBeInTheDocument();
  });
});
