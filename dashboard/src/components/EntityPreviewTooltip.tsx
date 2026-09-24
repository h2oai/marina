// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { EntityPreview } from "../../../src/net/discovery-types";
import { useChatState } from "../hooks/use-chat-state";
import { fetchApi } from "../lib/api";

/** One delayed preview for all roster rows and SVG entity dots, including keyboard focus. */
export function EntityPreviewTooltip() {
  const viewer = useChatState((s) => s.entityName);
  const [target, setTarget] = useState<{
    name: string;
    x: number;
    y: number;
    element: Element;
  } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let activeElement: HTMLElement | null = null;
    const show = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const el = event.target.closest<HTMLElement>("[data-entity-preview]");
      if (!el) return;
      activeElement = el;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!el.isConnected) return;
        const rect = el.getBoundingClientRect();
        setTarget({
          name: el.dataset.entityPreview!,
          element: el,
          x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 296)),
          y: Math.max(8, Math.min(rect.top, window.innerHeight - 240)),
        });
      }, 300);
    };
    const hide = () => {
      clearTimeout(timer);
      activeElement = null;
      setTarget(null);
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget;
      const source =
        event.target instanceof Element ? event.target.closest("[data-entity-preview]") : null;
      if (!source) return;
      if (source && related instanceof Node && source.contains(related)) return;
      hide();
    };
    const scroll = (event: Event) => {
      // Chat/feed auto-scrolling must not dismiss a preview in another pane.
      if (
        event.target === document ||
        event.target === window ||
        (event.target instanceof Element && activeElement && event.target.contains(activeElement))
      )
        hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("mouseout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("mouseout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, []);
  useEffect(() => {
    if (!target) return;
    const previous = target.element.getAttribute("aria-describedby");
    target.element.setAttribute("aria-describedby", "entity-preview");
    return () => {
      if (previous) target.element.setAttribute("aria-describedby", previous);
      else target.element.removeAttribute("aria-describedby");
    };
  }, [target]);
  const query = useQuery({
    queryKey: ["entity-preview", viewer, target?.name],
    queryFn: () =>
      fetchApi<EntityPreview>(`/api/entities/${encodeURIComponent(target!.name)}/preview`),
    enabled: !!target,
    staleTime: 10_000,
  });
  if (!target) return null;
  const data = query.data;
  return createPortal(
    <div
      id="entity-preview"
      role="tooltip"
      className="pointer-events-none fixed z-[100] w-72 rounded border border-primary/40 bg-bg p-3 text-xs text-text shadow-xl"
      style={{ left: target.x, top: target.y }}
    >
      <strong className="text-sm text-primary">{target.name}</strong>
      {query.isLoading ? (
        <p>Loading details…</p>
      ) : query.isError ? (
        <p>Details unavailable</p>
      ) : (
        data && (
          <>
            <p className="my-2">
              Rank {data.rank} · Standing {data.standing ?? "unavailable"}
            </p>
            {data.privateVisible ? (
              <dl className="space-y-1">
                <dt className="text-text-dim">Inventory</dt>
                <dd className="line-clamp-2">{data.inventory?.join(", ") || "Empty"}</dd>
                <dt className="text-text-dim">Current task</dt>
                <dd className="line-clamp-2">{data.task ?? "None"}</dd>
                <dt className="text-text-dim">Active crew</dt>
                <dd className="line-clamp-2">{data.crew ?? "None"}</dd>
              </dl>
            ) : (
              <p>Inventory and work details are private.</p>
            )}
          </>
        )
      )}
    </div>,
    document.body,
  );
}
