// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId } from "../types";
import type { TraceParent } from "./execution-trace";

export interface AgentSupports {
  text: boolean;
  image?: boolean;
  video?: boolean;
}

// ─── Agent Configuration ────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  model?: string;
  role?: string;
  goal?: string;
  keyName?: string;
  room?: string;
  /**
   * Name of the entity that spawned this agent. Persisted to
   * agent_configs.spawned_by so lineage is attributable — an agent that
   * assembles a team is recorded as the parent. Defaults to "system" for
   * world-seeded / operator-spawned agents. Walking this chain (Phase 2)
   * bounds spawn depth and sizes the standing-scaled spawn budget.
   */
  spawnedBy?: string;
  loopCycleDelay?: number;
  focusTimeout?: number;
  perceptionBufferCap?: number;
  attentionMode?: "focused" | "balanced" | "open";
  attentionThreshold?: number;
  /**
   * Reasoning effort hint for models that support it (Claude thinking,
   * GPT-5 reasoning tiers, etc.). Non-reasoning models ignore this.
   * Defaults to "off" — agents inherit the model's non-reasoning behavior.
   */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Per-level token budgets for token-based reasoning providers (e.g.
   * Claude thinking, some local models). Unset levels use provider
   * defaults. Lets agents self-regulate reasoning depth per thinkingLevel.
   */
  thinkingBudgets?: {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  };
  /**
   * Cap for provider-requested retry delays, in milliseconds.
   * Requests requiring a longer wait fail immediately so higher-level
   * retry logic (or the user) can decide. Set to 0 to disable the cap.
   * Defaults to pi-agent-core's 60000ms.
   */
  maxRetryDelayMs?: number;
  /**
   * When the agent's context is compacted, also write the LLM-generated
   * summary to this named pool so peers working the same project can
   * benefit from the consolidation. Personal notes are always written;
   * the pool write is additional and opt-in per agent. Omit if the
   * agent should only consolidate into personal memory.
   */
  compactionPool?: string;
  /**
   * Hard timeout for a single agent.prompt() call, in milliseconds. If
   * the LLM (or any tool in the turn loop) hasn't returned within this
   * window, the agent aborts the run and the next cycle picks up fresh.
   * Defaults to 120000 (2 minutes) — generous for reasoning-heavy
   * thinkingLevel=high but tight enough to prevent hung upstreams from
   * wedging the loop indefinitely.
   */
  promptTimeoutMs?: number;
  /**
   * Tool schema profile — controls how much of the full tool surface is
   * sent to the LLM on every request.
   *   - "full"    (default) 27 tools, ~12-15KB schema. Sonnet-tier and up.
   *   - "crew"    7 tools, ~4KB. Dispatchers / coordinators.
   *   - "minimal" 3 tools (command+think+memory), ~1.5KB. Haiku-tier
   *               specialists. Functionally complete via `marina_command`
   *               which runs any world command as an escape hatch.
   * Unset = "full" (backward compatible).
   */
  toolProfile?: "full" | "crew" | "minimal";
  /**
   * Crew-responder mode — when true, the agent runs as a thin specialist
   * that only wakes on perceptions, not on its own cognitive cycle:
   *   - autonomous loop skips ticks when no perceptions are pending
   *   - continuation prompt suppresses Memory Health, Learning Signal,
   *     and ACE Reflection sections (those exist for self-driven agents)
   *   - idle consolidation is skipped entirely
   *
   * Use for crew specialists (Mathematician, Skeptic, Verifier, Historian,
   * Scholar, Reflector, Translator) whose only job is to respond when
   * addressed. Coordinators (Answerer, Councilor, Debater, Decomposer)
   * leave this false — they need the full cognitive cycle to drive
   * dispatch decisions between specialist replies.
   *
   * Crew fast-dispatch fix #2 — see docs/crew-fast-dispatch-design.md.
   * Unset = false (backward compatible).
   */
  crewResponder?: boolean;
  /**
   * Modalities available to this agent's configured model. Populated at spawn
   * so humans know whether image or video tools are callable. Defaults to
   * { text: true } when unknown.
   */
  supports?: AgentSupports;
  /**
   * Override the model's context window (tokens, prompt+output) the compactor
   * budgets against. Normally autodetected at spawn for local models (see
   * model-probe) or taken from the registry/env; set this only to pin a value.
   */
  contextWindow?: number;
  /**
   * Per-agent output (completion) token cap. Bounds how much the model may
   * generate per turn — critical on small local windows where an unbounded
   * completion would itself overflow. Unset → a sensible per-model default
   * (local: a fraction of the window; cloud: the provider default).
   */
  maxTokens?: number;
}

