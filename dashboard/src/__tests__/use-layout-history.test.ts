// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useLayoutHistory } from "../hooks/use-layout-history";

const layout = (x: number) => ({ lg: [{ i: "chat", x, y: 0, w: 1, h: 2 }] });

it("undoes geometry, clears redo after a new move, and does not restore closed views", () => {
  const { result } = renderHook(() => useLayoutHistory(() => layout(0)));
  act(() => result.current.commit(layout(1)));
  act(() => result.current.commit(layout(2)));
  act(() => result.current.undo());
  expect(result.current.layouts).toEqual(layout(1));
  act(() => result.current.redo());
  expect(result.current.layouts).toEqual(layout(2));
  act(() => result.current.undo());
  act(() => result.current.commit(layout(3)));
  expect(result.current.canRedo).toBe(false);
  act(() => result.current.reset({ lg: [] }));
  act(() => result.current.undo());
  expect(result.current.layouts).toEqual({ lg: [] });
  expect(result.current.canUndo).toBe(false);
});

it("bounds history and ignores a no-op gesture", () => {
  const { result } = renderHook(() => useLayoutHistory(() => layout(0)));
  act(() => result.current.commit(layout(0)));
  expect(result.current.canUndo).toBe(false);
  for (let n = 1; n <= 30; n++) act(() => result.current.commit(layout(n)));
  for (let n = 0; n < 30; n++) act(() => result.current.undo());
  expect(result.current.layouts).toEqual(layout(10));
  expect(result.current.canUndo).toBe(false);
});
