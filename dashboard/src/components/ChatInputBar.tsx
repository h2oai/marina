// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Lock, Send } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { getChatWs, useChatState } from "../hooks/use-chat-state";
import { useCommandFavorites } from "../hooks/use-command-favorites";
import { attachedCommand, openCanvas, useWorkspaceState } from "../hooks/use-workspace-state";
import { useWorldState } from "../hooks/use-world-state";
import type { CodeContextData } from "../lib/webchat-format";
import { CodingPalette, ContextualCompass } from "./ChatInputGuidance";
import { CommandFavorites } from "./CommandFavorites";
import { CommandInputAssistance } from "./CommandInputAssistance";

export function ChatInputBar({
  codePrompt,
  codeContext,
  activeCodingSessionId,
  sessionWriter,
  sendCommandWithOverlay,
  onDraft,
}: {
  codePrompt: string | null;
  codeContext: CodeContextData | null;
  activeCodingSessionId: string | null;
  sessionWriter?: string | null;
  sendCommandWithOverlay(command: string): boolean;
  onDraft(): void;
}) {
  const favorites = useCommandFavorites();
  const attachment = useWorkspaceState((s) => s.attachment);
  const [attachmentAgent, setAttachmentAgent] = useState("");
  const attachmentEntities = useWorldState((s) => s.entities);
  const loggedIn = useChatState((s) => s.loggedIn);
  const connected = useChatState((s) => s.connected);
  const commandHistory = useChatState((s) => s.commandHistory);
  const [externalDraft, setExternalDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const historyIdxRef = useRef(-1);
  const cmdValueRef = useRef("");
  const applyDraft = useCallback(
    (command: string) => {
      if (!loggedIn || !inputRef.current) return false;
      // Enter must see the prepared text immediately, before the next animation frame.
      inputRef.current.value = command;
      inputRef.current.rows = Math.min(6, command.split("\n").length);
      cmdValueRef.current = command;
      historyIdxRef.current = -1;
      inputRef.current.focus();
      return true;
    },
    [loggedIn],
  );
  useEffect(() => {
    const draft = (event: Event) => {
      const command = (event as CustomEvent<{ command: string }>).detail?.command;
      if (typeof command !== "string") return;
      onDraft();
      setExternalDraft(applyDraft(command) ? null : command);
    };
    window.addEventListener("marina:draft-command", draft);
    return () => window.removeEventListener("marina:draft-command", draft);
  }, [applyDraft, onDraft]);

  useEffect(() => {
    if (externalDraft === null) return;
    const frame = requestAnimationFrame(() => {
      if (!loggedIn) {
        nameRef.current?.focus();
        return;
      }
      if (applyDraft(externalDraft)) setExternalDraft(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [externalDraft, loggedIn, applyDraft]);

  const doLogin = useCallback(() => {
    const name = nameRef.current?.value.trim();
    if (!name) return;
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "login", name }));
    }
  }, []);

  const doSend = useCallback(() => {
    const raw = cmdValueRef.current.trim();
    const text = !codePrompt && raw.startsWith("/") ? raw.slice(1).trimStart() : raw;
    if (!text || (attachment && codePrompt)) return;
    const cmd = attachment ? attachedCommand(attachment, text, attachmentAgent) : text;
    if (!cmd) return;
    const ok = sendCommandWithOverlay(cmd);
    if (ok) {
      if (attachment) useWorkspaceState.getState().attach(null);
      historyIdxRef.current = -1;
      if (inputRef.current) {
        inputRef.current.value = "";
        inputRef.current.dispatchEvent(new Event("input", { bubbles: true }));
        inputRef.current.rows = 1;
        cmdValueRef.current = "";
      }
    }
  }, [sendCommandWithOverlay, attachment, attachmentAgent, codePrompt]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      } else if (e.key === "ArrowUp" && !cmdValueRef.current.includes("\n")) {
        e.preventDefault();
        if (historyIdxRef.current < commandHistory.length - 1) {
          historyIdxRef.current++;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) {
            inputRef.current.value = val;
            inputRef.current.rows = Math.min(6, val.split("\n").length);
          }
        }
      } else if (e.key === "ArrowDown" && !cmdValueRef.current.includes("\n")) {
        e.preventDefault();
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) {
            inputRef.current.value = val;
            inputRef.current.rows = Math.min(6, val.split("\n").length);
          }
        } else {
          historyIdxRef.current = -1;
          cmdValueRef.current = "";
          if (inputRef.current) inputRef.current.value = "";
        }
      }
    },
    [commandHistory, doSend],
  );

  const renderCodeContextStrip = () => {
    if (!codePrompt || !codeContext) return null;
    type Chip = {
      key: string;
      label: string;
      title: string;
      value: string;
      tone?: "accent" | "warn" | "lock";
      icon?: ReactNode;
    };
    // Write-lock holder. The entity `code_context` property is the always-live
    // source; the loaded session detail (when the artifacts overlay is open)
    // is a fallback. Both are read defensively — `writer` may be absent.
    const writer = codeContext.writer ?? sessionWriter ?? undefined;
    const chips: Chip[] = (
      [
        {
          key: "session",
          label: "session",
          title: codeContext.sessionId ? `Session ${codeContext.sessionId}` : "No code session",
          value: codeContext.sessionId ?? "none",
        },
        codeContext.sessionStatus
          ? {
              key: "status",
              label: "status",
              title: `Session status ${codeContext.sessionStatus}`,
              value: codeContext.sessionStatus,
              tone: "accent",
            }
          : null,
        codeContext.workspace
          ? {
              key: "workspace",
              label: "cwd",
              title: `Workspace ${codeContext.workspace}`,
              value: codeContext.workspace,
            }
          : null,
        codeContext.modelTarget
          ? {
              key: "model",
              label: "model",
              title: `Code model target ${codeContext.modelTarget}`,
              value: codeContext.modelTarget,
            }
          : null,
        {
          key: "artifact",
          label: codeContext.latestArtifactKind ?? "artifact",
          title: codeContext.latestArtifactId
            ? `Latest ${codeContext.latestArtifactKind ?? "artifact"} ${codeContext.latestArtifactId}${
                codeContext.latestArtifactStatus ? ` (${codeContext.latestArtifactStatus})` : ""
              }${codeContext.latestArtifactLifecycle ? ` lifecycle ${codeContext.latestArtifactLifecycle}` : ""}`
            : "No artifacts",
          value: codeContext.latestArtifactId
            ? `${codeContext.latestArtifactId}${
                codeContext.latestArtifactStatus ? `:${codeContext.latestArtifactStatus}` : ""
              }${codeContext.latestArtifactLifecycle ? `:${codeContext.latestArtifactLifecycle}` : ""}`
            : "none",
        },
        typeof codeContext.pendingPatches === "number" && codeContext.pendingPatches > 0
          ? {
              key: "patches",
              label: "patches",
              title: `${codeContext.pendingPatches} pending patch${
                codeContext.pendingPatches === 1 ? "" : "es"
              }`,
              value: String(codeContext.pendingPatches),
              tone: "warn",
            }
          : null,
        codeContext.assignedAgent
          ? {
              key: "agent",
              label: "agent",
              title: `Assigned agent ${codeContext.assignedAgent}`,
              value: codeContext.assignedAgent,
            }
          : null,
        writer
          ? {
              key: "writer",
              label: "writer",
              title: `${writer} holds the write lock for this session`,
              value: writer,
              tone: "lock",
              icon: <Lock size={9} className="shrink-0" />,
            }
          : null,
      ] as (Chip | null)[]
    ).filter((chip): chip is Chip => chip !== null);
    return (
      <div className="mb-1 grid min-h-7 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 font-mono text-[10px] text-text-dim">
        <span
          className="flex h-6 shrink-0 select-text items-center rounded border border-primary/40 bg-primary/10 px-1.5 font-semibold text-primary"
          title={`${codePrompt} mode prompt`}
        >
          {codePrompt}&gt;
        </span>
        <div className="flex min-w-0 select-text items-center gap-1 overflow-x-auto pb-0.5">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={`flex h-6 min-w-0 max-w-[10rem] shrink-0 items-center gap-1 rounded border px-1.5 sm:max-w-[14rem] ${
                chip.tone === "warn"
                  ? "border-yellow-500/40 bg-yellow-950/15 text-yellow-200"
                  : chip.tone === "accent"
                    ? "border-emerald-500/35 bg-emerald-950/15 text-emerald-200"
                    : chip.tone === "lock"
                      ? "border-amber-500/45 bg-amber-950/20 text-amber-200"
                      : "border-border/60 bg-bg/70 text-text-dim"
              }`}
              title={chip.title}
            >
              {chip.icon}
              <span className="shrink-0 text-[8px] font-semibold uppercase tracking-wide text-text-dim/80">
                {chip.label}
              </span>
              <span className="min-w-0 truncate text-[10px] text-current">{chip.value}</span>
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      {codePrompt && (
        <CodingPalette
          prompt={codePrompt}
          hasSession={Boolean(activeCodingSessionId)}
          onExecute={sendCommandWithOverlay}
        />
      )}
      <ContextualCompass onExecute={sendCommandWithOverlay} />
      <CommandFavorites />

      {attachment && (
        <section
          className="mx-2 mb-2 rounded border border-primary/40 bg-primary/5 p-2 text-xs"
          aria-label="Attached canvas context"
        >
          <div className="flex justify-between gap-2">
            <button
              type="button"
              className="truncate text-primary"
              onClick={() => openCanvas(attachment.canvasId, attachment.nodeId)}
            >
              {attachment.title || "Canvas node"}
            </button>
            <button
              type="button"
              aria-label="Remove canvas context"
              onClick={() => useWorkspaceState.getState().attach(null)}
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-text-dim">
            {attachment.mode === "discuss"
              ? "Your message will be posted as a reply to this node."
              : "Your message and this node reference will be sent to the selected agent."}
          </p>
          {attachment.mode === "ask" && (
            <select
              aria-label="Agent to ask"
              value={attachmentAgent}
              onChange={(e) => setAttachmentAgent(e.target.value)}
              className="mt-2 w-full rounded border border-border bg-bg p-1"
            >
              <option value="">Choose an agent…</option>
              {attachmentEntities
                .filter((entity) => entity.kind === "agent")
                .map((entity) => (
                  <option key={entity.name}>{entity.name}</option>
                ))}
            </select>
          )}
          {codePrompt && (
            <p role="status" className="mt-2 text-warning">
              Exit Code Mode to send a canvas message.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => sendCommandWithOverlay("code exit")}
              >
                Exit Code Mode
              </button>
            </p>
          )}
        </section>
      )}
      {/* Input area */}
      <div className="border-t border-border px-2 py-1.5">
        {!loggedIn ? (
          <div className="flex items-center gap-2">
            <input
              id="marina-name-input"
              ref={nameRef}
              type="text"
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
              placeholder="Enter your name..."
              maxLength={20}
              className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={doLogin}
              disabled={!connected}
              title={connected ? undefined : "Connecting to Marina…"}
              className="rounded bg-primary px-2 py-1 text-[11px] font-bold text-bg"
            >
              Connect
            </button>
          </div>
        ) : (
          <>
            {renderCodeContextStrip()}
            <CommandInputAssistance input={inputRef} codeMode={!!codePrompt} />
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
              />
              {codePrompt && (
                <span className="rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                  {codePrompt}&gt;
                </span>
              )}
              <textarea
                id="marina-command-input"
                ref={inputRef}
                rows={1}
                title="Enter to send; Shift+Enter for a new line"
                onChange={(e) => {
                  cmdValueRef.current = e.target.value;
                  e.target.rows = Math.min(6, e.target.value.split("\n").length);
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  attachment
                    ? "Write a message about this node…"
                    : codePrompt
                      ? `Type a ${codePrompt} command...`
                      : "Type a command..."
                }
                className="min-w-0 flex-1 resize-y rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                aria-label="Pin current draft"
                title="Pin current draft to favorites"
                className="text-xs text-text-dim"
                onClick={() => {
                  const command = cmdValueRef.current.trim();
                  if (command) favorites.toggle(command);
                }}
              >
                Pin
              </button>
              <button
                type="button"
                onClick={doSend}
                disabled={
                  !!attachment && (!!codePrompt || (attachment.mode === "ask" && !attachmentAgent))
                }
                aria-label="Send command"
                className="text-primary transition-colors hover:text-text-bright"
              >
                <Send size={14} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
