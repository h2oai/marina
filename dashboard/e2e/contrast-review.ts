// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";

/**
 * Supplemental paint checks for axe's incomplete SVG/top-layer results.
 * This measures resolved colors, including inherited opacity. It cannot prove
 * layout visibility: retain axe's report and screenshots for overlap review.
 * Unknown backgrounds fail closed instead of becoming contrast passes.
 */
export async function reviewTextContrast(page: Page, selectors: string[]) {
  return page.evaluate((targets) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas color resolution unavailable");
    function color(value: string): Color {
      if (!CSS.supports("color", value)) throw new Error(`Unsupported color: ${value}`);
      context!.clearRect(0, 0, 1, 1);
      context!.fillStyle = value;
      context!.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context!.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    }
    function over(fg: Color, bg: Color): Color {
      const alpha = fg[3] + bg[3] * (1 - fg[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [0, 1, 2]
        .map((i) => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha)
        .concat(alpha) as Color;
    }
    function luminance(c: Color) {
      const linear = c.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    return targets.flatMap((target) => {
      const elements = [...document.querySelectorAll(target)];
      if (elements.length === 0) return [{ target, error: "Text disappeared before review" }];
      return elements.map((element) => {
        try {
          const style = getComputedStyle(element);
          let bg: Color = [0, 0, 0, 0];
          const outlined = element instanceof SVGTextElement && element.matches(".uc-map-label");
          if (outlined) {
            if (
              !style.paintOrder.startsWith("stroke") ||
              Number.parseFloat(style.strokeWidth) < 3 ||
              Number(style.strokeOpacity) !== 1
            ) {
              throw new Error("Map text requires an opaque outline painted behind its fill");
            }
            bg = color(style.stroke);
          }
          for (let node: Element | null = element; node; node = node.parentElement) {
            const paint = getComputedStyle(node);
            if (
              Number(paint.opacity) !== 1 ||
              paint.mixBlendMode !== "normal" ||
              paint.filter !== "none"
            ) {
              throw new Error(
                `Transparent or filtered text needs pixel-level review: ${element.textContent?.trim()} inside ${node.tagName} (opacity ${paint.opacity}, filter ${paint.filter})`,
              );
            }
            if (bg[3] === 1) continue;
            if (paint.backgroundImage !== "none" || node instanceof SVGElement) {
              throw new Error("Non-solid background needs pixel-level review");
            }
            bg = over(bg, color(paint.backgroundColor));
          }
          if (bg[3] !== 1) throw new Error("No opaque text background");
          const fg = color(outlined ? style.fill : style.color);
          if (outlined) fg[3] *= Number(style.fillOpacity);
          const a = luminance(over(fg, bg));
          const b = luminance(bg);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          return {
            target,
            text: element.textContent?.trim(),
            ratio,
            foreground: fg,
            background: bg,
          };
        } catch (error) {
          return { target, error: error instanceof Error ? error.message : String(error) };
        }
      });
    });
  }, selectors);
}
