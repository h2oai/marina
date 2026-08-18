// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  FolderKanban,
  Hash,
  Layers,
  MessageSquare,
  Plug,
  UsersRound,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import {
  useBoardDetail,
  useBoardPosts,
  useBoards,
  useChannelDetail,
  useChannelMessages,
  useChannels,
  useConnectors,
  useDynamicCommands,
  useGroupDetail,
  useGroups,
  useMemoryPools,
  useProjects,
  useTaskDetail,
  useTasksPaged,
} from "../hooks/use-api";
import { useInvalidateOnEvent } from "../hooks/use-realtime";
import type { DashboardEvent } from "../lib/types";
import { cn, formatTime } from "../lib/utils";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";

type Section =
  | "projects"
  | "boards"
  | "tasks"
  | "channels"
  | "groups"
  | "pools"
  | "connectors"
  | "commands"
  | null;

const SECTIONS: Section[] = [
  "projects",
  "tasks",
  "boards",
  "groups",
  "channels",
  "pools",
  "connectors",
  "commands",
];

// Detail view navigation state
type DetailView =
  | { type: "task"; id: number }
  | { type: "board"; name: string }
  | { type: "group"; name: string }
  | { type: "channel"; name: string }
  | { type: "project"; id: string }
  | { type: "connector"; id: string }
  | { type: "command"; id: string }
  | { type: "pool"; id: string }
  | null;

export function CoordinationCard({
  backContent,
  isFocused,
  onToggleFocus,
}: { backContent?: React.ReactNode } & PanelFocusProps) {
  const [expanded, setExpanded] = useState<Section>(null);
  const [highlightedSection, setHighlightedSection] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailView>(null);

  const toggle = useCallback(
    (section: Section) => setExpanded((prev) => (prev === section ? null : section)),
    [],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (detail) {
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          setDetail(null);
        }
        return;
      }
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setHighlightedSection((prev) => {
            if (prev === null) return 0;
            return Math.min(prev + 1, SECTIONS.length - 1);
          });
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setHighlightedSection((prev) => {
            if (prev === null) return SECTIONS.length - 1;
            return Math.max(prev - 1, 0);
          });
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (highlightedSection !== null) {
            const section = SECTIONS[highlightedSection]!;
            toggle(section);
          }
          break;
        case "Home":
          e.preventDefault();
          setHighlightedSection(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedSection(SECTIONS.length - 1);
          break;
        case "Escape":
          if (expanded) {
            setExpanded(null);
          } else {
            setHighlightedSection(null);
          }
          break;
      }
    },
    [highlightedSection, expanded, detail, toggle],
  );

  return (
    <GlassPanel
      title="Coordination"
      icon={<Layers size={14} />}
      backContent={backContent}
      isFocused={isFocused}
      onToggleFocus={onToggleFocus}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: scroll container with roving keyboard nav over child section rows, not click-activation */}
      <div
        onKeyDown={onKeyDown}
        className="flex flex-col text-[11px] outline-none overflow-y-auto flex-1"
      >
        {detail ? (
          <DetailPanel detail={detail} onBack={() => setDetail(null)} onNavigate={setDetail} />
        ) : (
          <>
            <SectionRow
              label="Projects"
              icon={<FolderKanban size={11} />}
              isOpen={expanded === "projects"}
              isHighlighted={highlightedSection === 0}
              onClick={() => toggle("projects")}
            >
              <ProjectsList onSelect={(id) => setDetail({ type: "project", id })} />
            </SectionRow>

            <SectionRow
              label="Tasks"
              icon={<Hash size={11} />}
              isOpen={expanded === "tasks"}
              isHighlighted={highlightedSection === 1}
              onClick={() => toggle("tasks")}
            >
              <TasksList onSelect={(id) => setDetail({ type: "task", id })} />
            </SectionRow>

            <SectionRow
              label="Boards"
              icon={<ClipboardList size={11} />}
              isOpen={expanded === "boards"}
              isHighlighted={highlightedSection === 2}
              onClick={() => toggle("boards")}
            >
              <BoardsList onSelect={(name) => setDetail({ type: "board", name })} />
            </SectionRow>

            <SectionRow
              label="Groups"
              icon={<UsersRound size={11} />}
              isOpen={expanded === "groups"}
              isHighlighted={highlightedSection === 3}
              onClick={() => toggle("groups")}
            >
              <GroupsList onSelect={(name) => setDetail({ type: "group", name })} />
            </SectionRow>

            <SectionRow
              label="Channels"
              icon={<MessageSquare size={11} />}
              isOpen={expanded === "channels"}
              isHighlighted={highlightedSection === 4}
              onClick={() => toggle("channels")}
            >
              <ChannelsList onSelect={(name) => setDetail({ type: "channel", name })} />
            </SectionRow>

            <SectionRow
              label="Pools"
              icon={<Layers size={11} />}
              isOpen={expanded === "pools"}
              isHighlighted={highlightedSection === 5}
              onClick={() => toggle("pools")}
            >
              <PoolsList onSelect={(id) => setDetail({ type: "pool", id })} />
            </SectionRow>

            <SectionRow
              label="Connectors"
              icon={<Plug size={11} />}
              isOpen={expanded === "connectors"}
              isHighlighted={highlightedSection === 6}
              onClick={() => toggle("connectors")}
            >
              <ConnectorsList onSelect={(id) => setDetail({ type: "connector", id })} />
            </SectionRow>

            <SectionRow
              label="Commands"
              icon={<Code2 size={11} />}
              isOpen={expanded === "commands"}
              isHighlighted={highlightedSection === 7}
              onClick={() => toggle("commands")}
            >
              <CommandsList onSelect={(id) => setDetail({ type: "command", id })} />
            </SectionRow>
          </>
        )}
      </div>
    </GlassPanel>
  );
}

