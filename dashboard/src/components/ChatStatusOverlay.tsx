// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useMediaJobs } from "../hooks/use-api";
import { useChatState } from "../hooks/use-chat-state";
import { type useCodingSessionDetail, useCodingSessionsSnapshot } from "../hooks/use-coding";
import { useFeedState } from "../hooks/use-feed-state";
import {
  useBoardsSnapshot,
  useChannelsSnapshot,
  useGroupsSnapshot,
  useTasksSnapshot,
} from "../hooks/use-status-cards";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { authFetch } from "../lib/api";
import { apiOrigin } from "../lib/api-origin";
import type { OverlayState } from "../lib/chat-overlay";
import { draftCommand } from "../lib/command-discovery";
import type { MediaJob } from "../lib/types";
import {
  type CodeMessageData,
  codeStatusTone,
  formatTimestamp,
  parseMetadata,
} from "../lib/webchat-format";
import { PinToCanvas } from "./CanvasReference";
import { createCodeRenderers } from "./ChatCodeRenderers";
import { FavoriteCommandButton } from "./CommandFavorites";
import { BoardDetailView, ChannelDetailView } from "./CoordinationCard";
import { renderChatText as renderTextContent } from "./chat-render-text";
import { MediaJobsList } from "./MediaJobsList";
import { StatusOverlay } from "./StatusOverlay";

const API_BASE = apiOrigin();
type OverlayType = OverlayState["type"];

