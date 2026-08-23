// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, RoomContext } from "../../types";
import { analyzeTraces, type TraceAggregate } from "../trace-analytics";
import {
  buildTraceDataset,
  compareTraceCohorts,
  replayTraceDataset,
  type TraceEvaluationDataset,
  type TraceWithJudgments,
} from "../trace-dataset";
import { evaluateTrace } from "../trace-evaluation";
import { projectTraces, type TraceSpanView, type TraceView } from "../trace-projection";
import {
  adviseTraceAggregates,
  adviseTraceRouting,
  selectAdaptiveCandidate,
} from "../trace-routing-advice";

const HELP = `Inspect recent execution traces (read-only).
  trace [list] [limit]  — recent traces (default 10, maximum 20)
  trace stats [limit]   — observed model/tool mechanics (maximum 100 traces)
  trace compare <models|routes> [limit] — descriptive cohorts, no winner inference
  trace dataset [limit] — replayable structural evaluation cases
  trace dataset verify [limit] — replay an exported dataset copy, report schema + drift
  trace advise <models|routes|autonomous|tools> [limit] — read-only shadow selection advice
  trace choose <models|routes|autonomous|tools> <eligible...> — select only inside an explicit set
  trace show <id>       — causal request/turn/tool spans
  trace eval <id>       — objective checks with evidence span IDs
  trace judgments <id>  — attributed participant judgments
  trace judge <id> <passed|failed|inconclusive> <criterion> | <rationale>

Execution spans never include prompts, outputs, thinking text, or tool arguments.
Participant judgments include the rationale their author explicitly records.`;

