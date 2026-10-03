// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchPanelQueries } from "../hooks/use-panel-realtime";
import { useWorldState } from "../hooks/use-world-state";

let client: QueryClient;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  useWorldState.setState({ eventFeed: [], connectionGeneration: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  client.clear();
  vi.useRealTimers();
});
function observe(id: string, token = "owner", queryFn = vi.fn(async () => "authorized content")) {
  const observer = new QueryObserver(client, {
    queryKey: ["panel-source", "true:Owner", token, { kind: "coding", id }],
    queryFn,
    staleTime: Infinity,
  });
  cleanup.push(observer.subscribe(() => {}));
  return queryFn;
}
function event(id = "desk") {
  useWorldState
    .getState()
    .pushEvents([{ type: "resource_changed", resource: "coding", id, timestamp: 42 }]);
}
it("coalesces equal-timestamp bursts across duplicate views and keeps credentials and unrelated queries separate", async () => {
  const calls = observe("desk");
  const foreign = observe("desk", "other-token");
  const unrelated = observe("other-session");
  cleanup.push(watchPanelQueries(client, "true:Owner", "owner"));
  const release = watchPanelQueries(client, "true:Owner", "owner");
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 20; i++) event();
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toHaveBeenCalledTimes(2);
  expect(foreign).toHaveBeenCalledTimes(1);
  expect(unrelated).toHaveBeenCalledTimes(1);
  release();
  event();
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toHaveBeenCalledTimes(3);
});
it("rereads after an event during an in-flight fetch and after reconnect, without overlapping reads", async () => {
  let resolve!: (value: string) => void;
  const calls = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  observe("desk", "owner", calls);
  cleanup.push(watchPanelQueries(client, "true:Owner", "owner"));
  event();
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toHaveBeenCalledTimes(1);
  resolve("snapshot before event");
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toHaveBeenCalledTimes(2);
  resolve("current snapshot");
  await vi.advanceTimersByTimeAsync(1);
  useWorldState.setState({ connectionGeneration: 1 });
  await vi.advanceTimersByTimeAsync(150);
  expect(calls).toHaveBeenCalledTimes(3);
  resolve("recovered");
});
it("closing all views stops scheduling; an inactive cached source is not polled by hints", async () => {
  const calls = observe("desk");
  const close = watchPanelQueries(client, "true:Owner", "owner");
  await vi.advanceTimersByTimeAsync(1);
  event();
  close();
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toHaveBeenCalledTimes(1);
});