// --- Detail Panel (drill-down view) ---

function DetailPanel({
  detail,
  onBack,
  onNavigate,
}: {
  detail: NonNullable<DetailView>;
  onBack: () => void;
  onNavigate: (view: DetailView) => void;
}) {
  const label =
    detail.type === "task"
      ? `Task #${detail.id}`
      : detail.type === "board"
        ? `Board: ${detail.name}`
        : detail.type === "group"
          ? `Group: ${detail.name}`
          : detail.type === "channel"
            ? `#${detail.name}`
            : detail.type === "project"
              ? "Project"
              : detail.type === "connector"
                ? "Connector"
                : detail.type === "command"
                  ? "Command"
                  : "Pool";

  return (
    <motion.div
      className="flex flex-col flex-1 min-h-0"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-2 py-1.5 text-text-dim hover:text-text-bright transition-colors border-b border-border shrink-0"
      >
        <ArrowLeft size={11} />
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </button>
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {detail.type === "task" && <TaskDetailView id={detail.id} onNavigate={onNavigate} />}
        {detail.type === "board" && <BoardDetailView name={detail.name} />}
        {detail.type === "group" && <GroupDetailView name={detail.name} />}
        {detail.type === "channel" && <ChannelDetailView name={detail.name} />}
        {detail.type === "project" && <ProjectDetailView id={detail.id} onNavigate={onNavigate} />}
        {detail.type === "connector" && <ConnectorDetailView id={detail.id} />}
        {detail.type === "command" && <CommandDetailView id={detail.id} />}
        {detail.type === "pool" && <PoolDetailView id={detail.id} />}
      </div>
    </motion.div>
  );
}

// --- Detail Views ---