export function traceCommand(deps: {
  db?: MarinaDB;
  getEventLog: () => EngineEvent[];
  getEntityName: (id: Parameters<RoomContext["send"]>[0]) => string | undefined;
}): CommandDef {
  const load = (traceId?: string, eventLimit = 4000) => {
    const history = deps.db
      ? deps.db.getRecentTraceEvents(eventLimit, traceId)
      : { events: deps.getEventLog(), truncated: false };
    return { traces: projectTraces(history.events), truncated: history.truncated };
  };

  return {
    name: "trace",
    aliases: ["traces"],
    category: "Information",
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const sub = input.tokens[0]?.toLowerCase();
      if (!sub || sub === "list" || /^\d+$/.test(sub)) {
        const rawLimit = sub === "list" ? input.tokens[1] : sub;
        const limit = Math.max(1, Math.min(Number(rawLimit) || 10, 20));
        const { traces, truncated } = load(undefined, Math.min(limit * 200, 4000));
        return sendList(ctx, input.entity, traces.slice(0, limit), truncated);
      }

      if (sub === "stats") {
        const limit = Math.max(1, Math.min(Number(input.tokens[1]) || 100, 100));
        const { traces, truncated } = load(undefined, Math.min(limit * 200, 5000));
        sendStats(ctx, input.entity, traces.slice(0, limit), truncated);
        return;
      }

      if (sub === "choose") {
        const dimension = input.tokens[1];
        const eligible = [...new Set(input.tokens.slice(2).filter(Boolean))];
        if (
          !["models", "routes", "autonomous", "tools"].includes(dimension ?? "") ||
          eligible.length === 0
        ) {
          ctx.send(
            input.entity,
            "Usage: trace choose <models|routes|autonomous|tools> <eligible-candidate...>",
          );
          return;
        }
        const loaded = load(undefined, 5000);
        const evidence: TraceWithJudgments[] = loaded.traces.slice(0, 100).map((trace) => ({
          ...trace,
          judgments: deps.db?.getTraceJudgments(trace.traceId) ?? [],
        }));
        const analytics = analyzeTraces(evidence);
        const advice =
          dimension === "models" || dimension === "routes"
            ? adviseTraceRouting(
                compareTraceCohorts(evidence, dimension === "models" ? "model" : "route"),
                dimension === "models" ? "model" : "route",
              )
            : adviseTraceAggregates(
                dimension === "autonomous" ? analytics.agentModels : analytics.tools,
                dimension === "autonomous" ? "autonomous_model" : "tool",
              );
        const selection = selectAdaptiveCandidate(eligible, advice, () => eligible[0]!);
        const lines = [
          header(`Explicit Trace Selection: ${advice.dimension}`),
          separator(),
          `  eligible: ${eligible.join(", ")}`,
          `  selected: ${selection.target}`,
          `  advice applied: ${selection.applied ? "yes" : "no"}`,
          `  reason: ${selection.reason}`,
          "  No configuration changed. The caller may use this selection for its next action.",
        ];
        if (loaded.truncated) lines.push("  [retained event window truncated]");
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "compare" || sub === "dataset" || sub === "advise") {
        const verify = sub === "dataset" && input.tokens[1]?.toLowerCase() === "verify";
        const rawLimit =
          sub === "dataset" ? (verify ? input.tokens[2] : input.tokens[1]) : input.tokens[2];
        const limit = Math.max(1, Math.min(Number(rawLimit) || 100, 100));
        const loaded = load(undefined, Math.min(limit * 200, 5000));
        const evidence: TraceWithJudgments[] = loaded.traces.slice(0, limit).map((trace) => ({
          ...trace,
          judgments: deps.db?.getTraceJudgments(trace.traceId) ?? [],
        }));
        if (verify) sendDatasetVerify(ctx, input.entity, evidence, loaded.truncated);
        else if (sub === "dataset") sendDataset(ctx, input.entity, evidence, loaded.truncated);
        else {
          const dimension = input.tokens[1];
          const observedDimension = dimension === "autonomous" || dimension === "tools";
          if (dimension !== "models" && dimension !== "routes" && !observedDimension) {
            ctx.send(
              input.entity,
              `Usage: trace ${sub} <models|routes${sub === "advise" ? "|autonomous|tools" : ""}> [limit]`,
            );
            return;
          }
          if (observedDimension) {
            if (sub !== "advise") {
              ctx.send(
                input.entity,
                "Autonomous model and tool cohorts are available via trace stats.",
              );
              return;
            }
            const analytics = analyzeTraces(evidence);
            sendAdvice(
              ctx,
              input.entity,
              adviseTraceAggregates(
                dimension === "autonomous" ? analytics.agentModels : analytics.tools,
                dimension === "autonomous" ? "autonomous_model" : "tool",
              ),
              loaded.truncated,
            );
            return;
          }
          const cohorts = compareTraceCohorts(evidence, dimension === "models" ? "model" : "route");
          if (sub === "advise") {
            sendAdvice(
              ctx,
              input.entity,
              adviseTraceRouting(cohorts, dimension === "models" ? "model" : "route"),
              loaded.truncated,
            );
          } else sendComparison(ctx, input.entity, cohorts, loaded.truncated);
        }
        return;
      }

      if (sub === "judge") {
        handleJudge(ctx, input, deps, load);
        return;
      }

      if (sub === "judgments") {
        const traceId = input.tokens[1];
        if (!traceId) {
          ctx.send(input.entity, "Usage: trace judgments <id>");
          return;
        }
        sendJudgments(ctx, input.entity, traceId, deps.db?.getTraceJudgments(traceId) ?? []);
        return;
      }

      if (sub !== "show" && sub !== "eval") {
        ctx.send(input.entity, HELP);
        return;
      }
      const traceId = input.tokens[1];
      if (!traceId) {
        ctx.send(input.entity, `Usage: trace ${sub} <id>`);
        return;
      }
      const { traces, truncated } = load(traceId, 5000);
      const trace = traces.find((candidate) => candidate.traceId === traceId);
      if (!trace) {
        ctx.send(input.entity, `Trace "${traceId}" not found in retained history.`);
        return;
      }
      if (sub === "eval") sendEvaluation(ctx, input.entity, trace, truncated);
      else sendTrace(ctx, input.entity, trace, truncated);
    },
  };
}

function sendAdvice(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  advice: ReturnType<typeof adviseTraceRouting>,
  truncated: boolean,
): void {
  const lines = [
    header(`Shadow Routing Advice: ${advice.dimension}`),
    separator(),
    `  mode: ${advice.mode}`,
    `  candidates: ${advice.candidates.join(", ") || "none"}`,
    ...advice.reasons.map((reason) => `  ${reason}`),
    advice.dimension === "route"
      ? "  Advisory result: default routing ignores it; explicit adaptive routing may recompute and apply it only within the eligible route set."
      : `  Advisory result: Marina never applies ${advice.dimension.replace("_", " ")} advice without an explicit eligible set and opt-in policy.`,
  ];
  if (truncated) lines.push("  [retained event window truncated]");
  ctx.send(entityId, lines.join("\n"));
}

