// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { apiOrigin } from "../../lib/api-origin";

/**
 * Entity inspector sections for the ContextPanel: activity, compass (brief),
 * knowledge graph and media jobs, each refreshed by its own realtime events.
 * Split out of ContextPanel.tsx without behaviour change.
 */

import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo } from "react";
import { MediaJobsList } from "../../components/MediaJobsList";
import { useEntityBrief, useMediaJobs, useNoteGraph } from "../../hooks/use-api";
import { useInvalidateOnEvent } from "../../hooks/use-realtime";
import { useWorldState } from "../../hooks/use-world-state";
import { authFetch } from "../../lib/api";
import type { DashboardEvent, MediaJob } from "../../lib/types";
import { CascadeSection, PropRow } from "./context-panel-sections";

const API_BASE = apiOrigin();

/** Events that meaningfully change an entity's brief aggregate. */
const BRIEF_MUTATION_TYPES = new Set([
  "task_claimed",
  "task_submitted",
  "task_approved",
  "task_rejected",
  "note_created",
  "note_deleted",
  "canvas_intent",
  "pool_note",
  "agent_spawn",
  "agent_stop",
  "rank_change",
]);

const MEDIA_FEED_KINDS = new Set([
  "media_pending",
  "media_rendering",
  "media_complete",
  "media_failed",
  "media_blocked",
]);

/** Events that change the knowledge graph snippet we show per-entity. */
const NOTE_GRAPH_MUTATION_TYPES = new Set([
  "note_created",
  "note_deleted",
  "note_link_created",
  "note_link_deleted",
]);

// ── Entity Activity Section (API + event feed fallback) ─────────────────────

