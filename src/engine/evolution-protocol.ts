import type { EvolutionSessionRow } from "../persistence/database";

export interface EvolutionGuardrail {
  metric: string;
  direction: "higher" | "lower";
}

export interface EvolutionProtocolV1 {
  version: 1;
  voluntary: true;
  metricsAreAdvisory: true;
  automaticContinuation: false;
  automaticPromotion: false;
  primaryMetric?: string;
  direction: "higher" | "lower";
  minTrials: number;
  minEffect?: number;
  maxRuns?: number;
  maxDurationSeconds?: number;
  independentReview: boolean;
  guardrails: EvolutionGuardrail[];
}

export interface EvolutionBudgetState {
  exhausted: boolean;
  reasons: string[];
  runsRemaining?: number;
  secondsRemaining?: number;
}

export function createEvolutionProtocol(input: {
  primaryMetric?: string;
  direction?: "higher" | "lower";
  options?: string[];
}): EvolutionProtocolV1 {
  const protocol: EvolutionProtocolV1 = {
    version: 1,
    voluntary: true,
    metricsAreAdvisory: true,
    automaticContinuation: false,
    automaticPromotion: false,
    primaryMetric: input.primaryMetric,
    direction: input.direction ?? "higher",
    minTrials: 3,
    independentReview: false,
    guardrails: [],
  };

  for (const raw of input.options ?? []) {
    const [key, value = ""] = raw.split("=", 2).map((part) => part.trim());
    if (key === "max-runs") protocol.maxRuns = positiveInteger(value, "max-runs");
    else if (key === "max-seconds") {
      protocol.maxDurationSeconds = positiveInteger(value, "max-seconds");
    } else if (key === "min-trials") protocol.minTrials = positiveInteger(value, "min-trials");
    else if (key === "min-effect") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0)
        throw new Error("min-effect must be zero or more");
      protocol.minEffect = parsed;
    } else if (key === "independent-review") {
      if (value !== "true" && value !== "false") {
        throw new Error("independent-review must be true or false");
      }
      protocol.independentReview = value === "true";
    } else if (key === "guardrail") {
      const [metric, direction] = value.split(":", 2);
      if (!metric || (direction !== "higher" && direction !== "lower")) {
        throw new Error("guardrail must be <metric>:<higher|lower>");
      }
      protocol.guardrails.push({ metric, direction });
    } else if (key) {
      throw new Error(`unknown protocol option: ${key}`);
    }
  }
  return protocol;
}

export function parseEvolutionProtocol(json: string): EvolutionProtocolV1 {
  try {
    const value = JSON.parse(json) as Partial<EvolutionProtocolV1>;
    return {
      version: 1,
      voluntary: true,
      metricsAreAdvisory: true,
      automaticContinuation: false,
      automaticPromotion: false,
      primaryMetric: typeof value.primaryMetric === "string" ? value.primaryMetric : undefined,
      direction: value.direction === "lower" ? "lower" : "higher",
      minTrials:
        Number.isInteger(value.minTrials) && (value.minTrials ?? 0) > 0 ? value.minTrials! : 3,
      minEffect:
        typeof value.minEffect === "number" && value.minEffect >= 0 ? value.minEffect : undefined,
      maxRuns: positiveOptionalInteger(value.maxRuns),
      maxDurationSeconds: positiveOptionalInteger(value.maxDurationSeconds),
      independentReview: value.independentReview === true,
      guardrails: Array.isArray(value.guardrails)
        ? value.guardrails.filter(
            (item): item is EvolutionGuardrail =>
              typeof item?.metric === "string" &&
              (item.direction === "higher" || item.direction === "lower"),
          )
        : [],
    };
  } catch {
    return createEvolutionProtocol({});
  }
}

export function evolutionBudgetState(
  session: EvolutionSessionRow,
  runCount: number,
  now = Date.now(),
): EvolutionBudgetState {
  const protocol = parseEvolutionProtocol(session.protocol);
  const reasons: string[] = [];
  const runsRemaining =
    protocol.maxRuns === undefined ? undefined : Math.max(0, protocol.maxRuns - runCount);
  if (runsRemaining === 0) reasons.push(`run budget reached (${protocol.maxRuns})`);

  let secondsRemaining: number | undefined;
  if (protocol.maxDurationSeconds !== undefined && session.started_at !== null) {
    const elapsedSeconds = Math.max(0, Math.floor((now - session.started_at) / 1000));
    secondsRemaining = Math.max(0, protocol.maxDurationSeconds - elapsedSeconds);
    if (secondsRemaining === 0) {
      reasons.push(`time budget reached (${protocol.maxDurationSeconds}s)`);
    }
  }
  return { exhausted: reasons.length > 0, reasons, runsRemaining, secondsRemaining };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveOptionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}
