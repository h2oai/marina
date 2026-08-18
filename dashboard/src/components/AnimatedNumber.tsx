// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AnimatedNumber — smoothly tweens a numeric value when it changes.
 *
 * Renders into either an HTML element (default `<span>`) or an SVG
 * `<text>` (when `asText` is set), driven by a MotionValue so updates
 * happen outside React's render loop. Use for live counters, scores,
 * percentages — anything that today snaps from one value to another.
 */

import {
  animate,
  type MotionValue,
  motion,
  type SVGMotionProps,
  useMotionValue,
  useTransform,
} from "motion/react";
import type { CSSProperties } from "react";
import { useEffect } from "react";

export interface AnimatedNumberProps {
  value: number;
  /** Decimal places for the formatted output (default: 0). */
  decimals?: number;
  /** Animation duration in seconds (default: 0.6). */
  duration?: number;
  /** Optional formatter — overrides the default toFixed-based output. */
  format?: (n: number) => string;
  className?: string;
  style?: CSSProperties;
}

/** HTML span variant — for tailwind/CSS layouts. */
export function AnimatedNumber({
  value,
  decimals = 0,
  duration = 0.6,
  format,
  className,
  style,
}: AnimatedNumberProps) {
  const mv = useMotionValue(value);
  useEffect(() => {
    const controls = animate(mv, value, { duration, ease: "easeOut" });
    return () => controls.stop();
  }, [mv, value, duration]);
  const text = useTransform(mv, (n) => (format ? format(n) : n.toFixed(decimals)));
  return (
    <motion.span className={className} style={style}>
      {text}
    </motion.span>
  );
}

/** SVG `<text>` variant — for chart counters that live inside an SVG. */
export function AnimatedSvgNumber({
  value,
  decimals = 0,
  duration = 0.6,
  format,
  ...textProps
}: AnimatedNumberProps & Omit<SVGMotionProps<SVGTextElement>, "children" | "format">) {
  const mv = useMotionValue(value);
  useEffect(() => {
    const controls = animate(mv, value, { duration, ease: "easeOut" });
    return () => controls.stop();
  }, [mv, value, duration]);
  const text = useTransform(mv, (n) => (format ? format(n) : n.toFixed(decimals)));
  return <SvgTextWithMv mv={text} {...textProps} />;
}

function SvgTextWithMv({
  mv,
  ...rest
}: { mv: MotionValue<string> } & Omit<SVGMotionProps<SVGTextElement>, "children">) {
  return <motion.text {...rest}>{mv}</motion.text>;
}