export const EntityActivitySection = memo(function EntityActivitySection({
  entityName,
  apiActivity,
}: {
  entityName: string;
  apiActivity?: { timestamp: number; type: string; input?: string }[];
}) {
  // Fallback: filter global event feed for this entity
  const eventFeed = useWorldState((s) => s.eventFeed);
  const feedActivity = useMemo(
    () => eventFeed.filter((e) => e.entity === entityName).slice(0, 30),
    [eventFeed, entityName],
  );

  const activity = apiActivity && apiActivity.length > 0 ? apiActivity : feedActivity;

  if (activity.length === 0) {
    return (
      <CascadeSection title="Activity">
        <div style={{ color: "#555", padding: "4px 0", fontFamily: "'VT323', monospace" }}>
          No recent activity
        </div>
      </CascadeSection>
    );
  }

  return (
    <CascadeSection title={`Activity (${activity.length})`}>
      {activity.slice(0, 20).map((act, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: activity log has no stable per-row id; timestamps can collide
          key={`${act.timestamp}-${i}`}
          className="uc-feed-item"
          style={{ padding: "clamp(4px, 0.3vw, 6px) 0" }}
        >
          <span className="uc-feed-time">
            {new Date(act.timestamp).toLocaleTimeString("en", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span
            style={{
              color:
                act.type === "error" || act.type === "agent_error"
                  ? "var(--color-danger)"
                  : "var(--color-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {("input" in act ? act.input : null) ?? act.type}
          </span>
        </div>
      ))}
    </CascadeSection>
  );
});

// ── Compass Section ─────────────────────────────────────────────────────────

const COMPASS_COLORS: Record<string, string> = {
  online: "#06b6d4",
  projects: "var(--color-primary)",
  tasks: "#84cc16",
  claimed: "#d946ef",
  intents: "#facc15",
  pools: "#3b82f6",
  memories: "#22c55e",
};

export const CompassSection = memo(function CompassSection({ entityName }: { entityName: string }) {
  const { data: brief } = useEntityBrief(entityName);
  useInvalidateOnEvent(
    ["entityBrief", entityName],
    useCallback(
      (e: DashboardEvent) =>
        BRIEF_MUTATION_TYPES.has(e.type) &&
        (e.entity === entityName || e.name === entityName || e.authorName === entityName),
      [entityName],
    ),
  );
  if (!brief) return null;

  const badges: { label: string; value: number; color: string }[] = [];
  if (brief.onlineCount > 0)
    badges.push({ label: "online", value: brief.onlineCount, color: COMPASS_COLORS.online! });
  if (brief.projectCount > 0)
    badges.push({ label: "projects", value: brief.projectCount, color: COMPASS_COLORS.projects! });
  if (brief.openTaskCount > 0)
    badges.push({ label: "tasks", value: brief.openTaskCount, color: COMPASS_COLORS.tasks! });
  if (brief.claimedTaskCount > 0)
    badges.push({
      label: "claimed",
      value: brief.claimedTaskCount,
      color: COMPASS_COLORS.claimed!,
    });
  if (brief.pendingIntents > 0)
    badges.push({ label: "intents", value: brief.pendingIntents, color: COMPASS_COLORS.intents! });
  if (brief.poolCount > 0)
    badges.push({ label: "pools", value: brief.poolCount, color: COMPASS_COLORS.pools! });
  if (brief.memoryCount > 0)
    badges.push({ label: "memories", value: brief.memoryCount, color: COMPASS_COLORS.memories! });

  if (badges.length === 0 && !brief.goal && !brief.topTask) return null;

  return (
    <CascadeSection title="Compass">
      {badges.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", padding: "2px 0 4px" }}>
          {badges.map((b) => (
            <span
              key={b.label}
              style={{
                fontSize: "clamp(11px, 0.75vw, 15px)",
                padding: "1px 6px",
                border: `1px solid ${b.color}`,
                color: b.color,
                fontFamily: "'VT323', monospace",
                borderRadius: "2px",
              }}
            >
              {b.value} {b.label}
            </span>
          ))}
        </div>
      )}
      {brief.goal && (
        <PropRow label="Goal" value={brief.goal.slice(0, 80)} valueColor="var(--color-primary)" />
      )}
      {brief.focus && (
        <PropRow
          label="Focus"
          value={brief.focus.slice(0, 80)}
          valueColor="var(--color-teal, #2dd4bf)"
        />
      )}
      {brief.topTask && (
        <PropRow
          label="Task"
          value={`#${brief.topTask.id} ${brief.topTask.title}${brief.topTask.progress > 0 ? ` (${brief.topTask.progress}%)` : ""}`}
          valueColor="var(--color-accent)"
        />
      )}
    </CascadeSection>
  );
});

// ── Knowledge Graph Section ─────────────────────────────────────────────────

const LINK_COLORS: Record<string, string> = {
  supports: "#22c55e",
  contradicts: "#ef4444",
  extends: "#3b82f6",
  exemplifies: "#d946ef",
  relates_to: "#6b7280",
  supersedes: "#f59e0b",
};

export const KnowledgeGraphSection = memo(function KnowledgeGraphSection({
  entityName,
}: {
  entityName: string;
}) {
  const { data: graph } = useNoteGraph(entityName);
  useInvalidateOnEvent(
    ["noteGraph", entityName],
    useCallback(
      (e: DashboardEvent) =>
        NOTE_GRAPH_MUTATION_TYPES.has(e.type) &&
        (e.entity === entityName || e.authorName === entityName),
      [entityName],
    ),
  );
  if (!graph || graph.length === 0) return null;

  return (
    <CascadeSection title={`Knowledge Graph (${graph.length})`} defaultOpen={false}>
      {graph.map((entry) => (
        <div
          key={entry.noteId}
          style={{
            padding: "clamp(4px, 0.25vw, 6px) 0",
            borderBottom: "1px solid rgba(17,17,24,0.2)",
          }}
        >
          <div
            style={{ fontSize: "clamp(12px, 0.83vw, 16px)", color: "#bbb", marginBottom: "2px" }}
          >
            <span style={{ color: "#666" }}>#{entry.noteId}</span>{" "}
            {entry.content.length > 100 ? `${entry.content.slice(0, 100)}...` : entry.content}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "3px" }}>
            {entry.links.map((link) => (
              <span
                key={`${link.relationship}-${link.targetId}`}
                style={{
                  fontSize: "clamp(10px, 0.68vw, 13px)",
                  padding: "0px 4px",
                  color: LINK_COLORS[link.relationship] ?? "#888",
                  border: `1px solid ${LINK_COLORS[link.relationship] ?? "#444"}`,
                  borderRadius: "2px",
                  fontFamily: "'VT323', monospace",
                }}
              >
                {link.relationship} #{link.targetId}
              </span>
            ))}
          </div>
        </div>
      ))}
    </CascadeSection>
  );
});

export const MediaSection = memo(function MediaSection({
  entityName,
  sendCommand,
}: {
  entityName: string;
  sendCommand?: (command: string) => void;
}) {
  const queryClient = useQueryClient();
  const mediaQuery = useMediaJobs(entityName);
  const { data: jobs, isLoading, isError } = mediaQuery;
  useInvalidateOnEvent(
    ["media-jobs", entityName],
    useCallback(
      (event: DashboardEvent) =>
        event.type === "feed_event" && MEDIA_FEED_KINDS.has(event.kind ?? ""),
      [],
    ),
  );

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["media-jobs", entityName] });
  }, [entityName, queryClient]);

  const handleRetry = useCallback(
    async (job: MediaJob) => {
      try {
        const res = await authFetch(`${API_BASE}/api/media-jobs/${job.id}/retry`, {
          method: "POST",
        });
        if (!res.ok) {
          throw new Error(`Retry failed (${res.status})`);
        }
        invalidate();
      } catch (error) {
        console.error("[media] retry failed", error);
      }
    },
    [invalidate],
  );

  const handleDeleteAsset = useCallback(
    async (job: MediaJob) => {
      if (!job.assetId) return;
      try {
        const res = await authFetch(`${API_BASE}/api/assets/${job.assetId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`Delete failed (${res.status})`);
        }
        invalidate();
      } catch (error) {
        console.error("[media] delete asset failed", error);
      }
    },
    [invalidate],
  );

  return (
    <CascadeSection title={`Media (${jobs?.length ?? 0})`} defaultOpen={false}>
      {isLoading && <div style={{ fontSize: "11px", color: "#888" }}>Loading media activity…</div>}
      {isError && (
        <div className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-2 text-[11px] text-danger">
          <span>Failed to load media jobs.</span>
          <button
            type="button"
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
            onClick={() => void mediaQuery.refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {!isLoading && !isError && (
        <MediaJobsList
          jobs={jobs ?? []}
          onRetry={handleRetry}
          onDeleteAsset={handleDeleteAsset}
          sendCommand={sendCommand}
          emptyMessage="No media jobs yet."
        />
      )}
    </CascadeSection>
  );
});