// ─── Agent Status ───────────────────────────────────────────────────────────

export interface AgentStatus {
  name: string;
  entityId: EntityId | null;
  state: "starting" | "connected" | "autonomous" | "idle" | "stopping" | "stopped" | "error";
  model: string;
  /** Stable hash of the exact assembled system prompt currently in force. */
  promptVersion?: string;
  role: string;
  focus: string | null;
  goal: string | null;
  uptime: number;
  toolCalls: number;
  errors: number;
  errorReason: string | null;
  lastActivity: number;
  supports: AgentSupports;
  /** Nominal model context window (tokens) — registry/probe/env value. */
  contextWindow: number;
  /**
   * Working window the compactor currently budgets against. Equals
   * contextWindow normally; drops below it after overflow recovery and recovers
   * over time. The gap is the visible signal that an agent is under pressure.
   */
  effectiveContextWindow: number;
  /** Output (completion) token cap applied to each turn. */
  maxOutputTokens: number;
  /** Highest real prompt-token count the server has accepted (0 until first reply). */
  peakInputTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /** Wall-clock of the most recent completed LLM turn (ms); 0 until the first turn. */
  lastTurnMs: number;
  /** Exponential moving average of turn latency (ms) — the "is the model slow?" signal. */
  avgTurnMs: number;
  /** Consecutive turns the model returned zero tool calls — the "stuck" signal. */
  silentTurns: number;
  /** Operator-facing lifecycle interpretation layered over transport state. */
  healthState?: "starting" | "ready" | "busy" | "waiting" | "degraded" | "recovering" | "stopped";
  diagnosis?: string | null;
  attentionMode?: "focused" | "balanced" | "open";
  attentionThreshold?: number;
  queuedPerceptions?: number;
  droppedPerceptions?: number;
}

// ─── Agent Handle ───────────────────────────────────────────────────────────

export interface AgentHandle {
  readonly name: string;
  getStatus(): AgentStatus;
  sendAttention(message: string): Promise<void>;
  setFocus(description: string): void;
  setSystemPrompt(prompt: string | undefined): void;
  setAttentionMode?(mode: "focused" | "balanced" | "open"): void;
  setAttentionThreshold?(threshold: number): void;
  /**
   * Task mode for a session-bound coder: while a task is set, the autonomous
   * loop suppresses low-value cognitive sections (novelty, memory health,
   * learning signal, reflection, idle consolidation) and restates the task
   * every cycle. Pass null to clear (on `code stop` or task completion).
   * Unlike crewResponder, the loop keeps cycling without fresh perceptions.
   */
  setActiveCodingTask?(task: string | null): void;
  stop(): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  /** Reconfigure the agent (restarts LLM loop, preserves entity state). */
  reconfigure(opts: {
    model?: string;
    role?: string;
    rolePrompt?: string | null;
    keyName?: string;
    supports?: AgentSupports;
    /** Static key or dynamic resolver called on each LLM call. */
    apiKey?: string | (() => string | undefined | Promise<string | undefined>);
  }): Promise<void>;
}

// ─── Agent Events ───────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "status_change"; status: AgentStatus }
  | {
      type: "tool_call";
      toolName: string;
      args: Record<string, unknown>;
      risk?: "read" | "communicate" | "mutate" | "consequential";
      trustSources?: string[];
    }
  | { type: "tool_result"; toolName: string; result: unknown; isError: boolean }
  | { type: "perception"; kind: string; text: string }
  | { type: "error"; error: string; context: string }
  // Turn boundaries — fire once per LLM turn. Observers use these to
  // know when an agent is mid-thought vs. idle.
  | { type: "turn_start"; traceParent?: TraceParent }
  | { type: "turn_end"; hadToolCalls: boolean; toolCount: number }
  // Fine-grained streaming. Consumers that don't want per-token events
  // should filter. Pro-presence: observers see the agent thinking in
  // real time; pro-emergence: a human can engage mid-thought and steer.
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string };
