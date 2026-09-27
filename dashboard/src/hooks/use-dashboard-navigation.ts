// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { dashboardInspectionFromSearch } from "../lib/marina-reference";
import { traceIdFromSearch } from "../lib/trace-links";
import { type MemoryDestination, useWorkspaceState } from "./use-workspace-state";
import { useWorldState } from "./use-world-state";

export function useDashboardNavigation(
  openView: (next: "work" | "admin" | "canvas") => void,
  setDrawer: Dispatch<SetStateAction<"attention" | "pulse" | "memory" | null>>,
  setMemoryDestination: Dispatch<SetStateAction<MemoryDestination>>,
) {
  // Preserve ordinary anchors for new tabs, but navigate within this mounted shell.
  useEffect(() => {
    const restore = () => {
      setDrawer(null);
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") === "streams")
        useWorkspaceState.setState({ participantId: url.searchParams.get("participant") });
      const inspection = dashboardInspectionFromSearch(url.search);
      if (inspection) useWorkspaceState.getState().inspect(inspection);
      const canvas =
        url.pathname.startsWith("/canvas") || url.searchParams.get("view") === "canvas";
      useWorkspaceState.setState({ fullscreen: url.pathname.startsWith("/canvas") });
      if (canvas) openView("canvas");
      else if (
        ["work", "map", "observe", "admin", "streams"].includes(url.searchParams.get("view") ?? "")
      )
        useWorkspaceState
          .getState()
          .setView(
            url.searchParams.get("view") as "work" | "map" | "observe" | "admin" | "streams",
          );
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        !["/dashboard", "/canvas"].includes(url.pathname)
      )
        return;
      if (
        !url.pathname.startsWith("/canvas") &&
        !dashboardInspectionFromSearch(url.search) &&
        !url.searchParams.has("view")
      )
        return;
      event.preventDefault();
      window.history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    restore();
    document.addEventListener("click", navigate);
    window.addEventListener("popstate", restore);
    return () => {
      document.removeEventListener("click", navigate);
      window.removeEventListener("popstate", restore);
    };
  }, [openView, setDrawer]);

  useEffect(
    () =>
      useWorldState.subscribe((state, prev) => {
        if (state.selectedEntity && state.selectedEntity !== prev.selectedEntity)
          useWorkspaceState.getState().inspect({ type: "entity", name: state.selectedEntity });
        if (state.selectedRoom && state.selectedRoom !== prev.selectedRoom)
          useWorkspaceState.getState().inspect({ type: "room", id: state.selectedRoom });
      }),
    [],
  );
  useEffect(() => {
    const admin = () => openView("admin");
    const memory = (event: Event) => {
      setMemoryDestination((event as CustomEvent<MemoryDestination>).detail ?? {});
      setDrawer("memory");
    };
    const chat = () => {
      useWorkspaceState.setState({ pane: "webchat", fullscreen: false });
    };
    window.addEventListener("marina:open-traces", admin);
    window.addEventListener("marina:open-admin", admin);
    window.addEventListener("marina:open-operations", admin);
    window.addEventListener("marina:open-keys", admin);
    window.addEventListener("marina:open-coding", chat);
    window.addEventListener("marina:open-memory", memory);
    window.addEventListener("marina:draft-command", chat);
    return () => {
      window.removeEventListener("marina:open-traces", admin);
      window.removeEventListener("marina:open-admin", admin);
      window.removeEventListener("marina:open-operations", admin);
      window.removeEventListener("marina:open-keys", admin);
      window.removeEventListener("marina:open-coding", chat);
      window.removeEventListener("marina:open-memory", memory);
      window.removeEventListener("marina:draft-command", chat);
    };
  }, [openView, setDrawer, setMemoryDestination]);
  useEffect(() => {
    const traceId = traceIdFromSearch(window.location.search);
    if (!traceId) return;
    const timer = window.setTimeout(
      () => window.dispatchEvent(new CustomEvent("marina:open-traces", { detail: { traceId } })),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);
}
