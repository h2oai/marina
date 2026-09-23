// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AgentTraceFields {
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  origin: "autonomous" | "request";
}

export interface TraceParent {
  runId: string;
  traceId: string;
  spanId: string;
}

/**
 * One continuation-prompt section as the budget saw it, in priority order.
 * `deferred: true` = dropped by `assembleContinuationPrompt` for this prompt;
 * `bytes` is then what it WOULD have cost.
 */
export interface PromptSectionMetric {
  name: string;
  bytes: number;
  deferred: boolean;
}

/**
 * Byte attribution for one prompt, stamped once on the first `turn_start` of
 * the `prompt()` it built. `promptBytes` is the emitted continuation text;
 * `systemPromptBytes` + `residentSchemaBytes` are the fixed per-request prefix
 * so cost can be split between the stable prefix and the volatile sections.
 */
export interface PromptMetrics {
  promptBytes: number;
  promptSections: PromptSectionMetric[];
  systemPromptBytes?: number;
  residentSchemaBytes?: number;
}

type TraceableAgentEventType =
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "text_delta"
  | "thinking_delta";

interface ActiveTurn {
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  origin: "autonomous" | "request";
  toolSpans: Map<string, string[]>;
}

/**
 * Assigns causal identity to the agent events Marina already emits.
 *
 * One LLM turn is one trace. Tool executions are child spans of that turn;
 * matching results reuse the call span. The tracer owns no persistence and
 * does not alter execution, so observation cannot delay or gate the agent.
 */
export class AgentExecutionTracer {
  private activeTurn?: ActiveTurn;

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  trace(
    type: TraceableAgentEventType,
    toolName?: string,
    parent?: TraceParent,
    prompt?: PromptMetrics,
  ): (AgentTraceFields & Partial<PromptMetrics>) | undefined {
    if (type === "turn_start") this.activeTurn = this.createTurn(parent);
    if (!this.activeTurn) return undefined;

    const turn = this.activeTurn;
    let fields: AgentTraceFields & Partial<PromptMetrics> = {
      runId: turn.runId,
      traceId: turn.traceId,
      spanId: turn.spanId,
      ...(turn.parentSpanId ? { parentSpanId: turn.parentSpanId } : {}),
      origin: turn.origin,
      // Prompt byte attribution rides only on the turn that opened the prompt.
      ...(type === "turn_start" && prompt ? promptMetricFields(prompt) : {}),
    };

    if (type === "tool_call" && toolName) {
      const spanId = `tool-${this.createId()}`;
      const spans = turn.toolSpans.get(toolName) ?? [];
      spans.push(spanId);
      turn.toolSpans.set(toolName, spans);
      fields = { ...fields, spanId, parentSpanId: turn.spanId };
    } else if (type === "tool_result" && toolName) {
      const spans = turn.toolSpans.get(toolName);
      const spanId = spans?.shift();
      if (spans?.length === 0) turn.toolSpans.delete(toolName);
      if (spanId) fields = { ...fields, spanId, parentSpanId: turn.spanId };
    }

    if (type === "turn_end") this.activeTurn = undefined;
    return fields;
  }

  private createTurn(parent?: TraceParent): ActiveTurn {
    const id = this.createId();
    return {
      runId: parent?.runId ?? `agent-run-${id}`,
      traceId: parent?.traceId ?? `agent-trace-${id}`,
      spanId: `turn-${id}`,
      parentSpanId: parent?.spanId,
      origin: parent ? "request" : "autonomous",
      toolSpans: new Map(),
    };
  }
}

/** The `agent_turn_start` prompt-metric fields, omitting the optional prefix sizes when unknown. */
function promptMetricFields(prompt: PromptMetrics): PromptMetrics {
  return {
    promptBytes: prompt.promptBytes,
    promptSections: prompt.promptSections.map((s) => ({ ...s })),
    ...(prompt.systemPromptBytes === undefined
      ? {}
      : { systemPromptBytes: prompt.systemPromptBytes }),
    ...(prompt.residentSchemaBytes === undefined
      ? {}
      : { residentSchemaBytes: prompt.residentSchemaBytes }),
  };
}

/** Extract an explicitly propagated trace from a rendered model-request perception. */
export function traceParentFromPerception(text: string): TraceParent | undefined {
  // Cheap substring gate first: this runs on EVERY buffered perception, and
  // without it any chat message containing braces pays a JSON.parse attempt.
  if (!text.includes('"model_request"')) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as {
      type?: unknown;
      trace?: Partial<TraceParent>;
    };
    const trace = value.type === "model_request" ? value.trace : undefined;
    if (
      typeof trace?.runId !== "string" ||
      typeof trace.traceId !== "string" ||
      typeof trace.spanId !== "string" ||
      !trace.runId ||
      !trace.traceId ||
      !trace.spanId
    ) {
      return undefined;
    }
    return { runId: trace.runId, traceId: trace.traceId, spanId: trace.spanId };
  } catch {
    return undefined;
  }
}

/** Return a parent only when all traced perceptions refer to one causal trace. */
export function unambiguousTraceParent(
  parents: Array<TraceParent | undefined>,
): TraceParent | undefined {
  const traced = parents.filter((parent): parent is TraceParent => parent !== undefined);
  if (traced.length === 0) return undefined;
  const first = traced[0]!;
  return traced.every(
    (parent) =>
      parent.runId === first.runId &&
      parent.traceId === first.traceId &&
      parent.spanId === first.spanId,
  )
    ? first
    : undefined;
}
