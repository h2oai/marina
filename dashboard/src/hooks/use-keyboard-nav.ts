import { useCallback, useRef, useState } from "react";

export interface UseKeyboardNavOptions<T> {
  items: T[];
  onActivate: (index: number) => void;
  wrap?: boolean;
}

export interface UseKeyboardNavResult {
  highlightedIndex: number | null;
  setHighlightedIndex: (index: number | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useKeyboardNav<T>({
  items,
  onActivate,
  wrap = true,
}: UseKeyboardNavOptions<T>): UseKeyboardNavResult {
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const scrollToIndex = useCallback((index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const children = container.querySelectorAll("[data-kb-item]");
    const child = children[index];
    if (child) {
      child.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      setHighlightedIndex((prev) => {
        let next: number;
        if (prev === null) {
          next = delta > 0 ? 0 : items.length - 1;
        } else {
          next = prev + delta;
          if (wrap) {
            next = ((next % items.length) + items.length) % items.length;
          } else {
            next = Math.max(0, Math.min(items.length - 1, next));
          }
        }
        scrollToIndex(next);
        return next;
      });
    },
    [items.length, wrap, scrollToIndex],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          move(1);
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          move(-1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (highlightedIndex !== null && highlightedIndex < items.length) {
            onActivate(highlightedIndex);
          }
          break;
        case "Home":
          e.preventDefault();
          if (items.length > 0) {
            setHighlightedIndex(0);
            scrollToIndex(0);
          }
          break;
        case "End":
          e.preventDefault();
          if (items.length > 0) {
            const last = items.length - 1;
            setHighlightedIndex(last);
            scrollToIndex(last);
          }
          break;
        case "Escape":
          setHighlightedIndex(null);
          break;
      }
    },
    [move, highlightedIndex, items.length, onActivate, scrollToIndex],
  );

  return { highlightedIndex, setHighlightedIndex, onKeyDown, containerRef };
}