function sendDatasetVerify(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  traces: TraceWithJudgments[],
  truncated: boolean,
): void {
  // Round-trip the export through JSON so the verified object is exactly what
  // an external consumer of `format=eval-json` holds, then replay the
  // objective evaluators from the exported spans alone. Zero drift proves the
  // dataset is self-contained: `marina.execution.v2` recomputes identically
  // outside the process that produced it.
  const dataset = JSON.parse(JSON.stringify(buildTraceDataset(traces))) as TraceEvaluationDataset;
  const schemaOk =
    dataset.schema === "marina.trace.dataset.v1" &&
    typeof dataset.generatedAt === "number" &&
    Array.isArray(dataset.cases);
  const replayed = schemaOk ? replayTraceDataset(dataset) : [];
  const drifted = replayed.filter(
    (item, index) =>
      JSON.stringify(item.evaluation) !== JSON.stringify(dataset.cases[index]?.evaluation),
  ).length;
  const judgments = dataset.cases.reduce((sum, item) => sum + item.judgments.length, 0);
  const lines = [
    header("Evaluation Dataset Replay"),
    separator(),
    `  schema: ${schemaOk ? "valid marina.trace.dataset.v1" : "INVALID"}`,
    `  cases: ${dataset.cases.length} · judgments: ${judgments}`,
    `  replayed evaluations: ${replayed.length} · drift from export: ${drifted}`,
    drifted === 0 && schemaOk
      ? "  Objective checks recompute identically from exported spans; the export is replayable."
      : "  Replay diverged from the export — re-export before citing these evaluations.",
  ];
  if (truncated) lines.push("  [retained event window truncated]");
  ctx.send(entityId, lines.join("\n"));
}

function sendDataset(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  traces: TraceWithJudgments[],
  truncated: boolean,
): void {
  const dataset = buildTraceDataset(traces);
  const judgments = dataset.cases.reduce((sum, item) => sum + item.judgments.length, 0);
  const lines = [
    header("Evaluation Evidence Dataset"),
    separator(),
    `  ${dataset.schema} · ${dataset.cases.length} cases · ${judgments} judgments`,
    "  Replays objective evaluators over structural spans; it cannot replay private model inputs.",
    "  Export: GET /api/traces?limit=100&format=eval-json · Check replayability: trace dataset verify",
  ];
  if (truncated) lines.push("  [retained event window truncated]");
  ctx.send(entityId, lines.join("\n"));
}

function sendComparison(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  rows: ReturnType<typeof compareTraceCohorts>,
  truncated: boolean,
): void {
  const lines = [header("Trace Cohorts"), separator()];
  if (rows.length === 0) lines.push("  No eligible cohorts observed.");
  for (const row of rows.slice(0, 20)) {
    const success =
      row.mechanics.successRate === undefined
        ? "n/a"
        : `${Math.round(row.mechanics.successRate * 100)}%`;
    lines.push(
      `  ${row.dimension}:${row.name} · n=${row.mechanics.eligible}/${row.mechanics.observed} · terminal success=${success} · judgments=${row.judgments.total} by ${row.judgments.evaluators}`,
    );
  }
  if (truncated) lines.push("  [retained event window truncated]");
  lines.push("  Descriptive cohorts only; Marina does not infer a winner or routing decision.");
  ctx.send(entityId, lines.join("\n"));
}

