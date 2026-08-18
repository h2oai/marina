// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInvalidateOnEvent } from "../hooks/use-realtime";
import { useWorldState } from "../hooks/use-world-state";
import type { DashboardEvent } from "../lib/types";
import { resetWorldState } from "./test-utils";

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  resetWorldState();
  vi.useRealTimers();
});

describe("useInvalidateOnEvent", () => {
  it("invalidates the matching query when a predicate-matching event arrives", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useInvalidateOnEvent(["tasks"], (e) => e.type === "task_claimed", 0), {
      wrapper: wrapperWith(client),
    });

    act(() => {
      useWorldState.getState().pushEvent({
        type: "task_claimed",
        entity: "e_1",
        taskId: 42,
        timestamp: Date.now(),
      } as DashboardEvent);
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks"] });
    });
  });

  it("does not invalidate when the predicate doesn't match", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useInvalidateOnEvent(["tasks"], (e) => e.type === "task_claimed", 0), {
      wrapper: wrapperWith(client),
    });

    act(() => {
      useWorldState.getState().pushEvent({
        type: "entity_enter",
        entity: "e_1",
        room: "zone/hall",
        timestamp: Date.now(),
      } as DashboardEvent);
    });

    // Let any microtasks settle
    await new Promise((r) => setTimeout(r, 20));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("debounces bursts into a single invalidation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useInvalidateOnEvent(["agents"], (e) => e.type === "agent_spawn", 50), {
      wrapper: wrapperWith(client),
    });

    act(() => {
      for (let i = 0; i < 10; i++) {
        useWorldState.getState().pushEvent({
          type: "agent_spawn",
          name: `agent-${i}`,
          timestamp: Date.now() + i,
        } as DashboardEvent);
      }
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("triggers a real refetch on the matching query via react-query", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    const fetcher = vi.fn().mockResolvedValue({ count: 1 });

    function Probe() {
      useQuery({ queryKey: ["widgets"], queryFn: fetcher });
      useInvalidateOnEvent(["widgets"], (e) => e.type === "widget_change", 0);
      return null;
    }

    render(<Probe />, { wrapper: wrapperWith(client) });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => {
      useWorldState.getState().pushEvent({
        type: "widget_change",
        timestamp: Date.now(),
      } as DashboardEvent);
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