export function ChatStatusOverlay({
  overlay,
  closeOverlay,
  activeCodingSessionId,
  codingDetailQuery,
  copy,
  copied,
  sendCommandWithOverlay,
}: {
  overlay: OverlayState | null;
  closeOverlay(): void;
  activeCodingSessionId: string | null;
  codingDetailQuery: ReturnType<typeof useCodingSessionDetail>;
  copy(text: string, key: number | "all"): Promise<void>;
  copied: number | "all" | null;
  sendCommandWithOverlay(command: string, target?: { sessionId: string }): boolean;
}) {
  const messages = useChatState((s) => s.messages);
  // Artifact id whose full content is expanded in the coding-artifacts overlay.
  const [inspectedArtifactId, setInspectedArtifactId] = useState<string | null>(null);

  useEffect(() => {
    // Drop any expanded artifact when the artifacts overlay closes.
    if (overlay?.type !== "coding-artifacts") {
      setInspectedArtifactId(null);
    }
  }, [overlay]);

  const feedEvents = useFeedState((s) => s.events);
  const tasksQuery = useTasksSnapshot(overlay?.type === "tasks");
  const boardsQuery = useBoardsSnapshot(overlay?.type === "boards");
  const channelsQuery = useChannelsSnapshot(overlay?.type === "channels");
  const groupsQuery = useGroupsSnapshot(overlay?.type === "groups");
  const mediaEntity =
    overlay?.type === "media" ? (overlay.params?.entityName as string | undefined) : undefined;
  const mediaQuery = useMediaJobs(mediaEntity, overlay?.type === "media");
  const refetchMediaJobs = mediaQuery.refetch;
  const codingSessionsQuery = useCodingSessionsSnapshot(overlay?.type === "coding-sessions");
  const refetchCodingDetail = codingDetailQuery.refetch;

  useEffect(() => {
    if (overlay?.type !== "coding-artifacts") return;
    const latest = messages.at(-1);
    const code = latest?.perception?.data?.code as CodeMessageData | undefined;
    if (code?.sessionId === activeCodingSessionId) void refetchCodingDetail();
  }, [activeCodingSessionId, messages, overlay, refetchCodingDetail]);

  useEffect(() => {
    if (overlay?.type === "media") {
      refetchMediaJobs();
    }
  }, [overlay, refetchMediaJobs]);

  useEffect(() => {
    if (overlay?.type === "media") {
      const latest = feedEvents[0];
      if (latest?.kind?.startsWith("media_")) {
        refetchMediaJobs();
      }
    }
  }, [feedEvents, overlay, refetchMediaJobs]);

  const { renderCodeBlock, renderApprovalCard, renderCrewDispatchedCard, renderSessionTaskChip } =
    createCodeRenderers({ copy, copied, sendCommandWithOverlay, renderTextContent });

  const renderTasksOverlay = () => {
    if (overlay?.type !== "tasks") return null;
    if (tasksQuery.isLoading) return <div className="py-4 text-text-dim">Loading tasks…</div>;
    if (tasksQuery.isError) {
      return <div className="py-4 text-danger">Failed to load tasks snapshot.</div>;
    }
    const scope = (overlay.params?.scope as string | undefined) ?? "open";
    const groupId = overlay.params?.group as string | undefined;
    const items = tasksQuery.data?.items ?? [];
    const total = tasksQuery.data?.total ?? items.length;
    const filtered =
      scope === "mine"
        ? items
        : items.filter((item) => item.status?.toLowerCase() === scope.toLowerCase());
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      const key = (item.status ?? "unknown").toLowerCase();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>
            Scope:{" "}
            {scope === "mine"
              ? "My claimed tasks (engine output)"
              : scope === "open"
                ? "Open"
                : scope.charAt(0).toUpperCase() + scope.slice(1)}
            {groupId ? ` · Group ${groupId}` : ""}
          </span>
          <span>
            {filtered.length} shown · total {total}
          </span>
        </div>
        {scope === "mine" && (
          <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            Overlay filtering for <code>mine</code> mirrors the engine output; snapshot shows all
            tasks for quick context.
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-[10px] text-text-dim">
          {Object.entries(counts).map(([status, count]) => (
            <span
              key={status}
              className="rounded border border-border/70 bg-bg px-2 py-0.5 capitalize text-text"
            >
              {status}: {count}
            </span>
          ))}
        </div>
        <div className="space-y-2">
          {filtered.map((task) => (
            <div key={task.id} className="rounded border border-border bg-bg px-3 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-text-bright">
                  {task.title}
                </span>
                <span className="text-[10px] uppercase text-primary">{task.status}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-text-dim">
                <span>ID #{task.id}</span>
                <span>Created by {task.creator_name ?? "—"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`task info ${task.id}`)}
                >
                  Info
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => draftCommand(`task claim ${task.id}`)}
                >
                  Claim
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No tasks match this scope.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderBoardsOverlay = () => {
    if (overlay?.type !== "boards") return null;
    if (boardsQuery.isLoading) return <div className="py-4 text-text-dim">Loading boards…</div>;
    if (boardsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load boards snapshot.</div>;
    }
    const boards = boardsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Boards</span>
          <span>{boards.length} total</span>
        </div>
        <div className="space-y-2">
          {boards.map((board) => (
            <div key={board.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{board.name}</span>
                <span className="text-[10px] uppercase text-primary">
                  {board.scope_type ?? "general"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-text-dim">
                <span>{board.postCount} posts</span>
                <button
                  type="button"
                  className="text-primary"
                  onClick={() => draftCommand(`board read ${board.name}`)}
                >
                  Draft read
                </button>
                <span>{new Date(board.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="text-xs text-primary"
                  onClick={() => draftCommand(`board post ${board.name} `)}
                >
                  Draft post
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`board read ${board.name}`)}
                >
                  Show board
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => {
                    useWorkspaceState.getState().inspect({ type: "board", name: board.name });
                    closeOverlay();
                  }}
                >
                  Recent posts
                </button>
              </div>
            </div>
          ))}
          {boards.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No boards available yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelsOverlay = () => {
    if (overlay?.type !== "channels") return null;
    if (channelsQuery.isLoading) return <div className="py-4 text-text-dim">Loading channels…</div>;
    if (channelsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load channels snapshot.</div>;
    }
    const channels = channelsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Channels</span>
          <span>{channels.length} total</span>
        </div>
        <div className="space-y-2">
          {channels.map((channel) => (
            <div key={channel.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{channel.name}</span>
                <span className="text-[10px] uppercase text-primary">{channel.type}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-text-dim">
                <span>{channel.messageCount} messages</span>
                <span>ID {channel.id.slice(0, 8)}…</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => draftCommand(`channel join ${channel.name}`)}
                >
                  Join
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`channel history ${channel.name}`)}
                >
                  History
                </button>
              </div>
            </div>
          ))}
          {channels.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No channels available yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderGroupsOverlay = () => {
    if (overlay?.type !== "groups") return null;
    if (groupsQuery.isLoading) return <div className="py-4 text-text-dim">Loading groups…</div>;
    if (groupsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load groups snapshot.</div>;
    }
    const groups = groupsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Groups</span>
          <span>{groups.length} total</span>
        </div>
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{group.name}</span>
                <span className="text-[10px] uppercase text-primary">
                  {group.memberCount} members
                </span>
              </div>
              <div className="mt-1 text-[10px] text-text-dim">
                Lead: {group.leader_id?.slice(0, 8) ?? "—"}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`group members ${group.name}`)}
                >
                  Members
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`group info ${group.name}`)}
                >
                  Group info
                </button>
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No groups defined yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMediaOverlay = () => {
    if (overlay?.type !== "media") return null;
    const targetEntity = overlay.params?.entityName as string | undefined;

    const handleRetry = async (job: MediaJob) => {
      try {
        const res = await authFetch(`${API_BASE}/api/media-jobs/${job.id}/retry`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`Retry failed (${res.status})`);
        await mediaQuery.refetch();
      } catch (error) {
        console.error("[media] retry failed", error);
      }
    };

    const handleDelete = async (job: MediaJob) => {
      if (!job.assetId) return;
      try {
        const res = await authFetch(`${API_BASE}/api/assets/${job.assetId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
        await mediaQuery.refetch();
      } catch (error) {
        console.error("[media] delete asset failed", error);
      }
    };

    return (
      <div className="space-y-3">
        {targetEntity && (
          <div className="text-[10px] uppercase text-text-dim">
            Jobs for <span className="text-text-bright">{targetEntity}</span>
          </div>
        )}
        {mediaQuery.isLoading && (
          <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
            Loading media jobs…
          </div>
        )}
        {mediaQuery.isError && (
          <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-danger">
            Failed to load media jobs.
          </div>
        )}
        {!mediaQuery.isLoading && !mediaQuery.isError && (
          <MediaJobsList
            jobs={mediaQuery.data ?? []}
            max={15}
            showEntity={!targetEntity}
            onRetry={handleRetry}
            onDeleteAsset={handleDelete}
            sendCommand={sendCommandWithOverlay}
            emptyMessage="No media jobs recorded yet."
          />
        )}
      </div>
    );
  };

  const renderCodingSessionsOverlay = () => {
    if (overlay?.type !== "coding-sessions") return null;
    if (codingSessionsQuery.isLoading) {
      return <div className="py-4 text-text-dim">Loading coding sessions…</div>;
    }
    if (codingSessionsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load coding sessions snapshot.</div>;
    }
    const sessions = codingSessionsQuery.data?.items ?? [];
    const total = codingSessionsQuery.data?.total ?? sessions.length;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Coding sessions</span>
          <span>{total} total</span>
        </div>
        <div className="space-y-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                sendCommandWithOverlay(`code resume ${session.id}`);
                closeOverlay();
              }}
              className="block w-full rounded border border-border bg-bg px-3 py-2 text-left shadow-sm transition-colors hover:border-primary"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-text-bright">
                  {session.title || session.id}
                </span>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase ${codeStatusTone(
                    session.status,
                  )}`}
                >
                  {session.status}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-text-dim">
                {session.workspace_root}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-dim">
                <span className="font-mono">{session.id}</span>
                <span>updated {formatTimestamp(session.updated_at)}</span>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No coding sessions yet. Run <code>code start</code> to begin one.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCodingArtifactsOverlay = () => {
    if (overlay?.type !== "coding-artifacts") return null;
    if (!activeCodingSessionId) {
      return (
        <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
          No active coding session. Resume or start one to inspect its artifacts.
        </div>
      );
    }
    if (codingDetailQuery.isLoading) {
      return <div className="py-4 text-text-dim">Loading artifacts…</div>;
    }
    if (codingDetailQuery.isError) {
      return <div className="py-4 text-danger">Failed to load coding session detail.</div>;
    }
    const artifacts = codingDetailQuery.data?.artifacts ?? [];
    const session = codingDetailQuery.data?.session;
    const inspected = artifacts.find((a) => a.id === inspectedArtifactId) ?? null;
    const grouped = artifacts.reduce<Record<string, typeof artifacts>>((acc, artifact) => {
      (acc[artifact.kind] ??= []).push(artifact);
      return acc;
    }, {});
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Artifacts · {session?.title || activeCodingSessionId}</span>
          <span>{artifacts.length} total</span>
        </div>
        {inspected && (
          <div className="rounded border border-primary/40 bg-primary/5 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-text-bright">
                {inspected.title || inspected.id}
              </span>
              <button
                type="button"
                onClick={() => setInspectedArtifactId(null)}
                className="shrink-0 rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
              >
                Collapse
              </button>
            </div>
            {activeCodingSessionId && (
              <PinToCanvas
                reference={{ kind: "artifact", id: inspected.id, sessionId: activeCodingSessionId }}
              />
            )}
            {renderCodeBlock(
              inspected.content_text,
              inspected.content_text.startsWith("diff --git") ? "diff" : "text",
            )}
          </div>
        )}
        <div className="space-y-3">
          {Object.entries(grouped).map(([kind, group]) => (
            <div key={kind} className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-text-dim">
                {kind} · {group.length}
              </div>
              {group.map((artifact) => {
                const meta = parseMetadata(artifact.metadata_json);
                if (kind === "approval" || kind === "spawn_request") {
                  return (
                    <div key={artifact.id}>
                      {renderApprovalCard({
                        id: artifact.id,
                        kind: artifact.kind,
                        title: artifact.title,
                        status: artifact.status,
                        requestedBy:
                          artifact.created_by ??
                          (typeof meta.requestedBy === "string" ? meta.requestedBy : undefined),
                        decidedBy:
                          artifact.applied_by ??
                          (typeof meta.decidedBy === "string" ? meta.decidedBy : undefined),
                        decidedAt:
                          artifact.applied_at ??
                          (typeof meta.decidedAt === "number" ? meta.decidedAt : undefined),
                        description: artifact.content_text?.trim() || undefined,
                      })}
                    </div>
                  );
                }
                if (kind === "crew_dispatched") {
                  return (
                    <div key={artifact.id}>{renderCrewDispatchedCard(meta, artifact.title)}</div>
                  );
                }
                if (kind === "session_task") {
                  return <div key={artifact.id}>{renderSessionTaskChip(meta, artifact.title)}</div>;
                }
                return (
                  <button
                    key={artifact.id}
                    type="button"
                    onClick={() =>
                      setInspectedArtifactId((cur) => (cur === artifact.id ? null : artifact.id))
                    }
                    className={`block w-full rounded border bg-bg px-3 py-2 text-left transition-colors hover:border-primary ${
                      inspectedArtifactId === artifact.id ? "border-primary" : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-semibold text-text-bright">
                        {artifact.title || artifact.id}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase ${codeStatusTone(
                          artifact.status,
                        )}`}
                      >
                        {artifact.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-dim">
                      <span className="font-mono">{artifact.id}</span>
                      <span>{formatTimestamp(artifact.updated_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
          {artifacts.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No artifacts in this session yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const overlayTitle: Record<OverlayType, string> = {
    tasks: "Task Snapshot",
    boards: "Boards Snapshot",
    "board-posts": "Board posts",
    "channel-messages": "Channel messages",
    channels: "Channels Snapshot",
    groups: "Groups Snapshot",
    media: "Media Jobs",
    "coding-sessions": "Coding Sessions",
    "coding-artifacts": "Coding Artifacts",
  };

  const renderOverlayContent = () => {
    if (!overlay) return null;
    switch (overlay.type) {
      case "tasks":
        return renderTasksOverlay();
      case "boards":
        return renderBoardsOverlay();
      case "board-posts":
        return <BoardDetailView name={String(overlay.params?.name ?? "")} />;
      case "channel-messages":
        return <ChannelDetailView name={String(overlay.params?.name ?? "")} />;
      case "channels":
        return renderChannelsOverlay();
      case "groups":
        return renderGroupsOverlay();
      case "media":
        return renderMediaOverlay();
      case "coding-sessions":
        return renderCodingSessionsOverlay();
      case "coding-artifacts":
        return renderCodingArtifactsOverlay();
      default:
        return null;
    }
  };

  const statusOverlay = overlay ? (
    <StatusOverlay
      open
      title={overlayTitle[overlay.type]}
      onClose={closeOverlay}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="truncate text-text-dim">
            Command: <code className="text-text">{overlay.issuedFrom}</code>
            <FavoriteCommandButton command={overlay.issuedFrom} />
            <button
              type="button"
              onClick={() => draftCommand(overlay.issuedFrom)}
              className="ml-2 text-primary"
            >
              Copy command to input
            </button>
          </span>
          <button
            type="button"
            onClick={closeOverlay}
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
          >
            Close
          </button>
        </div>
      }
    >
      {renderOverlayContent()}
    </StatusOverlay>
  ) : null;

  return statusOverlay;
}