function handleJudge(
  ctx: RoomContext,
  input: Parameters<CommandDef["handler"]>[1],
  deps: Parameters<typeof traceCommand>[0],
  load: (traceId?: string, eventLimit?: number) => { traces: TraceView[]; truncated: boolean },
): void {
  if (!deps.db) {
    ctx.send(input.entity, "Trace judgments require durable database storage.");
    return;
  }
  const [left = "", rationaleRaw = ""] = input.args.split("|", 2);
  const [sub, traceId, verdict, ...criterionParts] = left.trim().split(/\s+/);
  const criterion = criterionParts.join(" ").trim();
  const rationale = rationaleRaw.trim();
  if (
    sub !== "judge" ||
    !traceId ||
    !verdict ||
    !["passed", "failed", "inconclusive"].includes(verdict) ||
    !criterion ||
    !rationale
  ) {
    ctx.send(
      input.entity,
      "Usage: trace judge <id> <passed|failed|inconclusive> <criterion> | <rationale>",
    );
    return;
  }
  if (criterion.length > 120 || rationale.length > 1000) {
    ctx.send(input.entity, "Criterion must be ≤120 characters and rationale ≤1000 characters.");
    return;
  }
  const trace = load(traceId, 5000).traces.find((candidate) => candidate.traceId === traceId);
  if (!trace) {
    ctx.send(input.entity, `Trace "${traceId}" not found in retained history.`);
    return;
  }
  const evaluatorEntity = deps.getEntityName(input.entity);
  if (!evaluatorEntity) {
    ctx.send(input.entity, "Cannot attribute this judgment to an active Marina identity.");
    return;
  }
  const root = trace.spans.find((span) => span.kind === "model_request") ?? trace.spans[0];
  const record = deps.db.addTraceJudgment({
    traceId,
    evaluatorEntity,
    verdict: verdict as "passed" | "failed" | "inconclusive",
    criterion,
    rationale,
    evidenceSpanIds: root ? [root.spanId] : [],
  });
  ctx.send(
    input.entity,
    `Recorded attributed judgment ${record.id}. It is advisory evidence, not an execution gate.`,
  );
}

function sendJudgments(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  traceId: string,
  rows: ReturnType<MarinaDB["getTraceJudgments"]>,
): void {
  if (rows.length === 0) {
    ctx.send(entityId, `No participant judgments recorded for trace "${traceId}".`);
    return;
  }
  const lines = [header(`Trace Judgments: ${traceId}`), separator()];
  for (const row of rows) {
    lines.push(`  ${row.verdict} · ${row.criterion} · by ${row.evaluatorEntity} · ${row.id}`);
    lines.push(`    ${row.rationale}`);
    lines.push(`    evidence: ${row.evidenceSpanIds.join(", ") || "trace only"}`);
  }
  lines.push("  Participant judgments are attributed assertions, not verified facts or gates.");
  ctx.send(entityId, lines.join("\n"));
}

function sendStats(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  traces: TraceView[],
  truncated: boolean,
): void {
  const analytics = analyzeTraces(traces);
  const lines = [
    header("Trace Analytics"),
    separator(),
    `  ${analytics.tracesObserved} traces observed · ${analytics.partialTraces} partial`,
  ];
  appendAggregates(lines, "Models", analytics.models);
  appendAggregates(lines, "Autonomous models", analytics.agentModels);
  appendAggregates(lines, "Routes", analytics.routes);
  appendAggregates(lines, "Tools", analytics.tools);
  if (truncated) lines.push("  [retained event window truncated]");
  lines.push("  Rates exclude partial spans; these are execution mechanics, not quality scores.");
  ctx.send(entityId, lines.join("\n"));
}

function appendAggregates(lines: string[], label: string, rows: TraceAggregate[]): void {
  lines.push(`  ${label}:`);
  if (rows.length === 0) {
    lines.push("    none observed");
    return;
  }
  for (const row of rows.slice(0, 10)) {
    const terminal =
      row.terminalRate === undefined ? "n/a" : `${Math.round(row.terminalRate * 100)}%`;
    const success = row.successRate === undefined ? "n/a" : `${Math.round(row.successRate * 100)}%`;
    const latency = row.latency.p50Ms === undefined ? "n/a" : `${row.latency.p50Ms}ms`;
    const ttft = row.ttft.p50Ms === undefined ? "n/a" : `${row.ttft.p50Ms}ms`;
    const tokens =
      row.tokens.samples === 0 ? "n/a" : `${row.tokens.input}in/${row.tokens.output}out`;
    const cost = row.cost.samples === 0 ? "n/a" : `$${row.cost.totalUsd.toFixed(4)}`;
    lines.push(
      `    ${row.name}: n=${row.eligible}/${row.observed} terminal=${terminal} success=${success} p50=${latency} ttft=${ttft} tokens=${tokens} cost=${cost}`,
    );
  }
}