function TaskDetailView({
  id,
  onNavigate,
}: {
  id: number;
  onNavigate: (view: DetailView) => void;
}) {
  const { data, isLoading } = useTaskDetail(id);
  useInvalidateOnEvent(
    ["taskDetail", id],
    useCallback(
      (e: DashboardEvent) =>
        e.taskId === id &&
        (e.type === "task_claimed" ||
          e.type === "task_submitted" ||
          e.type === "task_approved" ||
          e.type === "task_rejected"),
      [id],
    ),
  );

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState text="Task not found" />;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">
          #{data.id} {data.title}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusBadge status={data.status} />
          <span className="text-text-dim text-[10px]">{formatTime(data.created_at)}</span>
        </div>
      </div>
      {data.description && (
        <div className="text-text text-[10px] leading-relaxed">{data.description}</div>
      )}
      <DetailRow label="Creator" value={data.creator_name} />
      {data.assignee_name && <DetailRow label="Assignee" value={data.assignee_name} />}
      {data.parent_task_id && (
        <DetailRow label="Parent task">
          <button
            type="button"
            onClick={() => onNavigate({ type: "task", id: data.parent_task_id! })}
            className="text-primary hover:underline"
          >
            #{data.parent_task_id}
          </button>
        </DetailRow>
      )}
      {data.children && data.children.length > 0 && (
        <div>
          <SectionLabel text="Subtasks" />
          <div className="flex flex-col gap-0.5">
            {data.children.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onNavigate({ type: "task", id: c.id })}
                className="flex items-center gap-1.5 py-0.5 hover:bg-bg-hover transition-colors text-left rounded px-1 -mx-1"
              >
                <StatusBadge status={c.status} />
                <span className="text-text truncate flex-1">
                  #{c.id} {c.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const POSTS_PAGE = 25;

function BoardDetailView({ name }: { name: string }) {
  const { data, isLoading } = useBoardDetail(name);
  const [limit, setLimit] = useState(POSTS_PAGE);
  const { data: paged } = useBoardPosts(name, limit);
  const invalidate = useCallback(
    (e: DashboardEvent) => e.type === "board_post" && e.ref === name,
    [name],
  );
  useInvalidateOnEvent(["boardDetail", name], invalidate);
  useInvalidateOnEvent(["boardPosts", name], invalidate);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState text="Board not found" />;

  const posts = paged?.items ?? data.posts;
  const total = paged?.total ?? data.postCount;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{data.name}</div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-dim">
          <span>{data.scope_type}</span>
          <span>{data.postCount} posts</span>
        </div>
      </div>
      {posts.length > 0 ? (
        <div>
          <SectionLabel text="Posts" />
          <div className="flex flex-col gap-1.5">
            {posts.map((p) => (
              <div key={p.id} className="border-l-2 border-border pl-2 py-0.5">
                <div className="text-text-bright text-[10px] font-medium">{p.title}</div>
                <div className="text-text text-[10px] leading-relaxed line-clamp-3">{p.body}</div>
                <div className="flex gap-2 mt-0.5 text-[9px] text-text-dim">
                  <span>{p.author_name}</span>
                  <span>{formatTime(p.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
          <LoadMore
            shown={posts.length}
            total={total}
            onMore={() => setLimit((n) => n + POSTS_PAGE)}
          />
        </div>
      ) : (
        <EmptyState text="No posts yet" />
      )}
    </div>
  );
}

function GroupDetailView({ name }: { name: string }) {
  const { data, isLoading } = useGroupDetail(name);
  useInvalidateOnEvent(
    ["groupDetail", name],
    useCallback(
      (e: DashboardEvent) =>
        e.type === "coordination_change" && e.resource === "group" && e.name === name,
      [name],
    ),
  );

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState text="Group not found" />;

  const rankLabel = (rank: number) => (rank === 2 ? "admin" : rank === 1 ? "officer" : "member");

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{data.name}</div>
        <div className="text-text-dim text-[10px] mt-0.5">{data.memberCount} members</div>
      </div>
      {data.description && (
        <div className="text-text text-[10px] leading-relaxed">{data.description}</div>
      )}
      <DetailRow label="Leader" value={data.leader_id} />
      {data.members.length > 0 && (
        <div>
          <SectionLabel text="Members" />
          <div className="flex flex-col gap-0.5">
            {data.members.map((m) => (
              <div
                key={m.entity_id}
                className="flex items-center justify-between py-0.5 text-[10px]"
              >
                <span className="text-text">{m.entity_id}</span>
                <span
                  className={cn(
                    "text-[9px] px-1 rounded",
                    m.rank === 2
                      ? "text-primary bg-primary/10"
                      : m.rank === 1
                        ? "text-warning bg-warning/10"
                        : "text-text-dim",
                  )}
                >
                  {rankLabel(m.rank)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const MESSAGES_PAGE = 25;

function ChannelDetailView({ name }: { name: string }) {
  const { data, isLoading } = useChannelDetail(name);
  const [limit, setLimit] = useState(MESSAGES_PAGE);
  const { data: paged } = useChannelMessages(name, limit);
  const invalidate = useCallback(
    (e: DashboardEvent) => e.type === "channel_message" && (e.ref === name || e.kind === name),
    [name],
  );
  useInvalidateOnEvent(["channelDetail", name], invalidate);
  useInvalidateOnEvent(["channelMessages", name], invalidate);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState text="Channel not found" />;

  const messages = paged?.items ?? data.messages;
  const total = paged?.total ?? messages.length;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">#{data.name}</div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-dim">
          <span>{data.type}</span>
        </div>
      </div>
      {messages.length > 0 ? (
        <div>
          <SectionLabel text="Messages" />
          <div className="flex flex-col gap-1">
            {messages.map((m) => (
              <div key={`${m.sender_name}-${m.created_at}`} className="text-[10px]">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-secondary font-medium shrink-0">{m.sender_name}</span>
                  <span className="text-text-dim text-[9px] shrink-0">
                    {formatTime(m.created_at)}
                  </span>
                </div>
                <div className="text-text leading-relaxed pl-0">{m.content}</div>
              </div>
            ))}
          </div>
          <LoadMore
            shown={messages.length}
            total={total}
            onMore={() => setLimit((n) => n + MESSAGES_PAGE)}
          />
        </div>
      ) : (
        <EmptyState text="No messages" />
      )}
    </div>
  );
}

function ProjectDetailView({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (view: DetailView) => void;
}) {
  const { data, isLoading } = useProjects();

  if (isLoading) return <LoadingState />;
  const project = data?.find((p) => p.id === id);
  if (!project) return <EmptyState text="Project not found" />;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{project.name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusBadge status={project.status} />
          <span className="text-text-dim text-[10px]">{project.orchestration}</span>
        </div>
      </div>
      {project.description && (
        <div className="text-text text-[10px] leading-relaxed">{project.description}</div>
      )}
      <DetailRow label="Memory arch" value={project.memory_arch} />
      <DetailRow label="Created by" value={project.created_by} />
      {project.group_id && <DetailRow label="Group" value={project.group_id} />}
      {project.pool_id && <DetailRow label="Pool" value={project.pool_id} />}
      {project.bundle_id && (
        <DetailRow label="Bundle task">
          <button
            type="button"
            onClick={() => onNavigate({ type: "task", id: project.bundle_id! })}
            className="text-primary hover:underline"
          >
            #{project.bundle_id}
          </button>
        </DetailRow>
      )}
      {project.bundleProgress && (
        <div>
          <SectionLabel text="Bundle Progress" />
          <div className="flex justify-between text-[10px] text-text-dim mb-0.5">
            <span>
              {project.bundleProgress.done} / {project.bundleProgress.total} completed
            </span>
            <span>
              {project.bundleProgress.total > 0
                ? Math.round((project.bundleProgress.done / project.bundleProgress.total) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-bg-hover">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width:
                  project.bundleProgress.total > 0
                    ? `${(project.bundleProgress.done / project.bundleProgress.total) * 100}%`
                    : "0%",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectorDetailView({ id }: { id: string }) {
  const { data, isLoading } = useConnectors();

  if (isLoading) return <LoadingState />;
  const connector = data?.find((c) => c.id === id);
  if (!connector) return <EmptyState text="Connector not found" />;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{connector.name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusDot status={connector.status} />
          <span className="text-text-dim text-[10px]">{connector.status}</span>
        </div>
      </div>
      <DetailRow label="Transport" value={connector.transport} />
      {connector.url && <DetailRow label="URL" value={connector.url} />}
      {connector.auth_type && <DetailRow label="Auth" value={connector.auth_type} />}
      <DetailRow label="Created by" value={connector.created_by} />
    </div>
  );
}

function CommandDetailView({ id }: { id: string }) {
  const { data, isLoading } = useDynamicCommands();

  if (isLoading) return <LoadingState />;
  const command = data?.find((c) => c.id === id);
  if (!command) return <EmptyState text="Command not found" />;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{command.name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusDot status={command.valid ? "connected" : "error"} />
          <span className="text-text-dim text-[10px]">{command.valid ? "valid" : "invalid"}</span>
        </div>
      </div>
      <DetailRow label="Version" value={`v${command.version}`} />
      <DetailRow label="Created by" value={command.created_by} />
      <DetailRow label="Created at" value={formatTime(command.created_at)} />
    </div>
  );
}

function PoolDetailView({ id }: { id: string }) {
  const { data, isLoading } = useMemoryPools();

  if (isLoading) return <LoadingState />;
  const pool = data?.find((p) => p.id === id);
  if (!pool) return <EmptyState text="Pool not found" />;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-text-bright font-semibold text-xs">{pool.name}</div>
      </div>
      <DetailRow label="Created by" value={pool.created_by} />
      {pool.group_id && <DetailRow label="Group" value={pool.group_id} />}
    </div>
  );
}

// --- Shared detail components ---

function DetailRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="text-text-dim shrink-0">{label}:</span>
      {children ?? <span className="text-text">{value}</span>}
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <div className="text-primary text-[9px] uppercase tracking-wider mb-1 mt-0.5">{text}</div>;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "text-[9px] px-1 py-px rounded",
        status === "open" || status === "active"
          ? "text-success bg-success/10"
          : status === "claimed" || status === "paused"
            ? "text-warning bg-warning/10"
            : status === "submitted"
              ? "text-secondary bg-secondary/10"
              : "text-text-dim bg-bg-hover",
      )}
    >
      {status}
    </span>
  );
}

function LoadingState() {
  return <div className="text-text-dim text-[10px] py-2">Loading...</div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-text-dim text-[10px] py-2">{text}</div>;
}

/**
 * Empty-state with an actionable hint. Shown when a coordination section has
 * no items yet — tells the user exactly what command populates it.
 */
function EmptyHint({ item, command }: { item: string; command: string }) {
  return (
    <div className="py-1 space-y-0.5 text-[10px]">
      <div className="text-text-dim">No {item} yet.</div>
      <div className="text-text-dim/60">
        Try <code className="text-primary/80">{command}</code>
      </div>
    </div>
  );
}

// --- Section Row (collapsible) ---

function SectionRow({
  label,
  icon,
  isOpen,
  isHighlighted,
  onClick,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  isOpen: boolean;
  isHighlighted?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex items-center gap-2 px-2 py-1 hover:bg-bg-hover transition-colors",
          isOpen && "bg-bg-hover",
          isHighlighted && "ring-1 ring-primary/40",
        )}
      >
        <span className="text-secondary">{icon}</span>
        <span className="flex-1 text-left text-text-bright">{label}</span>
        {isOpen ? (
          <ChevronDown size={10} className="text-text-dim" />
        ) : (
          <ChevronRight size={10} className="text-text-dim" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { type: "spring", stiffness: 200, damping: 28 },
              opacity: { duration: 0.25 },
            }}
            className="border-t border-border bg-bg-card px-2 py-1 overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// --- Status helpers ---

const statusColor: Record<string, string> = {
  open: "text-success",
  claimed: "text-warning",
  submitted: "text-secondary",
  completed: "text-text-dim",
  active: "text-success",
  paused: "text-warning",
  archived: "text-text-dim",
  connected: "text-success",
  disconnected: "text-danger",
  error: "text-danger",
};

function StatusDot({ status }: { status: string }) {
  const color =
    status === "connected" || status === "active"
      ? "var(--color-success)"
      : status === "error" || status === "disconnected"
        ? "var(--color-danger)"
        : "var(--color-text-dim)";
  return (
    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
  );
}

/**
 * "Showing N of M" footer with a Load-more button. Rendered only when more
 * rows exist than are currently shown; clicking grows the page via onMore.
 */
function LoadMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-0.5 w-full rounded px-1 py-0.5 text-left text-[10px] text-secondary hover:bg-bg-hover transition-colors"
    >
      Load more — showing {shown} of {total} ▾
    </button>
  );
}

// --- List components (now with onSelect callbacks) ---

function ProjectsList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading } = useProjects();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="projects" command="project create <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect(p.id)}
          className="flex w-full items-center gap-1.5 py-0.5 hover:bg-bg-hover transition-colors text-left rounded px-1 -mx-1"
        >
          <span className="text-text-bright truncate flex-1">{p.name}</span>
          <span className="text-text-dim text-[10px]">{p.orchestration}</span>
          <span className={cn("text-[10px]", statusColor[p.status] ?? "text-text-dim")}>
            {p.status}
          </span>
        </button>
      ))}
    </div>
  );
}

const TASKS_PAGE = 50;

function TasksList({ onSelect }: { onSelect: (id: number) => void }) {
  const [limit, setLimit] = useState(TASKS_PAGE);
  const { data, isLoading } = useTasksPaged(limit);
  useInvalidateOnEvent(
    ["tasksPaged"],
    useCallback(
      (e: DashboardEvent) =>
        (e.type === "coordination_change" && e.resource === "project") ||
        e.type === "task_claimed" ||
        e.type === "task_submitted" ||
        e.type === "task_approved" ||
        e.type === "task_rejected",
      [],
    ),
  );

  if (isLoading && !data) return <div className="text-text-dim">Loading...</div>;
  if (!data?.items.length) return <EmptyHint item="tasks" command="task create <title>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className="flex w-full items-center gap-1.5 py-0.5 hover:bg-bg-hover transition-colors text-left rounded px-1 -mx-1"
        >
          <span className={cn("text-[10px]", statusColor[t.status] ?? "text-text-dim")}>
            [{t.status}]
          </span>
          <span className="truncate text-text flex-1">
            #{t.id} {t.title}
          </span>
        </button>
      ))}
      <LoadMore
        shown={data.items.length}
        total={data.total}
        onMore={() => setLimit((n) => n + TASKS_PAGE)}
      />
    </div>
  );
}

function BoardsList({ onSelect }: { onSelect: (name: string) => void }) {
  const { data, isLoading } = useBoards();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="boards" command="board create <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onSelect(b.name)}
          className="flex w-full justify-between py-0.5 hover:bg-bg-hover transition-colors rounded px-1 -mx-1"
        >
          <span className="text-text">{b.name}</span>
          <span className="text-text-dim">{b.postCount} posts</span>
        </button>
      ))}
    </div>
  );
}

