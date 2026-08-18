// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Bot, Send, Square, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { formatSince } from "../lib/agent-health";
import { postApi } from "../lib/api";
import type { AgentStatusInfo } from "../lib/types";

interface AgentPanelProps {
  name: string;
  status: AgentStatusInfo;
}

export function AgentPanel({ name, status }: AgentPanelProps) {
  const [attention, setAttention] = useState("");
  const [sending, setSending] = useState(false);

  const handleSendAttention = async () => {
    if (!attention.trim()) return;
    setSending(true);
    try {
      await postApi(`/api/agents/${encodeURIComponent(name)}/attention`, {
        message: attention.trim(),
      });
      setAttention("");
    } catch {
      // Ignore errors silently for now
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    await postApi(`/api/agents/${encodeURIComponent(name)}/stop`);
  };

  const upMin = Math.round(status.uptime / 60000);
  const modelShort = status.model.split("/")[1] ?? status.model;

  return (
    <div className="border-t border-border bg-bg-elevated/50 p-2 space-y-1.5">
      {/* Status Bar */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <Bot size={10} className="text-accent" />
        <span className="text-accent font-medium">{name}</span>
        <span className="text-text-dim">|</span>
        <span className="text-text">{modelShort}</span>
        {renderSupportBadges(status.supports)}
        {status.role && (
          <>
            <span className="text-text-dim">|</span>
            <span className="text-text">{status.role}</span>
          </>
        )}
        <span className="text-text-dim">|</span>
        <span className="text-text-dim">{upMin}m</span>
        <span className="text-text-dim">|</span>
        <span className="text-text-dim">{status.toolCalls} calls</span>
        {status.avgTurnMs && status.avgTurnMs > 0 ? (
          <>
            <span className="text-text-dim">|</span>
            <span className="text-text-dim" title="Average LLM turn latency">
              ~{formatSince(status.avgTurnMs)}/turn
            </span>
          </>
        ) : null}
        {status.silentTurns && status.silentTurns > 0 ? (
          <>
            <span className="text-text-dim">|</span>
            <span
              className="text-warning"
              title="Consecutive turns with no tool call (stuck signal)"
            >
              {status.silentTurns} silent
            </span>
          </>
        ) : null}
        {status.errors > 0 && (
          <>
            <span className="text-text-dim">|</span>
            <span className="text-red-400">{status.errors} err</span>
          </>
        )}
      </div>

      {/* Error reason — the diagnostic. errorReason is populated only while the
          agent is in the error state, and now names the failing model
          (e.g. "LLM error [openrouter/…]: 404 No allowed providers"). */}
      {status.errorReason && (
        <div className="flex items-start gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-1 text-[10px] leading-tight">
          <TriangleAlert size={11} className="mt-px shrink-0 text-red-400" />
          <span className="break-words text-red-300">{status.errorReason}</span>
        </div>
      )}

      {/* Focus */}
      {status.focus && (
        <div className="text-[10px]">
          <span className="text-primary">Focus:</span>{" "}
          <span className="text-text">{status.focus}</span>
        </div>
      )}

      {/* Attention Input */}
      <div className="flex gap-1">
        <input
          type="text"
          placeholder="Send attention..."
          value={attention}
          onChange={(e) => setAttention(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSendAttention()}
          className="flex-1 bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={handleSendAttention}
          disabled={sending || !attention.trim()}
          className="text-primary hover:text-accent transition-colors disabled:opacity-50"
          title="Send attention"
        >
          <Send size={10} />
        </button>
        <button
          type="button"
          onClick={handleStop}
          className="text-text-dim hover:text-red-400 transition-colors"
          title="Stop agent"
        >
          <Square size={10} />
        </button>
      </div>
    </div>
  );
}

function renderSupportBadges(supports: AgentStatusInfo["supports"]): ReactElement | null {
  const badges: ReactElement[] = [];
  if (supports.image) {
    badges.push(
      <span key="img" className="rounded bg-primary/10 px-1 text-[8px] uppercase text-primary">
        IMG
      </span>,
    );
  }
  if (supports.video) {
    badges.push(
      <span key="vid" className="rounded bg-primary/10 px-1 text-[8px] uppercase text-primary">
        VID
      </span>,
    );
  }
  if (badges.length === 0) return null;
  return (
    <>
      <span className="text-text-dim">|</span>
      <span className="flex items-center gap-1">{badges}</span>
    </>
  );
}
