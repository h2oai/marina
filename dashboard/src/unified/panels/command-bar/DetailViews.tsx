// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar drill-down detail views for coordination items (task, board,
 * group, channel, project, pool, connector, macro command).
 * Extracted mechanically from CommandBar.tsx — no behavior change apart from
 * the orchestration pattern list, which is now fetched from
 * GET /api/orchestration/patterns (single-sourced from
 * src/world/templates/orchestration.ts) with the former hand-copied list kept
 * only as the loading fallback.
 */

import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useState } from "react";
import {
  useBoardDetail,
  useChannelDetail,
  useConnectors,
  useDynamicCommands,
  useGroupDetail,
  useMemoryPools,
  useProjects,
  useTaskDetail,
} from "../../../hooks/use-api";
import { fetchApi } from "../../../lib/api";
import {
  ActionBtn,
  type CoordDetail,
  CoordEmpty,
  CoordLoading,
  DetailLink,
  type DetailProps,
  InlinePrompt,
} from "./shared";

export const CoordDetailView = memo(function CoordDetailView({
  detail,
  onBack,
  onNavigate,
  onEntityClick,
  sendCommand,
}: {
  detail: CoordDetail;
  onBack: () => void;
  onNavigate: (detail: CoordDetail) => void;
  onEntityClick?: (name: string) => void;
  sendCommand?: (cmd: string) => void;
}) {
  const dp: DetailProps = { onNavigate, onEntityClick, sendCommand };
  return (
    <div className="uc-cmd-msgs" style={{ display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--color-border)",
          color: "#bbb",
          cursor: "pointer",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(14px, 0.98vw, 20px)",
          flexShrink: 0,
        }}
      >
        &larr; Back
      </button>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 12px" }}>
        {detail.kind === "task" && <TaskDetailInline id={detail.id} {...dp} />}
        {detail.kind === "board" && <BoardDetailInline name={detail.name} {...dp} />}
        {detail.kind === "group" && <GroupDetailInline name={detail.name} {...dp} />}
        {detail.kind === "channel" && <ChannelDetailInline name={detail.name} {...dp} />}
        {detail.kind === "project" && <ProjectDetailInline id={detail.id} {...dp} />}
        {detail.kind === "pool" && <PoolDetailInline id={detail.id} {...dp} />}
        {detail.kind === "connector" && <ConnectorDetailInline id={detail.id} {...dp} />}
        {detail.kind === "command" && <CommandDetailInline id={detail.id} {...dp} />}
      </div>
    </div>
  );
});

