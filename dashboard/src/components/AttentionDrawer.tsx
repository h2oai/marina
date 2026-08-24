// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Bell, Clock3, ExternalLink, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useOperationalAlerts } from "../hooks/use-api";
import { describeApiError, postApi } from "../lib/api";

function desktopAttentionEnabled(): boolean {
  try {
    return window.localStorage.getItem("marina-desktop-attention") === "1";
  } catch {
    return false;
  }
}

export function AttentionDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useOperationalAlerts();
  const [error, setError] = useState<string | null>(null);
  const [desktopAlerts, setDesktopAlerts] = useState(desktopAttentionEnabled);
  const lastCriticalRef = useRef<number | null>(null);
  const now = Date.now();
  const items = (query.data ?? []).filter(
    (item) => item.status !== "resolved" && (!item.snoozed_until || item.snoozed_until <= now),
  );

  useEffect(() => {
    const critical = items.find((item) => item.severity === "critical");
    if (!critical) return;
    if (lastCriticalRef.current === null) {
      lastCriticalRef.current = critical.id;
      return;
    }
    if (
      desktopAlerts &&
      critical.id !== lastCriticalRef.current &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      new Notification(`Marina · ${critical.title}`, {
        body: critical.detail,
        tag: `marina-attention-${critical.id}`,
      });
    }
    lastCriticalRef.current = critical.id;
  }, [desktopAlerts, items]);

  const toggleDesktopAlerts = async () => {
    if (desktopAlerts) {
      try {
        window.localStorage.removeItem("marina-desktop-attention");
      } catch {
        // Preference still changes for this session when storage is unavailable.
      }
      setDesktopAlerts(false);
      return;
    }
    if (!("Notification" in window)) {
      setError("Desktop notifications are not supported by this browser.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setError("Desktop notification permission was not granted.");
      return;
    }
    try {
      window.localStorage.setItem("marina-desktop-attention", "1");
    } catch {
      // Permission remains useful for this session when storage is unavailable.
    }
    setDesktopAlerts(true);
  };

  const act = async (id: number, action: "ack" | "resolve" | "snooze") => {
    setError(null);
    try {
      await postApi(
        `/api/operations/alerts/${id}/${action}`,
        action === "snooze" ? { durationMs: 60 * 60_000 } : undefined,
      );
      await query.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          // Visible-safe entrance: if the animation clock is unavailable the
          // actionable inbox must never remain hidden at its initial frame.
          initial={{ opacity: 1, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.16 }}
          aria-label="Attention inbox"
          className="fixed right-2 top-12 z-[100] flex max-h-[calc(100vh-4rem)] w-[min(420px,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-bg-card/98 shadow-2xl backdrop-blur"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Bell size={14} className="text-warning" />
            <h2 className="font-semibold text-text-bright">Needs attention</h2>
            <span className="rounded bg-warning/10 px-1.5 text-warning">{items.length}</span>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="ml-auto text-text-dim hover:text-primary"
              aria-label="Refresh attention"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-text-dim hover:text-text"
              aria-label="Close attention inbox"
            >
              <X size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={toggleDesktopAlerts}
            className="border-b border-border px-3 py-1 text-left text-[10px] text-text-dim hover:text-primary"
          >
            {desktopAlerts ? "Disable desktop attention alerts" : "Enable desktop attention alerts"}
          </button>
          {error && (
            <div role="alert" className="border-b border-red-500/30 p-2 text-red-300">
              {error}
            </div>
          )}
          <div className="overflow-y-auto p-2">
            {query.isLoading && (
              <div className="p-4 text-center text-text-dim">Loading attention…</div>
            )}
            {query.isError && (
              <div role="alert" className="p-4 text-center text-red-300">
                Could not load attention.
              </div>
            )}
            {!query.isLoading && !query.isError && items.length === 0 && (
              <div className="p-5 text-center text-success">Nothing needs your attention.</div>
            )}
            {items.map((item) => (
              <article
                key={item.id}
                className="mb-2 rounded border border-border bg-bg/70 p-2 text-[11px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <strong className="text-text-bright">{item.title}</strong>
                  <span
                    className={
                      item.severity === "critical"
                        ? "text-danger"
                        : item.severity === "warning"
                          ? "text-warning"
                          : "text-primary"
                    }
                  >
                    {item.severity}
                  </span>
                </div>
                <p className="mt-1 text-text-dim">{item.detail}</p>
                {item.source_entity && (
                  <div className="mt-1 text-text-dim">From {item.source_entity}</div>
                )}
                {item.deadline_at && (
                  <div className="mt-1 text-warning">
                    Due {new Date(item.deadline_at).toLocaleString()}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.action_ref?.startsWith("/") && (
                    <a
                      href={item.action_ref}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink size={10} /> {item.action_label ?? "Open"}
                    </a>
                  )}
                  {item.status === "open" && (
                    <button
                      type="button"
                      onClick={() => act(item.id, "ack")}
                      className="text-primary hover:underline"
                    >
                      Acknowledge
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => act(item.id, "snooze")}
                    className="inline-flex items-center gap-1 text-text-dim hover:text-primary"
                  >
                    <Clock3 size={10} /> Snooze 1h
                  </button>
                  <button
                    type="button"
                    onClick={() => act(item.id, "resolve")}
                    className="text-text-dim hover:text-success"
                  >
                    Resolve
                  </button>
                </div>
              </article>
            ))}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