function GroupsList({ onSelect }: { onSelect: (name: string) => void }) {
  const { data, isLoading } = useGroups();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="groups" command="group create <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => onSelect(g.name)}
          className="flex w-full justify-between py-0.5 hover:bg-bg-hover transition-colors rounded px-1 -mx-1"
        >
          <span className="text-text">{g.name}</span>
          <span className="text-text-dim">{g.memberCount} members</span>
        </button>
      ))}
    </div>
  );
}

function ChannelsList({ onSelect }: { onSelect: (name: string) => void }) {
  const { data, isLoading } = useChannels();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="channels" command="channel create <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.name)}
          className="flex w-full justify-between py-0.5 hover:bg-bg-hover transition-colors rounded px-1 -mx-1"
        >
          <span className="text-text">#{c.name}</span>
          <span className="text-text-dim">{c.type}</span>
        </button>
      ))}
    </div>
  );
}

function PoolsList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading } = useMemoryPools();
  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="memory pools" command="pool create <name>" />;
  return (
    <div className="flex flex-col gap-0.5">
      {data.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect(p.id)}
          className="flex w-full justify-between py-0.5 hover:bg-bg-hover transition-colors rounded px-1 -mx-1"
        >
          <span className="text-text">{p.name}</span>
          <span className="text-text-dim">by {p.created_by}</span>
        </button>
      ))}
    </div>
  );
}

function ConnectorsList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading } = useConnectors();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="connectors" command="connector register <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className="flex w-full items-center gap-1.5 py-0.5 hover:bg-bg-hover transition-colors text-left rounded px-1 -mx-1"
        >
          <span className="text-text-bright truncate flex-1">{c.name}</span>
          <span className="text-text-dim text-[10px]">{c.transport}</span>
          <StatusDot status={c.status} />
        </button>
      ))}
    </div>
  );
}

function CommandsList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading } = useDynamicCommands();

  if (isLoading) return <div className="text-text-dim">Loading...</div>;
  if (!data?.length) return <EmptyHint item="dynamic commands" command="command define <name>" />;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className="flex w-full items-center gap-1.5 py-0.5 hover:bg-bg-hover transition-colors text-left rounded px-1 -mx-1"
        >
          <span className="text-text-bright truncate flex-1">{c.name}</span>
          <span className="text-text-dim text-[10px]">v{c.version}</span>
          <StatusDot status={c.valid ? "connected" : "error"} />
        </button>
      ))}
    </div>
  );
}