const TaskDetailInline = memo(function TaskDetailInline({
  id,
  onNavigate,
  onEntityClick,
  sendCommand,
}: { id: number } & DetailProps) {
  const { data, isLoading } = useTaskDetail(id);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="task" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        #{data.id} {data.title}
      </div>
      <div className="uc-coord-meta">Status: {data.status}</div>
      <div className="uc-coord-meta">
        Creator:{" "}
        <DetailLink label={data.creator_name} onClick={() => onEntityClick?.(data.creator_name)} />
      </div>
      {data.assignee_name && (
        <div className="uc-coord-meta">
          Assignee:{" "}
          <DetailLink
            label={data.assignee_name}
            onClick={() => onEntityClick?.(data.assignee_name!)}
          />
        </div>
      )}
      {data.description && (
        <div className="uc-coord-meta" style={{ color: "#bbb", marginTop: "4px" }}>
          {data.description}
        </div>
      )}
      {/* Action buttons */}
      <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
        {data.status === "open" && sendCommand && (
          <ActionBtn
            label="CLAIM"
            color="#22c55e"
            onClick={() => sendCommand(`task claim ${data.id}`)}
          />
        )}
        {data.status === "claimed" && sendCommand && (
          <ActionBtn
            label="SUBMIT"
            color="#06b6d4"
            onClick={() => sendCommand(`task submit ${data.id}`)}
          />
        )}
        {data.status === "submitted" && sendCommand && (
          <ActionBtn
            label="COMPLETE"
            color="var(--color-primary)"
            onClick={() => sendCommand(`task complete ${data.id}`)}
          />
        )}
      </div>
      {data.children && data.children.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <div className="uc-coord-meta" style={{ color: "var(--color-primary)" }}>
            Subtasks:
          </div>
          {data.children.map((c) => (
            <button
              type="button"
              key={c.id}
              className="uc-coord-item"
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "3px 0",
              }}
              onClick={() => onNavigate({ kind: "task", id: c.id })}
            >
              <div
                className={`uc-coord-dot ${c.status === "completed" ? "active" : c.status === "open" ? "pending" : "claimed"}`}
                aria-hidden="true"
              />
              <span className="uc-coord-meta" style={{ color: "var(--color-teal)" }}>
                #{c.id} {c.title} [{c.status}]
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const BoardDetailInline = memo(function BoardDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useBoardDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="board" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {data.name}
      </div>
      <div className="uc-coord-meta">
        {data.scope_type} | {data.postCount} posts
      </div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <InlinePrompt
            label="POST"
            placeholder="Title | Body text..."
            color="var(--color-teal)"
            onSubmit={(text) => sendCommand(`board post ${name} ${text}`)}
          />
        </div>
      )}
      {data.posts?.map((p) => (
        <div
          key={p.id}
          style={{
            borderLeft: "2px solid var(--color-border)",
            paddingLeft: "8px",
            marginTop: "6px",
          }}
        >
          <div className="uc-coord-title" style={{ fontSize: "clamp(14px, 0.98vw, 20px)" }}>
            #{p.id} {p.title}
          </div>
          <div className="uc-coord-meta">{p.body.slice(0, 200)}</div>
          <div className="uc-coord-meta">
            by <DetailLink label={p.author_name} onClick={() => onEntityClick?.(p.author_name)} />
          </div>
          {sendCommand && (
            <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
              <InlinePrompt
                label="REPLY"
                placeholder="Reply text..."
                color="var(--color-teal)"
                onSubmit={(t) => sendCommand(`board reply ${p.id} ${t}`)}
              />
              <ActionBtn
                label="+1"
                color="#22c55e"
                onClick={() => sendCommand(`board vote ${p.id} up`)}
              />
              <ActionBtn
                label="-1"
                color="#ef4444"
                onClick={() => sendCommand(`board vote ${p.id} down`)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

const GroupDetailInline = memo(function GroupDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useGroupDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="group" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {data.name}
      </div>
      <div className="uc-coord-meta">{data.memberCount} members</div>
      {data.description && <div className="uc-coord-meta">{data.description}</div>}
      <div className="uc-coord-meta">
        Leader:{" "}
        <DetailLink label={data.leader_id} onClick={() => onEntityClick?.(data.leader_id)} />
      </div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <ActionBtn
            label="JOIN"
            color="#22c55e"
            onClick={() => sendCommand(`group join ${name}`)}
          />
          <ActionBtn
            label="LEAVE"
            color="#ef4444"
            onClick={() => sendCommand(`group leave ${name}`)}
          />
        </div>
      )}
      {data.members.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          <div
            className="uc-coord-meta"
            style={{ color: "var(--color-primary)", marginBottom: "4px" }}
          >
            Members:
          </div>
          {data.members.map((m) => (
            <button
              type="button"
              key={m.entity_id}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 0",
              }}
              onClick={() => onEntityClick?.(m.entity_id)}
            >
              <span className="uc-coord-meta" style={{ color: "var(--color-teal)" }}>
                {m.entity_id}
              </span>
              <span className="uc-coord-meta"> (rank {m.rank})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const ChannelDetailInline = memo(function ChannelDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useChannelDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="channel" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        #{data.name}
      </div>
      <div className="uc-coord-meta">{data.type}</div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <ActionBtn
            label="SUBSCRIBE"
            color="#22c55e"
            onClick={() => sendCommand(`channel sub ${name}`)}
          />
          <InlinePrompt
            label="SEND"
            placeholder="Type message..."
            color="var(--color-teal)"
            onSubmit={(text) => sendCommand(`channel send ${name} ${text}`)}
          />
        </div>
      )}
      {data.messages?.map((m) => (
        <div
          key={`${m.sender_name}-${m.created_at}`}
          style={{
            marginTop: "4px",
            borderLeft: "2px solid var(--color-border)",
            paddingLeft: "8px",
          }}
        >
          <div className="uc-coord-meta">
            <DetailLink
              label={m.sender_name}
              color="var(--color-secondary)"
              onClick={() => onEntityClick?.(m.sender_name)}
            />
          </div>
          <div className="uc-coord-meta">{m.content}</div>
        </div>
      ))}
    </div>
  );
});

// ── Orchestration patterns (single-sourced from the server) ─────────────────

/** One orchestration pattern as served by GET /api/orchestration/patterns. */
export interface OrchestrationPatternOption {
  id: string;
  name: string;
  description: string;
  fit?: string;
}

/**
 * LOADING FALLBACK ONLY — the authoritative list is
 * src/world/templates/orchestration.ts, served by /api/orchestration/patterns.
 * This copy is shown until the fetch resolves (or when the server is
 * unreachable) so the select never renders empty; it is not kept in sync by hand.
 */
export const ORCHESTRATION_PATTERNS_FALLBACK: OrchestrationPatternOption[] = [
  "deliberation",
  "chorus",
  "foundry",
  "swarm",
  "pipeline",
  "debate",
  "mapreduce",
  "blackboard",
  "symbiosis",
  "research",
  "custom",
].map((id) => ({ id, name: id, description: "" }));

/** Fetch the orchestration pattern catalogue; falls back to the static copy while loading. */
export function useOrchestrationPatterns(): {
  patterns: OrchestrationPatternOption[];
  fromServer: boolean;
} {
  const { data } = useQuery({
    queryKey: ["orchestration", "patterns"],
    queryFn: () =>
      fetchApi<{ patterns: OrchestrationPatternOption[] }>("/api/orchestration/patterns"),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const serverPatterns = data?.patterns;
  if (serverPatterns && serverPatterns.length > 0) {
    return { patterns: serverPatterns, fromServer: true };
  }
  return { patterns: ORCHESTRATION_PATTERNS_FALLBACK, fromServer: false };
}

const ProjectDetailInline = memo(function ProjectDetailInline({
  id,
  onNavigate: _onNavigate,
  onEntityClick,
}: { id: string } & DetailProps) {
  const { data, isLoading, refetch } = useProjects();
  const { patterns: orchestrationPatterns, fromServer: patternsFromServer } =
    useOrchestrationPatterns();
  const [changingOrch, setChangingOrch] = useState(false);

  const handleOrchChange = useCallback(
    async (newOrch: string, projectId: string) => {
      setChangingOrch(true);
      try {
        const { postApi } = await import("../../../lib/api");
        await postApi(`/api/coordination/projects/${encodeURIComponent(projectId)}/orchestration`, {
          orchestration: newOrch,
        });
        refetch();
      } finally {
        setChangingOrch(false);
      }
    },
    [refetch],
  );

  if (isLoading) return <CoordLoading />;
  const project = data?.find((p) => p.id === id);
  if (!project) return <CoordEmpty label="project" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {project.name}
      </div>
      <div className="uc-coord-meta">
        {project.status} | {project.orchestration}
      </div>
      {project.description && <div className="uc-coord-meta">{project.description}</div>}
      <div className="uc-coord-meta">Memory: {project.memory_arch}</div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink
          label={project.created_by}
          onClick={() => onEntityClick?.(project.created_by)}
        />
      </div>
      {project.bundleProgress && (
        <div className="uc-coord-meta">
          Progress: {project.bundleProgress.done}/{project.bundleProgress.total} tasks
        </div>
      )}
      <div style={{ marginTop: "8px" }}>
        <div
          style={{
            fontSize: "clamp(8px, 0.55vw, 10px)",
            color: "#888",
            fontFamily: "'Press Start 2P', monospace",
            marginBottom: "4px",
          }}
        >
          ORCHESTRATION
        </div>
        <select
          aria-label="Orchestration pattern"
          value={project.orchestration}
          disabled={changingOrch}
          onChange={(e) => handleOrchChange(e.target.value, project.id)}
          style={{
            width: "100%",
            background: "rgba(17,17,24,0.6)",
            border: "1px solid var(--color-border)",
            color: "#ddd",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(14px, 0.95vw, 18px)",
            padding: "3px 8px",
            outline: "none",
          }}
        >
          {orchestrationPatterns.map((p) => (
            <option key={p.id} value={p.id} title={p.description || undefined}>
              {p.name}
              {p.fit ? ` — ${p.fit}` : ""}
            </option>
          ))}
        </select>
        {!patternsFromServer && (
          <div className="uc-coord-meta" style={{ color: "#666" }}>
            pattern list: built-in fallback (server catalogue not loaded)
          </div>
        )}
      </div>
    </div>
  );
});

const PoolDetailInline = memo(function PoolDetailInline({
  id,
  onEntityClick,
  sendCommand,
}: { id: string } & DetailProps) {
  const { data, isLoading } = useMemoryPools();
  if (isLoading) return <CoordLoading />;
  const pool = data?.find((p) => p.id === id);
  if (!pool) return <CoordEmpty label="pool" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {pool.name}
      </div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink label={pool.created_by} onClick={() => onEntityClick?.(pool.created_by)} />
      </div>
      {pool.group_id && <div className="uc-coord-meta">Group: {pool.group_id}</div>}
      {sendCommand && (
        <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
          <ActionBtn
            label="RECALL"
            color="var(--color-teal)"
            onClick={() => sendCommand(`pool recall ${pool.name}`)}
          />
        </div>
      )}
    </div>
  );
});

const ConnectorDetailInline = memo(function ConnectorDetailInline({ id }: { id: string }) {
  const { data, isLoading } = useConnectors();
  if (isLoading) return <CoordLoading />;
  const connector = data?.find((c) => c.id === id);
  if (!connector) return <CoordEmpty label="connector" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {connector.name}
      </div>
      <div className="uc-coord-meta">Transport: {connector.transport}</div>
      <div className="uc-coord-meta">
        Status:{" "}
        <span
          style={{
            color:
              connector.status === "connected" || connector.status === "active"
                ? "#22c55e"
                : connector.status === "error"
                  ? "#ef4444"
                  : "#888",
          }}
        >
          {connector.status}
        </span>
      </div>
      {connector.url && <div className="uc-coord-meta">URL: {connector.url}</div>}
      {connector.auth_type && <div className="uc-coord-meta">Auth: {connector.auth_type}</div>}
      <div className="uc-coord-meta">Created by: {connector.created_by}</div>
    </div>
  );
});

const CommandDetailInline = memo(function CommandDetailInline({
  id,
  onEntityClick,
  sendCommand,
}: { id: string } & DetailProps) {
  const { data, isLoading } = useDynamicCommands();
  if (isLoading) return <CoordLoading />;
  const command = data?.find((c) => c.id === id);
  if (!command) return <CoordEmpty label="command" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {command.name}
      </div>
      <div className="uc-coord-meta">Version: {command.version}</div>
      <div className="uc-coord-meta">
        Valid:{" "}
        <span style={{ color: command.valid ? "#22c55e" : "#ef4444" }}>
          {command.valid ? "Yes" : "No"}
        </span>
      </div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink
          label={command.created_by}
          onClick={() => onEntityClick?.(command.created_by)}
        />
      </div>
      {command.created_at > 0 && (
        <div className="uc-coord-meta">
          Created: {new Date(command.created_at).toLocaleDateString()}
        </div>
      )}
      {sendCommand && (
        <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
          <ActionBtn
            label="RUN"
            color="var(--color-teal)"
            onClick={() => sendCommand(command.name)}
          />
          <ActionBtn
            label="VIEW CODE"
            color="#888"
            onClick={() => sendCommand(`build command code ${command.name}`)}
          />
          <ActionBtn
            label="VALIDATE"
            color="#22c55e"
            onClick={() => sendCommand(`build command validate ${command.name}`)}
          />
          <ActionBtn
            label="RELOAD"
            color="var(--color-primary)"
            onClick={() => sendCommand(`build command reload ${command.name}`)}
          />
          <ActionBtn
            label="DELETE"
            color="#ef4444"
            onClick={() => sendCommand(`build command destroy ${command.name}`)}
          />
        </div>
      )}
    </div>
  );
});
