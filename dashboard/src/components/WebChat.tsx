// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Copy, List, MessageSquareText, PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { handleChatPerception } from "../hooks/chat-perceptions";
import { ensureChatWs, useChatState } from "../hooks/use-chat-state";
import { useCodingSessionDetail } from "../hooks/use-coding";
import { useWorldState } from "../hooks/use-world-state";
import { type OverlayState, overlayForCommand } from "../lib/chat-overlay";
import { type CodeContextData, messageText, writeClipboard } from "../lib/webchat-format";
import { AssetViewerProvider } from "./AssetLightbox";
import { ChatInputBar } from "./ChatInputBar";
import { ChatMessageList } from "./ChatMessageList";
import { ChatStatusOverlay } from "./ChatStatusOverlay";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";

const MODE_STORAGE_KEY = "marina-chat-mode";
const CODING_SESSION_STORAGE_PREFIX = "marina-coding-session:";
type ChatViewMode = "compact" | "rich";

/** Active coding session id is persisted per instance, like the tour-seen flag. */
function codingSessionStorageKey(instanceName: string | null | undefined): string {
  return `${CODING_SESSION_STORAGE_PREFIX}${instanceName ?? "default"}`;
}

// Initialize WebSocket once at module level (survives component unmount)
ensureChatWs(handleChatPerception);

export function WebChat({ isFocused, onToggleFocus }: PanelFocusProps = {}) {
  const messages = useChatState((s) => s.messages);
  const entityName = useChatState((s) => s.entityName);
  const sendChatCommand = useChatState((s) => s.sendCommand);
  const codePrompt = useWorldState((s) => {
    const self = entityName ? s.entities.find((entity) => entity.name === entityName) : undefined;
    const modal = self?.properties?.active_modal;
    if (modal !== "code") return null;
    return codePromptForProfile(self?.properties?.code_profile);
  });
  const codeContextRaw = useWorldState((s) => {
    const self = entityName ? s.entities.find((entity) => entity.name === entityName) : undefined;
    return self?.properties?.active_modal === "code" ? self.properties.code_context : null;
  });
  const codeContext = useMemo(() => codeContextFromProperty(codeContextRaw), [codeContextRaw]);
  const instanceName = useWorldState((s) => s.instanceName);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  // Active coding session id, persisted per instance so a reload keeps the
  // active session visible in the chip bar even before the entity property
  // round-trips back over the WS snapshot.
  const [persistedSessionId, setPersistedSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(codingSessionStorageKey(instanceName));
    } catch {
      return null;
    }
  });
  // The live entity property wins; fall back to the restored value on reload.
  const activeCodingSessionId = codeContext?.sessionId ?? persistedSessionId;

  // Transient "copied" feedback keyed by message index, or "all" for copy-all.
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback(async (text: string, key: number | "all") => {
    if (!text || !(await writeClipboard(text))) return;
    setCopied(key);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopied(null), 1500);
  }, []);
  useEffect(() => () => clearTimeout(copyResetRef.current ?? undefined), []);

  const copyAll = useCallback(() => {
    copy(useChatState.getState().messages.map(messageText).join("\n"), "all");
  }, [copy]);

  // Ensure WebSocket is alive when component mounts (reconnect if closed)
  useEffect(() => {
    ensureChatWs(handleChatPerception);
  }, []);

  useEffect(() => {
    const openCoding = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) setPersistedSessionId(sessionId);
      setOverlay({ type: "coding-artifacts", issuedFrom: "Work" });
    };
    window.addEventListener("marina:open-coding", openCoding);
    return () => window.removeEventListener("marina:open-coding", openCoding);
  }, []);

  const [viewMode, setViewMode] = useState<ChatViewMode>(() => {
    // Rich is the default for web/dashboard consumers; only an explicit
    // stored "compact" preference opts back into the dense log.
    if (typeof window === "undefined") return "rich";
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    return stored === "compact" ? "compact" : "rich";
  });
  const sendCommandWithOverlay = useCallback(
    (cmd: string, target?: { sessionId: string }) => {
      if (viewMode === "rich") {
        const next = overlayForCommand(cmd);
        if (next) setOverlay(next);
      }
      return sendChatCommand(cmd, true, target);
    },
    [viewMode, sendChatCommand],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, viewMode);
    }
  }, [viewMode]);

  // Persist the active coding session id whenever the code-context (driven by
  // `session`-typed code events) reports a session. Clearing the modal — e.g.
  // via `code exit` — drops `code_context`, which clears the stored id too.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sessionId = codeContext?.sessionId ?? null;
    const key = codingSessionStorageKey(instanceName);
    try {
      if (sessionId) {
        window.localStorage.setItem(key, sessionId);
      } else if (codeContext === null) {
        // Code modal closed (code exit): forget the active session.
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore storage failures (private mode, quota)
    }
    setPersistedSessionId(sessionId);
  }, [codeContext, instanceName]);
  useEffect(() => {
    if (viewMode !== "rich" && overlay) {
      setOverlay(null);
    }
  }, [viewMode, overlay]);
  const codingDetailQuery = useCodingSessionDetail(
    activeCodingSessionId,
    viewMode === "rich" && overlay?.type === "coding-artifacts",
  );
  return (
    <AssetViewerProvider>
      <ChatStatusOverlay
        overlay={viewMode === "rich" ? overlay : null}
        closeOverlay={closeOverlay}
        activeCodingSessionId={activeCodingSessionId}
        codingDetailQuery={codingDetailQuery}
        copy={copy}
        copied={copied}
        sendCommandWithOverlay={sendCommandWithOverlay}
      />
      <GlassPanel
        title="Web Chat"
        icon={<MessageSquareText size={14} />}
        isFocused={isFocused}
        onToggleFocus={onToggleFocus}
        bodyScroll={false}
        headerExtra={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setViewMode((mode) => (mode === "compact" ? "rich" : "compact"));
              }}
              title={viewMode === "compact" ? "Switch to rich view" : "Switch to compact view"}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-text-dim transition-colors hover:border-primary hover:text-primary"
            >
              {viewMode === "compact" ? <PanelsTopLeft size={11} /> : <List size={11} />}
              <span>{viewMode === "compact" ? "Rich view" : "Compact view"}</span>
            </button>
            {messages.length > 0 ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyAll();
                }}
                title="Copy whole conversation"
                className="flex items-center gap-1 text-text-dim text-[10px] transition-colors hover:text-primary"
              >
                {copied === "all" ? <Check size={11} /> : <Copy size={11} />}
                <span>{copied === "all" ? "Copied" : "Copy all"}</span>
              </button>
            ) : undefined}
          </div>
        }
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Output */}
          <ChatMessageList
            messages={messages}
            viewMode={viewMode}
            copy={copy}
            copied={copied}
            sendCommandWithOverlay={sendCommandWithOverlay}
          />

          <ChatInputBar
            codePrompt={codePrompt}
            codeContext={codeContext}
            activeCodingSessionId={activeCodingSessionId}
            sessionWriter={codingDetailQuery.data?.session?.writer}
            sendCommandWithOverlay={sendCommandWithOverlay}
            onDraft={closeOverlay}
          />
        </div>
      </GlassPanel>
    </AssetViewerProvider>
  );
}