function sendList(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  traces: TraceView[],
  truncated: boolean,
): void {
  if (traces.length === 0) {
    ctx.send(entityId, "No traced executions in retained history.");
    return;
  }
  const lines = [header("Recent Traces"), separator()];
  for (const trace of traces) {
    const duration = trace.durationMs === undefined ? "live" : `${trace.durationMs}ms`;
    lines.push(
      `  ${trace.traceId}  ${trace.status.padEnd(10)} ${duration.padStart(8)}  ${trace.spans.length} spans${trace.partial ? "  partial" : ""}`,
    );
  }
  if (truncated) lines.push("  [retained event window truncated]");
  lines.push("  Use: trace show <id> | trace eval <id>");
  ctx.send(entityId, lines.join("\n"));
}

function sendTrace(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  trace: TraceView,
  truncated: boolean,
): void {
  const visible = trace.spans.slice(0, 50);
  const lines = [
    header(`Trace: ${trace.traceId}`),
    separator(),
    `  run: ${trace.runId}`,
    `  status: ${trace.status}  duration: ${trace.durationMs ?? "live"}${trace.partial ? "  partial history" : ""}`,
  ];
  for (const span of visible) {
    const depth = spanDepth(span, trace.spans);
    lines.push(
      `  ${"  ".repeat(depth)}${span.kind} ${span.name} [${span.status}] ${span.durationMs ?? "live"}  (${span.spanId})`,
    );
    if (typeof span.attributes.routeStrategy === "string") {
      const routing = [
        `strategy=${span.attributes.routeStrategy}`,
        typeof span.attributes.routeAdviceMode === "string"
          ? `advice=${span.attributes.routeAdviceMode}`
          : undefined,
        typeof span.attributes.routeReason === "string" ? span.attributes.routeReason : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  ${"  ".repeat(depth + 1)}${routing}`);
    }
    const metrics = [
      typeof span.attributes.model === "string" ? `model=${span.attributes.model}` : undefined,
      typeof span.attributes.origin === "string" ? `origin=${span.attributes.origin}` : undefined,
      typeof span.attributes.ttftMs === "number" ? `ttft=${span.attributes.ttftMs}ms` : undefined,
      typeof span.attributes.inputTokens === "number"
        ? `input=${span.attributes.inputTokens}`
        : undefined,
      typeof span.attributes.outputTokens === "number"
        ? `output=${span.attributes.outputTokens}`
        : undefined,
      typeof span.attributes.costUsd === "number"
        ? `cost=$${span.attributes.costUsd.toFixed(4)}`
        : undefined,
      typeof span.attributes.errorKind === "string"
        ? `error=${span.attributes.errorKind}`
        : undefined,
    ].filter(Boolean);
    if (metrics.length > 0) lines.push(`  ${"  ".repeat(depth + 1)}${metrics.join(" · ")}`);
  }
  if (trace.spans.length > visible.length)
    lines.push(`  … ${trace.spans.length - visible.length} more spans`);
  if (truncated) lines.push("  [retained event window truncated]");
  ctx.send(entityId, lines.join("\n"));
}

function sendEvaluation(
  ctx: RoomContext,
  entityId: Parameters<RoomContext["send"]>[0],
  trace: TraceView,
  truncated: boolean,
): void {
  const evaluation = evaluateTrace(trace);
  const lines = [
    header(`Trace Evaluation: ${trace.traceId}`),
    separator(),
    `  ${evaluation.evaluator}`,
  ];
  for (const check of evaluation.checks) {
    lines.push(`  ${check.id}: ${check.result} — ${check.summary}`);
    if (check.evidenceSpanIds.length > 0) {
      lines.push(`    evidence: ${check.evidenceSpanIds.join(", ")}`);
    }
  }
  if (truncated) lines.push("  [retained event window truncated; integrity may be incomplete]");
  ctx.send(entityId, lines.join("\n"));
}

function spanDepth(span: TraceSpanView, spans: readonly TraceSpanView[]): number {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  const seen = new Set([span.spanId]);
  let parentId = span.parentSpanId;
  let depth = 0;
  while (parentId && depth < 8) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentSpanId;
  }
  return depth;
}
