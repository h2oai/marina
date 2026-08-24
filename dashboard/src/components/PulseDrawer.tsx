// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Activity, Radio, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo } from "react";
import { useWorldState } from "../hooks/use-world-state";
import { EventLine } from "./EventLine";

const VISIBLE_EVENTS = 60;

export function PulseDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const events = useWorldState((state) => state.eventFeed);
  const entities = useWorldState((state) => state.entities);
  const thinkingAgents = useWorldState((state) => state.thinkingAgents);
  const connectedSince = useWorldState((state) => state.connectedSince);
  const selectEntity = useWorldState((state) => state.selectEntity);
  const visibleEvents = useMemo(() => events.slice(0, VISIBLE_EVENTS), [events]);
  const nameById = useMemo(
    () => new Map(entities.map((entity) => [entity.id, entity.name])),
    [entities],
  );
  const resolveEntityName = useCallback((id: string) => nameById.get(id), [nameById]);
  const failures = events.filter(
    (event) => event.type.includes("fail") || event.type.includes("error") || Boolean(event.error),
  ).length;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 1, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.16 }}
          aria-label="Live pulse"
          className="fixed right-2 top-12 z-[100] flex max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-bg-card/98 shadow-2xl backdrop-blur"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Radio size={14} className="animate-pulse text-success" />
            <h2 className="font-semibold text-text-bright">Live pulse</h2>
            <span className="text-[10px] text-text-dim">
              since {connectedSince ? new Date(connectedSince).toLocaleTimeString() : "connection"}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto text-text-dim hover:text-text"
              aria-label="Close live pulse"
            >
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-px border-b border-border bg-border text-center text-[10px]">
            <div className="bg-bg-card p-2">
              <strong className="block text-base text-primary">{events.length}</strong>
              buffered events
            </div>
            <div className="bg-bg-card p-2">
              <strong className="block text-base text-secondary">
                {Object.keys(thinkingAgents).length}
              </strong>
              agents thinking
            </div>
            <div className="bg-bg-card p-2">
              <strong
                className={
                  failures ? "block text-base text-danger" : "block text-base text-success"
                }
              >
                {failures}
              </strong>
              observed failures
            </div>
          </div>
          <div className="flex items-center gap-1 border-b border-border px-3 py-1 text-[10px] text-text-dim">
            <Activity size={10} /> Newest first · live WebSocket window, not historical totals
          </div>
          <div className="min-h-0 overflow-y-auto py-1">
            {visibleEvents.length === 0 ? (
              <div className="p-5 text-center text-text-dim">Waiting for live activity…</div>
            ) : (
              visibleEvents.map((event) => (
                <EventLine
                  key={`${event.timestamp}-${event.type}-${event.entity ?? ""}-${event.spanId ?? event.input ?? ""}`}
                  event={event}
                  resolveEntityName={resolveEntityName}
                  onEntityClick={selectEntity}
                />
              ))
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
