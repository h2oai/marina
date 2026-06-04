/**
 * Shape characterization for Scores — the feature the conductor learns over.
 *
 * The paper's central finding is that *topology* adapts to task (2-step for
 * MMLU, deeper trees for code). To learn that without gradients, we record the
 * shape of each Score alongside its outcome (see score-outcome.ts) so a
 * successor can recall "what shape worked for this task class". This module
 * computes the shape; it's pure and transport-free.
 */

import { parseAssignee, type Score, terminalStepId, topoLayers } from "./score";

export type Topology = "single" | "chain" | "best-of-n" | "parallel" | "tree";

export interface ScoreShape {
  topology: Topology;
  stepCount: number;
  layerCount: number;
  /** Widest layer — the degree of parallelism. */
  maxWidth: number;
  /** Distinct worker identities (entity names, role:/model: values, "conduct"). */
  workers: string[];
  /** Whether any step recurses (assignee "conduct"). */
  recursive: boolean;
}

/** Distinct worker identity for a step's assignee. */
function workerLabel(assignee: string): string {
  const a = parseAssignee(assignee);
  return a.kind === "conduct" ? "conduct" : a.value;
}

/**
 * Best-of-N: several independent first-layer steps that all feed a single sink
 * — the classic "sample N, pick/merge one" shape.
 */
function isBestOfN(_score: Score, layers: ReturnType<typeof topoLayers>): boolean {
  if (layers.length !== 2) return false;
  const [first, second] = layers;
  if (!first || !second || first.length < 2 || second.length !== 1) return false;
  const sink = second[0]!;
  const firstIds = new Set(first.map((s) => s.id));
  return sink.access.length === first.length && sink.access.every((id) => firstIds.has(id));
}

export function characterizeScore(score: Score): ScoreShape {
  const workers = [...new Set(score.steps.map((s) => workerLabel(s.assignee)))];
  const recursive = score.steps.some((s) => parseAssignee(s.assignee).kind === "conduct");

  let layers: ReturnType<typeof topoLayers>;
  try {
    layers = topoLayers(score);
  } catch {
    // Cyclic/invalid — report a degenerate shape rather than throw.
    return {
      topology: "tree",
      stepCount: score.steps.length,
      layerCount: 0,
      maxWidth: 0,
      workers,
      recursive,
    };
  }

  const stepCount = score.steps.length;
  const layerCount = layers.length;
  const maxWidth = layers.reduce((m, l) => Math.max(m, l.length), 0);

  let topology: Topology;
  if (stepCount <= 1) topology = "single";
  else if (maxWidth === 1) topology = "chain";
  else if (isBestOfN(score, layers)) topology = "best-of-n";
  else if (layerCount <= 2) topology = "parallel";
  else topology = "tree";

  // terminalStepId is part of the run contract; touch it so a shape always
  // corresponds to a runnable Score (no behavioral effect here).
  void terminalStepId(score);

  return { topology, stepCount, layerCount, maxWidth, workers, recursive };
}

/** One-line human/recall-friendly summary, e.g. "best-of-n/4 steps/3 workers". */
export function shapeSummary(shape: ScoreShape): string {
  return `${shape.topology}/${shape.stepCount} steps/${shape.workers.length} workers`;
}
