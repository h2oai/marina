// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SvgAction } from "../components/SvgAction";

it("anchors keyboard inspection to the focused artwork and preserves pointer coordinates", () => {
  const activate = vi.fn();
  const parentClick = vi.fn();
  // The SVG container may also handle selection. Activating its child must not select twice.
  render(
    <svg onClick={parentClick} onKeyDown={parentClick} role="img" aria-label="Test graphic">
      <title>Test graphic</title>
      <SvgAction x={0} y={0} width={24} height={24} label="Inspect note" onActivate={activate} />
    </svg>,
  );
  const button = screen.getByLabelText("Inspect note");
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 200,
    width: 24,
    height: 24,
  } as DOMRect);
  // Native Enter/Space dispatch a click with detail=0. Browser journeys exercise the real keys.
  fireEvent.click(button, { detail: 0 });
  expect(activate).toHaveBeenLastCalledWith(112, 212);
  fireEvent.click(button, { detail: 1, clientX: 117, clientY: 218 });
  expect(activate).toHaveBeenLastCalledWith(117, 218);
  expect(activate).toHaveBeenCalledTimes(2);
  expect(parentClick).not.toHaveBeenCalled();
});
