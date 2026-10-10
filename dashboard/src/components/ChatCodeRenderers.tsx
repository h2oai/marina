// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  Activity,
  Check,
  CheckCircle2,
  CircleMinus,
  Code2,
  Copy,
  FileText,
  GitBranch,
  GitPullRequest,
  List,
  Network,
  Sparkles,
  Terminal,
  TriangleAlert,
  Users,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { verificationLabel } from "../lib/verification-outcome";
import {
  approvalBadgeTone,
  type CodeMessageData,
  type CodeTreeNode,
  codeStatusTone,
  diffStats,
  formatTimestamp,
  messageText,
  parseCrewMembers,
  parseMetadata,
} from "../lib/webchat-format";
import { DiffViewer } from "./DiffViewer";
import { VisualEvidenceDetails } from "./VisualEvidenceDetails";

/** Shared code transcript and artifact rendering; all actions use the caller's command path. */
export function createCodeRenderers({
  copy,
  copied,
  sendCommandWithOverlay,
  renderTextContent,
}: {
  copy(text: string, key: number | "all"): Promise<void>;
  copied: number | "all" | null;
  sendCommandWithOverlay(command: string, target?: { sessionId: string }): boolean;
  renderTextContent(text: string, className?: string): ReactNode;
}) {
  const renderCodeActions = (commands?: string[], sessionId?: string) => {
    const actionable = (commands ?? []).filter((cmd) => cmd && !cmd.includes("<"));
    if (actionable.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actionable.map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() =>
              sessionId ? sendCommandWithOverlay(cmd, { sessionId }) : sendCommandWithOverlay(cmd)
            }
            className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:border-primary hover:bg-primary/20"
          >
            {cmd}
          </button>
        ))}
      </div>
    );
  };

  const renderCodeBlock = (content: string, variant: "diff" | "output" | "text") => {
    if (variant === "diff") return <DiffViewer patch={content} />;
    const lines = content.trimEnd().split("\n");
    const stats = diffStats(content);
    return (
      <div className="mt-2 overflow-hidden rounded border border-border/70 bg-black/30">
        <div className="flex items-center justify-between gap-2 border-border/60 border-b px-2 py-1 font-mono text-[10px] text-text-dim">
          <span>{variant === "output" ? "output" : "text"}</span>
          <span>
            {stats
              ? `${stats.files} file${stats.files === 1 ? "" : "s"} +${stats.additions} -${stats.deletions}`
              : `${lines.length} line${lines.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <pre className="max-h-[420px] overflow-auto p-2 font-mono text-[11px] leading-relaxed text-text">
          {lines.map((line, idx) => {
            const color =
              variant === "output" && line === "--- stderr ---" ? "text-yellow-200" : "text-text";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rendered terminal blocks preserve line order; content has no stable ids
                key={idx}
                className={`grid grid-cols-[3ch_minmax(0,1fr)] gap-2 whitespace-pre-wrap break-words ${color}`}
              >
                <span className="select-none text-right text-text-dim/50">{idx + 1}</span>
                <span>{line || " "}</span>
              </div>
            );
          })}
        </pre>
      </div>
    );
  };

  const renderCodeTree = (nodes: CodeTreeNode[] | undefined, depth = 0): ReactNode => {
    if (!nodes || nodes.length === 0) return null;
    return (
      <div className={depth === 0 ? "mt-2 space-y-1" : "mt-1 space-y-1"}>
        {nodes.map((node) => (
          <div key={node.id ?? `${depth}-${node.title}`} className="font-mono text-[11px]">
            <div
              className={`flex items-center gap-1.5 rounded px-2 py-1 ${
                node.active ? "border border-primary/50 bg-primary/10 text-primary" : "text-text"
              }`}
              style={{ marginLeft: depth * 14 }}
            >
              <GitBranch size={12} />
              <span className="font-semibold">{node.id}</span>
              <span className="rounded bg-bg-hover px-1 py-0.5 text-[9px] text-text-dim">
                {node.status}
              </span>
              <span className="truncate">{node.title}</span>
            </div>
            {renderCodeTree(node.children, depth + 1)}
          </div>
        ))}
      </div>
    );
  };

  const renderCodeChecks = (checks: CodeMessageData["checks"]) => {
    if (!checks || checks.length === 0) return null;
    return (
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {checks.map((check) => {
          const tone =
            check.status === "fail"
              ? "border-red-500/40 bg-red-950/15 text-red-200"
              : check.status === "warn"
                ? "border-yellow-500/40 bg-yellow-950/15 text-yellow-100"
                : check.status === "ok"
                  ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-100"
                  : "border-border/70 bg-bg/60 text-text";
          return (
            <div
              key={`${check.label}-${check.detail}`}
              className={`rounded border px-2 py-1 text-[11px] ${tone}`}
            >
              <div className="font-semibold">{check.label}</div>
              {check.detail && (
                <div className="mt-0.5 break-words text-text-dim">{check.detail}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderCodeRows = (rows: CodeMessageData["rows"], sessionId?: string) => {
    if (!rows || rows.length === 0) return null;
    return (
      <div className="mt-2 overflow-hidden rounded border border-border/70">
        {rows.map((row, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: command result rows are display-only and preserve server order
            key={`${row.id ?? row.path ?? row.title ?? row.text}-${idx}`}
            className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b px-2 py-1.5 last:border-b-0 ${codeStatusTone(
              row.status,
            )}`}
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] text-text">
                {row.action
                  ? `${row.action}: ${row.title ?? row.text ?? ""}`
                  : row.path
                    ? `${row.path}${row.line ? `:${row.line}` : ""}`
                    : row.title || row.id}
              </div>
              {(row.text || row.detail) && (
                <div className="mt-0.5 break-words text-[11px] text-text-dim">
                  {row.text || row.detail}
                </div>
              )}
              {(row.canonical || row.portability) && (
                <div className="mt-0.5 break-words font-mono text-[10px] text-text-dim">
                  {[row.canonical, row.portability].filter(Boolean).join(" | ")}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 text-[9px] uppercase tracking-wide text-text-dim">
              {sessionId &&
                row.type === "file" &&
                row.path &&
                /\.(png|jpe?g|gif|webp)$/i.test(row.path) && (
                  <button
                    type="button"
                    aria-label={`Inspect image ${row.path}`}
                    onClick={() =>
                      sendCommandWithOverlay(`code see ${JSON.stringify({ path: row.path })}`, {
                        sessionId,
                      })
                    }
                    className="rounded border border-primary/40 px-2 py-1 text-primary hover:bg-primary/10"
                  >
                    Inspect image
                  </button>
                )}
              {row.kind && <span>{row.kind}</span>}
              {row.grade && <span>{row.grade}</span>}
              {row.status && <span className="rounded bg-bg-hover px-1 py-0.5">{row.status}</span>}
              {typeof row.size === "number" && <span>{row.size}b</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderCodeEvents = (events: CodeMessageData["events"]) => {
    if (!events || events.length === 0) return null;
    return (
      <div className="mt-2 space-y-1 rounded border border-border/70 bg-bg/40 p-2">
        {events.map((event, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: event rows preserve chronological server order
            key={`${event.kind}-${event.timestamp}-${idx}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 font-mono text-[10px] text-text-dim"
          >
            <span>{event.timestamp ? formatTimestamp(event.timestamp) : ""}</span>
            <span className="truncate text-text">{event.kind}</span>
            <span className="truncate">{event.actor}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderLifecycle = (phase?: string) => {
    const phases = [
      "received",
      "inspecting",
      "planning",
      "patching",
      "applying",
      "verifying",
      "completed",
    ];
    const current = phase ?? "received";
    const currentIndex = phases.indexOf(current);
    return (
      <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto pb-1">
        {phases.map((item, index) => {
          const reached = current === "failed" ? false : currentIndex >= index;
          const active = item === current;
          return (
            <div key={item} className="flex shrink-0 items-center gap-1">
              {index > 0 && (
                <span className={`h-px w-3 ${reached ? "bg-primary/70" : "bg-border"}`} />
              )}
              <span
                className={`h-2 w-2 rounded-full border ${
                  active
                    ? "border-primary bg-primary shadow-[0_0_8px_rgba(56,189,248,0.65)]"
                    : reached
                      ? "border-primary/70 bg-primary/40"
                      : "border-border bg-bg"
                }`}
              />
              <span className={active ? "text-[9px] text-primary" : "text-[9px] text-text-dim"}>
                {item}
              </span>
            </div>
          );
        })}
        {current === "failed" && (
          <span className="ml-2 text-[9px] font-semibold text-red-300">failed</span>
        )}
      </div>
    );
  };

  // ── Phase 3/4 cards ──────────────────────────────────────────────
  // Interactive approve/deny card. Used for `approval` + `spawn_request`
  // artifacts in both the transcript and the artifacts overlay. Decision
  // buttons send through the existing command path; once decided the card
  // shows a read-only, multiuser-aware decision line.
  const renderApprovalCard = (props: {
    id: string;
    kind: string;
    title?: string;
    status?: string;
    requestedBy?: string;
    decidedBy?: string | null;
    decidedAt?: number | null;
    description?: string;
  }) => {
    const status = (props.status ?? "pending").toLowerCase();
    const pending = status === "pending";
    const Icon = props.kind === "spawn_request" ? Users : GitPullRequest;
    return (
      <div className="mt-2 rounded-md border border-border/70 bg-bg/50 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-text-bright">
            <Icon size={13} className="shrink-0 text-primary" />
            <span className="truncate">{props.title || `Approval ${props.id}`}</span>
          </div>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${approvalBadgeTone(status)}`}
          >
            {status}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-text-dim">
          <span>{props.id}</span>
          <span className="rounded bg-bg-hover px-1 py-0.5">{props.kind}</span>
          {props.requestedBy && <span>by {props.requestedBy}</span>}
        </div>
        {props.description && (
          <div className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-text">
            {props.description}
          </div>
        )}
        {pending ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => sendCommandWithOverlay(`code approve ${props.id}`)}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300 transition-colors hover:border-emerald-400 hover:bg-emerald-500/20"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => sendCommandWithOverlay(`code deny ${props.id}`)}
              className="rounded border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/20"
            >
              Deny
            </button>
          </div>
        ) : (
          <div className="mt-2 text-[10px] text-text-dim">
            {status === "denied" || status === "rejected" ? "denied" : "approved"}
            {props.decidedBy ? ` by ${props.decidedBy}` : ""}
            {props.decidedAt ? ` · ${formatTimestamp(props.decidedAt)}` : ""}
          </div>
        )}
      </div>
    );
  };

  // "Crew dispatched" card — a real crew was created + the goal posted.
  const renderCrewDispatchedCard = (meta: Record<string, unknown>, fallbackTitle?: string) => {
    const crewName =
      typeof meta.crewName === "string"
        ? meta.crewName
        : typeof meta.crewId === "string"
          ? meta.crewId
          : fallbackTitle || "Crew";
    const goal = typeof meta.goal === "string" ? meta.goal : undefined;
    const formation = typeof meta.formation === "string" ? meta.formation : undefined;
    const channelId = typeof meta.channelId === "string" ? meta.channelId : undefined;
    const members = parseCrewMembers(meta.members);
    return (
      <div className="mt-2 rounded-md border border-border/70 bg-bg/50 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-bright">
          <Network size={13} className="shrink-0 text-primary" />
          <span className="truncate">Crew dispatched · {crewName}</span>
          {formation && (
            <span className="rounded bg-bg-hover px-1 py-0.5 font-mono text-[9px] text-text-dim">
              {formation}
            </span>
          )}
        </div>
        {goal && <div className="mt-1.5 break-words text-[11px] text-text">{goal}</div>}
        {members.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {members.map((member) => (
              <span
                key={member.agentName}
                className="flex items-center gap-1 rounded border border-border/60 bg-bg px-2 py-0.5 text-[10px] text-text-dim"
              >
                <Code2 size={10} className="text-primary" />
                <span className="text-text">{member.agentName}</span>
                {member.role && <span className="text-text-dim">· {member.role}</span>}
                {member.source && (
                  <span
                    className={`rounded px-1 py-px text-[8px] font-semibold uppercase tracking-wide ${
                      member.source === "spawned"
                        ? "bg-violet-500/15 text-violet-300"
                        : "bg-sky-500/15 text-sky-300"
                    }`}
                    title={
                      member.source === "spawned"
                        ? "Spawned via the agent.spawn safety gate"
                        : "Recruited from an existing coding agent"
                    }
                  >
                    {member.source}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        {channelId && (
          <div className="mt-2 font-mono text-[10px] text-text-dim">channel {channelId}</div>
        )}
      </div>
    );
  };

  // "Linked task #<id>" chip for session_task artifacts.
  const renderSessionTaskChip = (meta: Record<string, unknown>, fallbackTitle?: string) => {
    const taskId =
      typeof meta.taskId === "number" || typeof meta.taskId === "string"
        ? String(meta.taskId)
        : undefined;
    const title = typeof meta.title === "string" ? meta.title : fallbackTitle;
    return (
      <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/35 bg-primary/5 px-2.5 py-1 text-[11px] text-text">
        <List size={12} className="shrink-0 text-primary" />
        <span className="truncate">
          Linked task{taskId ? ` #${taskId}` : ""}
          {title ? `: ${title}` : ""}
        </span>
        {taskId && (
          <button
            type="button"
            onClick={() => sendCommandWithOverlay(`task info ${taskId}`)}
            className="shrink-0 rounded border border-border/70 bg-bg px-1.5 py-0.5 text-[9px] text-text-dim transition-colors hover:border-primary hover:text-primary"
          >
            Info
          </button>
        )}
      </div>
    );
  };

  const renderCodeMessage = (
    m: ChatMessage,
    i: number,
    _perception: StoredPerception,
    code: CodeMessageData,
  ) => {
    const type = code.type ?? "artifact";
    const status = code.status ?? (code.exitCode === 0 ? "complete" : undefined);
    // Checks that never ran (not_run) or whose runner broke (error) are not failures.
    const unverified = type === "verification" && (status === "not_run" || status === "error");
    const failed =
      !unverified &&
      (status === "failed" ||
        code.event?.includes("failed") ||
        (typeof code.exitCode === "number" && code.exitCode !== 0));
    const Icon =
      type === "lifecycle"
        ? Activity
        : type === "command"
          ? Terminal
          : type === "verification"
            ? status === "not_run"
              ? CircleMinus
              : status === "error"
                ? TriangleAlert
                : failed
                  ? XCircle
                  : CheckCircle2
            : type === "readiness"
              ? CheckCircle2
              : type === "patch"
                ? GitPullRequest
                : type === "tree"
                  ? GitBranch
                  : type === "session"
                    ? Code2
                    : type === "model"
                      ? Network
                      : type === "skill"
                        ? Sparkles
                        : type === "profile"
                          ? List
                          : FileText;
    const title =
      type === "command"
        ? `$ ${(code.command ?? []).join(" ")}`
        : (code.title ?? code.event?.replace(/_/g, " ") ?? "Code");
    const content = typeof code.content === "string" ? code.content : "";
    const blockVariant =
      type === "patch" || content.startsWith("diff --git")
        ? "diff"
        : type === "command"
          ? "output"
          : "text";

    // Phase 3/4: route by artifact kind (the reliable discriminator the backend
    // sets on every code message), falling back to the type union. These kinds
    // get a dedicated interactive/structured card instead of the default chips.
    const artifactKind = code.artifactKind ?? (type === "approval" || type === "crew" ? type : "");
    const cardMeta = parseMetadata(code.metadata);
    const isApprovalCard =
      (artifactKind === "approval" || artifactKind === "spawn_request") && Boolean(code.artifactId);
    const isCrewDispatchedCard = artifactKind === "crew_dispatched";
    const isSessionTaskCard = artifactKind === "session_task";

    return (
      <div
        key={i}
        className={`group relative my-1 rounded-md border px-3 py-2 shadow-sm ${
          failed ? "border-red-500/50 bg-red-950/15" : "border-primary/35 bg-primary/5"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-dim">
              <span className="flex items-center gap-1 text-primary">
                <Icon size={12} />
                {type}
              </span>
              {status && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] ${
                    failed
                      ? "bg-red-500/15 text-red-300"
                      : status === "pending" || status === "planned"
                        ? "bg-yellow-500/15 text-yellow-200"
                        : "bg-emerald-500/15 text-emerald-300"
                  }`}
                >
                  {status}
                </span>
              )}
              {code.artifactId && (
                <span className="font-mono text-text-dim">{code.artifactId}</span>
              )}
              {code.sessionId && <span className="font-mono text-text-dim">{code.sessionId}</span>}
              {code.modelTarget && (
                <span className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-[9px] text-text-dim">
                  {code.modelTarget}
                </span>
              )}
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-text-bright">{title}</div>
          </div>
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-text-dim/70">
            {formatTimestamp(m.timestamp)}
          </span>
        </div>

        {code.parentSessionId && (
          <div className="mt-1 font-mono text-[10px] text-text-dim">
            parent {code.parentSessionId}
          </div>
        )}
        {code.workspace && (
          <div className="mt-1 truncate font-mono text-[10px] text-text-dim">{code.workspace}</div>
        )}
        {code.paths && code.paths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {code.paths.map((path) => (
              <span
                key={path}
                className="rounded border border-border/60 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-dim"
              >
                {path}
              </span>
            ))}
          </div>
        )}
        {isApprovalCard ? (
          renderApprovalCard({
            id: code.artifactId ?? "",
            kind: artifactKind,
            title: code.title,
            status,
            requestedBy:
              code.createdBy ??
              (typeof cardMeta.requestedBy === "string" ? cardMeta.requestedBy : undefined),
            decidedBy:
              code.appliedBy ??
              (typeof cardMeta.decidedBy === "string" ? cardMeta.decidedBy : undefined),
            decidedAt:
              code.appliedAt ??
              (typeof cardMeta.decidedAt === "number" ? cardMeta.decidedAt : undefined),
            description: content.trim() || (m.text ?? "").trim() || undefined,
          })
        ) : isCrewDispatchedCard ? (
          renderCrewDispatchedCard(cardMeta, code.title)
        ) : isSessionTaskCard ? (
          renderSessionTaskChip(cardMeta, code.title)
        ) : (
          <>
            {artifactKind === "task_run" ? (
              <div className="mb-2">
                {renderSessionTaskChip(cardMeta, code.title)}
                <p className="mt-1 text-xs text-text-dim">
                  Recorded verification:{" "}
                  {verificationLabel(cardMeta.verification, "not yet submitted")}
                </p>
              </div>
            ) : null}
            {artifactKind === "visual_evidence" && <VisualEvidenceDetails metadata={cardMeta} />}
            {type === "verification" && (
              <p className="mt-2 text-xs text-text-dim">
                This result covers the recorded checks. Task acceptance and delivered-file
                validation are separate.
              </p>
            )}
            {type === "lifecycle" ? renderLifecycle(code.phase) : null}
            {type === "tree" ? renderCodeTree(code.tree) : null}
            {renderCodeChecks(code.checks)}
            {renderCodeRows(code.rows, code.event === "files_listed" ? code.sessionId : undefined)}
            {renderCodeEvents(code.events)}
            {content.trim()
              ? renderCodeBlock(content, blockVariant)
              : type !== "tree" && type !== "profile"
                ? renderTextContent(m.text ?? "", "mt-2 text-sm text-text")
                : null}
            {(typeof code.exitCode === "number" || typeof code.durationMs === "number") && (
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-text-dim">
                {typeof code.exitCode === "number" && <span>exit {code.exitCode}</span>}
                {typeof code.durationMs === "number" && <span>{code.durationMs}ms</span>}
                {code.timedOut && <span className="text-red-300">timed out</span>}
                {code.truncated && <span>truncated</span>}
              </div>
            )}
            {renderCodeActions(
              code.commands,
              artifactKind === "visual_evidence" ? code.sessionId : undefined,
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-2 top-2 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  return {
    renderCodeBlock,
    renderApprovalCard,
    renderCrewDispatchedCard,
    renderSessionTaskChip,
    renderCodeMessage,
  };
}