function codePromptForProfile(profile: unknown): string {
  if (profile === "pi" || profile === "claude" || profile === "codex") return profile;
  return "code";
}

function codeContextFromProperty(value: unknown): CodeContextData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return {
    assignedAgent: typeof data.assignedAgent === "string" ? data.assignedAgent : undefined,
    latestArtifactId: typeof data.latestArtifactId === "string" ? data.latestArtifactId : undefined,
    latestArtifactKind:
      typeof data.latestArtifactKind === "string" ? data.latestArtifactKind : undefined,
    latestArtifactLifecycle:
      typeof data.latestArtifactLifecycle === "string" ? data.latestArtifactLifecycle : undefined,
    latestArtifactStatus:
      typeof data.latestArtifactStatus === "string" ? data.latestArtifactStatus : undefined,
    pendingPatches: typeof data.pendingPatches === "number" ? data.pendingPatches : undefined,
    profile: typeof data.profile === "string" ? data.profile : undefined,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    sessionMode: typeof data.sessionMode === "string" ? data.sessionMode : undefined,
    sessionStatus: typeof data.sessionStatus === "string" ? data.sessionStatus : undefined,
    sessionTitle: typeof data.sessionTitle === "string" ? data.sessionTitle : undefined,
    workspace: typeof data.workspace === "string" ? data.workspace : undefined,
    writer: typeof data.writer === "string" ? data.writer : undefined,
  };
}
