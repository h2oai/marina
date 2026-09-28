// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MouseEvent } from "react";

/** A native focusable control over SVG artwork; the artwork and animation stay SVG. */
export function SvgAction({
  x,
  y,
  width,
  height,
  label,
  onActivate,
  entityName,
  onEnter,
  onLeave,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  onActivate: (x: number, y: number) => void;
  entityName?: string;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  function activate(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onActivate(
      event.detail === 0 ? rect.left + rect.width / 2 : event.clientX,
      event.detail === 0 ? rect.top + rect.height / 2 : event.clientY,
    );
  }
  return (
    <foreignObject x={x} y={y} width={width} height={height} overflow="visible">
      <button
        type="button"
        aria-label={label}
        data-entity-preview={entityName}
        className="svg-action nokey"
        onClick={activate}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
      />
    </foreignObject>
  );
}
