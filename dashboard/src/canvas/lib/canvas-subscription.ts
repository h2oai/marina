// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type CanvasEvent, parseCanvasEvent } from "./canvas-events";

interface Listener {
  event: (event: CanvasEvent) => void;
  status: (status: "live" | "reconnecting") => void;
}
interface Subscription {
  listeners: Set<Listener>;
  socket?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
  status: "live" | "reconnecting";
  attempts: number;
}
const subscriptions = new Map<string, Subscription>();

/** Drop an overflowing pre-snapshot backlog and fetch a fresh snapshot on reconnect. */
export function resyncCanvas(canvasId: string, token: string | null) {
  subscriptions.get(JSON.stringify([window.location.origin, canvasId, token]))?.socket?.close();
}

/** One existing Canvas transport per resource and credential; each observer owns its snapshot. */
export function subscribeCanvas(canvasId: string, token: string | null, listener: Listener) {
  const key = JSON.stringify([window.location.origin, canvasId, token]);
  let entry = subscriptions.get(key);
  if (!entry) {
    entry = { listeners: new Set(), status: "reconnecting", attempts: 0 };
    subscriptions.set(key, entry);
  }
  const subscription = entry;
  subscription.listeners.add(listener);
  const status = (next: Subscription["status"]) => {
    subscription.status = next;
    for (const observer of subscription.listeners) observer.status(next);
  };
  const connect = () => {
    subscription.timer = undefined;
    if (!subscription.listeners.size) return;
    const url = new URL("/canvas-ws", window.location.origin);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("canvas", canvasId);
    // Existing upgrade authentication; credential stays in memory, never in saved links/presets.
    if (token) url.searchParams.set("token", token);
    const socket = new WebSocket(url.href);
    subscription.socket = socket;
    socket.onopen = () => {
      subscription.attempts = 0;
      status("live");
    };
    socket.onmessage = (message) => {
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const event = parseCanvasEvent(value, canvasId);
      if (event)
        for (const observer of subscription.listeners) {
          if (subscription.socket !== socket) break;
          observer.event(event);
        }
    };
    socket.onerror = () => status("reconnecting");
    socket.onclose = () => {
      subscription.socket = undefined;
      status("reconnecting");
      if (subscription.listeners.size)
        subscription.timer = setTimeout(
          connect,
          Math.min(1500 * 2 ** subscription.attempts++, 15000),
        );
    };
  };
  if (!subscription.socket && !subscription.timer) connect();
  else if (subscription.status === "live") listener.status("live");
  return () => {
    subscription.listeners.delete(listener);
    if (subscription.listeners.size) return;
    clearTimeout(subscription.timer);
    const socket = subscription.socket;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    subscriptions.delete(key);
  };
}
