// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useReducer } from "react";
import type { ResponsiveLayouts } from "react-grid-layout";

type Layouts = ResponsiveLayouts<"lg" | "md">;
interface History {
  current: Layouts;
  past: Layouts[];
  future: Layouts[];
}
type Action = { type: "reset" | "commit"; layouts: Layouts } | { type: "undo" | "redo" };
const LIMIT = 20;

function reduce(state: History, action: Action): History {
  if (action.type === "reset") return { current: action.layouts, past: [], future: [] };
  if (action.type === "commit") {
    if (JSON.stringify(action.layouts) === JSON.stringify(state.current)) return state;
    return {
      current: action.layouts,
      past: [...state.past, state.current].slice(-LIMIT),
      future: [],
    };
  }
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      current: previous,
      past: state.past.slice(0, -1),
      future: [state.current, ...state.future],
    };
  }
  const next = state.future[0];
  return next
    ? { current: next, past: [...state.past, state.current], future: state.future.slice(1) }
    : state;
}

/** Geometry only. Changing views or presets resets history; undo never resurrects a closed view. */
export function useLayoutHistory(initial: () => Layouts) {
  const [state, dispatch] = useReducer(reduce, undefined, () => ({
    current: initial(),
    past: [],
    future: [],
  }));
  const reset = useCallback((layouts: Layouts) => dispatch({ type: "reset", layouts }), []);
  const commit = useCallback((layouts: Layouts) => dispatch({ type: "commit", layouts }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  return {
    layouts: state.current,
    reset,
    commit,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
