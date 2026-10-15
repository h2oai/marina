// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Modal focus handling: on activation remember the focused element and move
 * focus into `ref`; Tab / Shift+Tab cycle within it; on deactivation focus
 * returns to where it was (if that element is still in the document).
 */

import { type RefObject, useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])';

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusableWithin(root)[0];
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (previous?.isConnected && typeof previous.focus === "function")
        previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
