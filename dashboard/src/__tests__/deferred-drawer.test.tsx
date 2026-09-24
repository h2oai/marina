// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeferredDrawer } from "../components/lazy-tabs";

describe("DeferredDrawer", () => {
  it("mounts nothing until first opened, then stays mounted for the exit animation", () => {
    const view = (open: boolean) => (
      <DeferredDrawer open={open}>
        <div data-testid="drawer" data-open={String(open)} />
      </DeferredDrawer>
    );
    const { rerender } = render(view(false));
    expect(screen.queryByTestId("drawer")).toBeNull();

    rerender(view(true));
    expect(screen.getByTestId("drawer")).toHaveAttribute("data-open", "true");

    rerender(view(false));
    expect(screen.getByTestId("drawer")).toHaveAttribute("data-open", "false");
  });
});
