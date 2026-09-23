// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar coordination tab bodies — clickable lists that drill down into a
 * CoordDetail (projects, tasks, boards, pools, groups, channels, macros) plus
 * the merged Integrations tab (connectors + adapters).
 * Extracted mechanically from CommandBar.tsx — no behavior change.
 */

import { memo, useCallback, useState } from "react";
import {
  useAdapters,
  useBoards,
  useChannels,
  useConnectors,
  useDynamicCommands,
  useGroups,
  useMemoryPools,
  useProjects,
  useTasks,
} from "../../../hooks/use-api";
import type {
  AdapterStatus,
  BoardEntry,
  ChannelEntry,
  ConnectorEntry,
  DynamicCommandEntry,
  GroupEntry,
  MemoryPool,
  ProjectEntry,
  TaskEntry,
} from "../../../lib/types";
import { ActionBtn, CoordEmpty, CoordLoading, statusDotClass, taskStatusIcon } from "./shared";

export const PoolsTabClickable = memo(function PoolsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useMemoryPools();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="pools" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((p: MemoryPool) => (
        <button
          type="button"
          key={p.id}
          className="uc-coord-item"
          style={{
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
          onClick={() => onSelect(p.id)}
        >
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              by {p.created_by}
              {p.group_id ? ` | group: ${p.group_id}` : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const ProjectsTabClickable = memo(function ProjectsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useProjects();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="projects" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((p: ProjectEntry) => (
        <button
          type="button"
          key={p.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(p.id)}
        >
          <div className={`uc-coord-dot ${statusDotClass(p.status)}`} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              {p.status} | {p.orchestration}
              {p.bundleProgress
                ? ` | ${p.bundleProgress.done}/${p.bundleProgress.total} tasks`
                : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const TasksTabClickable = memo(function TasksTabClickable({
  onSelect,
}: {
  onSelect: (id: number) => void;
}) {
  const { data, isLoading } = useTasks();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="tasks" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((t: TaskEntry) => (
        <button
          type="button"
          key={t.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(t.id)}
        >
          <span
            style={{
              fontSize: "clamp(16px, 1.12vw, 22px)",
              color:
                t.status === "open"
                  ? "var(--color-success)"
                  : t.status === "claimed"
                    ? "var(--color-secondary)"
                    : "#444",
              flexShrink: 0,
              width: "18px",
              textAlign: "center",
            }}
            title={t.status}
          >
            {taskStatusIcon(t.status)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">
              <span style={{ color: "#555" }}>#{t.id}</span> {t.title}
            </div>
            <div className="uc-coord-meta">
              {t.status} | by {t.creator_name}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const BoardsTabClickable = memo(function BoardsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useBoards();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="boards" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((b: BoardEntry) => (
        <button
          type="button"
          key={b.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(b.name)}
        >
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{b.name}</div>
            <div className="uc-coord-meta">
              {b.scope_type} | {b.postCount} post{b.postCount !== 1 ? "s" : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const GroupsTabClickable = memo(function GroupsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useGroups();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="groups" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((g: GroupEntry) => (
        <button
          type="button"
          key={g.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(g.name)}
        >
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{g.name}</div>
            <div className="uc-coord-meta">
              {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
              {g.description ? ` | ${g.description}` : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const ChannelsTabClickable = memo(function ChannelsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useChannels();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="channels" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((c: ChannelEntry) => (
        <button
          type="button"
          key={c.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(c.name)}
        >
          <div className="uc-coord-dot active" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">#{c.name}</div>
            <div className="uc-coord-meta">
              {c.type} | {c.messageCount} message{c.messageCount !== "1" ? "s" : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

export const IntegrationsTab = memo(function IntegrationsTab({
  onSelect,
  sendCommand: _sendCommand,
}: {
  onSelect: (id: string) => void;
  sendCommand?: (cmd: string) => void;
}) {
  const { data: connectors, isLoading: connLoading } = useConnectors();
  const { data: adapters, isLoading: adpLoading, refetch: refetchAdapters } = useAdapters();
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState("");
  const [token, setToken] = useState("");

  const handleAdd = useCallback(async () => {
    if (!platform || !token) return;
    try {
      const { postApi } = await import("../../../lib/api");
      await postApi("/api/adapters", { platform, config: JSON.stringify({ token }) });
      setPlatform("");
      setToken("");
      setAdding(false);
      refetchAdapters();
    } catch {
      /* */
    }
  }, [platform, token, refetchAdapters]);

  const handleToggle = useCallback(
    async (p: string, currentlyRunning: boolean) => {
      try {
        const { putApi } = await import("../../../lib/api");
        await putApi(`/api/adapters/${encodeURIComponent(p)}`, {
          status: currentlyRunning ? "disabled" : "active",
        });
        refetchAdapters();
      } catch {
        /* */
      }
    },
    [refetchAdapters],
  );

  const handleDelete = useCallback(
    async (p: string) => {
      try {
        const { deleteApi } = await import("../../../lib/api");
        await deleteApi(`/api/adapters/${encodeURIComponent(p)}`);
        refetchAdapters();
      } catch {
        /* */
      }
    },
    [refetchAdapters],
  );

  if (connLoading && adpLoading) return <CoordLoading />;

  const inputStyle = {
    width: "100%",
    background: "rgba(17,17,24,0.6)",
    border: "1px solid var(--color-border)",
    color: "#ddd",
    fontFamily: "'VT323', monospace",
    fontSize: "clamp(14px, 0.95vw, 18px)",
    padding: "3px 8px",
    outline: "none",
  } as const;

  return (
    <div className="uc-cmd-msgs">
      {/* Add integration */}
      <div style={{ padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {adding ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              style={inputStyle}
            >
              <option value="">Platform...</option>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
            </select>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                platform === "telegram"
                  ? "Bot token from @BotFather"
                  : platform === "discord"
                    ? "Discord bot token"
                    : "Bot token..."
              }
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "4px" }}>
              <ActionBtn label="CONNECT" color="#22c55e" onClick={handleAdd} />
              <ActionBtn label="CANCEL" onClick={() => setAdding(false)} />
            </div>
          </div>
        ) : (
          <ActionBtn label="+ INTEGRATION" color="#22c55e" onClick={() => setAdding(true)} />
        )}
      </div>

      {/* Adapters (runtime integrations) */}
      {(adapters ?? []).map((a: AdapterStatus) => (
        <div key={a.platform} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className={`uc-coord-dot ${a.running ? "active" : "done"}`} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{a.platform}</div>
            <div className="uc-coord-meta">
              {a.running ? "Running" : a.status} | {a.source}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle(a.platform, a.running)}
            style={{
              background: "none",
              border: "none",
              color: a.running ? "#f59e0b" : "#22c55e",
              cursor: "pointer",
              fontFamily: "'VT323'",
              fontSize: "12px",
              padding: "2px 6px",
            }}
            title={a.running ? "Disable" : "Enable"}
            aria-label={`${a.running ? "Stop" : "Start"} ${a.platform} adapter`}
          >
            {a.running ? "STOP" : "START"}
          </button>
          {a.source === "db" && (
            <button
              type="button"
              onClick={() => handleDelete(a.platform)}
              style={{
                background: "none",
                border: "none",
                color: "#ef4444",
                cursor: "pointer",
                fontFamily: "'VT323'",
                fontSize: "12px",
                padding: "2px 6px",
                opacity: 0.6,
              }}
              title="Remove"
              aria-label={`Remove ${a.platform} integration`}
            >
              <span aria-hidden="true">x</span>
            </button>
          )}
        </div>
      ))}

      {/* Connectors (configured connections) */}
      {(connectors ?? []).map((c: ConnectorEntry) => (
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
          }}
          onClick={() => onSelect(c.id)}
        >
          <div
            className={`uc-coord-dot ${c.status === "connected" || c.status === "active" ? "active" : c.status === "error" ? "done" : "pending"}`}
            aria-hidden="true"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              {c.transport} | {c.status}
              {c.url ? ` | ${c.url}` : ""}
            </div>
          </div>
        </button>
      ))}

      {(adapters ?? []).length === 0 && (connectors ?? []).length === 0 && (
        <div
          style={{
            padding: "16px",
            textAlign: "center",
            color: "#888",
            fontSize: "clamp(14px, 0.95vw, 18px)",
          }}
        >
          No integrations configured. Add Telegram or Discord above.
        </div>
      )}
    </div>
  );
});

export const CommandsTabClickable = memo(function CommandsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useDynamicCommands();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="commands" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((c: DynamicCommandEntry) => (
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
          }}
          onClick={() => onSelect(c.id)}
        >
          <div className={`uc-coord-dot ${c.valid ? "active" : "done"}`} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              v{c.version} | {c.valid ? "valid" : "invalid"} | by {c.created_by}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});
