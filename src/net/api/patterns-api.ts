// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/patterns/run` — `{pattern, task, members?, budgetUsd?}` runs ONE
 * free-text task under a named orchestration pattern and returns
 * `{message, success, pattern, trace: {steps, costUsd, fallback?}}`.
 *
 * The protocols live in `src/orchestration/text-patterns.ts` (free-text,
 * NOT the numeric arena/forecast formations of the same names). Patterns
 * that need a persistent crew are refused with a pointer to `marina:<crew>`.
 *
 * Behind the model API's auth, per-IP POST limit and run-key scoping like
 * every /v1 route (`handleModelApi`). Spend: the daily cap is checked up
 * front (429 `spend_cap_reached`), before every stage (`SpendGuard`, with the
 * caller's `budgetUsd`) and on every call (`proxyToUpstream`, which records
 * each dollar once as `model_api`). Members are explicit upstream ids (never
 * `marina…` ids, so a run cannot recurse into ensembles or crews); under a
 * passthru pin every member and the checker are the pin.
 */

import { availableModels } from "../../agent/available-models";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { SpendGuard } from "../../engine/spend-guard";
import { dailyCapRefusal } from "../../engine/spend-ledger";
import {
  CREW_ONLY_PATTERNS,
  isTextPattern,
  type PatternRunResult,
  runTextPattern,
  TEXT_PATTERNS,
  type TextComplete,
} from "../../orchestration/text-patterns";
import { normalizePatternName } from "../../world/templates/orchestration";
import { ensembleChecker, ensembleSize } from "../model-api/ensemble";
import {
  COST_USD_HEADER,
  errorJson,
  generateRequestId,
  json,
  type PassthruAuthResult,
  readModelJsonBody,
  requestTrace,
  unsupportedParam,
} from "../model-api/shared";
import { explicitUpstreamModel, proxyToUpstream } from "../model-api/upstream";
import { firstMessage, textOf, verifyPin } from "../model-api/verify";

const logger = new Logger();

/** Longest task accepted, in characters. */
export const PATTERN_TASK_MAX_CHARS = 16_000;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 5;
/** The whole run's deadline (every stage, every call). */
export const PATTERN_RUN_TIMEOUT_MS = 600_000;

interface PatternRunBody {
  pattern?: unknown;
  task?: unknown;
  members?: unknown;
  budgetUsd?: unknown;
}

function invalid(message: string, param: string): Response {
  return errorJson(400, message, { code: "invalid_request_error", param });
}

/** Validated `members`: 2–5 non-empty strings, none a `marina…` id. */
function membersOf(raw: unknown): { members?: string[] } | { error: Response } {
  if (raw === undefined) return {};
  if (
    !Array.isArray(raw) ||
    raw.length < MIN_MEMBERS ||
    raw.length > MAX_MEMBERS ||
    raw.some((m) => typeof m !== "string" || !m.trim())
  ) {
    return {
      error: invalid(
        `members must be ${MIN_MEMBERS}–${MAX_MEMBERS} model ids (repeats allowed)`,
        "members",
      ),
    };
  }
  const members = (raw as string[]).map((m) => m.trim());
  const recursive = members.find((m) => m.toLowerCase().startsWith("marina"));
  if (recursive) {
    return {
      error: unsupportedParam(
        "members",
        `"${recursive}" is a Marina model id; members must be upstream model ids (a pattern run never calls Marina's own ensembles or crews).`,
      ),
    };
  }
  return { members };
}

export async function handlePatternRun(
  req: Request,
  engine: Engine,
  _auth?: PassthruAuthResult,
): Promise<Response> {
  const read = await readModelJsonBody(req);
  if (!read.ok) return read.response;
  const body = read.body as PatternRunBody;

  const rawPattern = typeof body.pattern === "string" ? body.pattern.trim().toLowerCase() : "";
  const pattern = normalizePatternName(rawPattern);
  if (!isTextPattern(pattern)) {
    const crewReason = CREW_ONLY_PATTERNS[pattern];
    if (crewReason) {
      return unsupportedParam(
        "pattern",
        `"${pattern}" needs a persistent crew (${crewReason}); run it as a crew and call it as model "marina:<crew>". This route runs: ${TEXT_PATTERNS.join(", ")}.`,
      );
    }
    return invalid(
      `pattern must be one of: ${TEXT_PATTERNS.join(", ")} (crew-only: ${Object.keys(CREW_ONLY_PATTERNS).join(", ")})`,
      "pattern",
    );
  }

  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task || task.length > PATTERN_TASK_MAX_CHARS) {
    return invalid(
      `task must be a non-empty string of at most ${PATTERN_TASK_MAX_CHARS} characters`,
      "task",
    );
  }

  const listed = membersOf(body.members);
  if ("error" in listed) return listed.error;

  let budgetUsd: number | undefined;
  if (body.budgetUsd !== undefined) {
    if (
      typeof body.budgetUsd !== "number" ||
      !Number.isFinite(body.budgetUsd) ||
      body.budgetUsd <= 0
    ) {
      return invalid("budgetUsd must be a finite number of USD greater than 0", "budgetUsd");
    }
    budgetUsd = body.budgetUsd;
  }

  // Which models run: under a passthru pin only the pin; otherwise listed
  // explicit upstream ids, or the installation's first available model.
  const pin = verifyPin(engine);
  let members: string[];
  if (listed.members) {
    const other = pin ? listed.members.find((m) => m !== pin) : undefined;
    if (other) {
      return errorJson(403, `This endpoint is pinned to "${pin}"; members cannot use "${other}"`, {
        code: "model_not_allowed",
      });
    }
    const unreachable = pin
      ? undefined
      : listed.members.find((m) => !explicitUpstreamModel(engine, m));
    if (unreachable) {
      return errorJson(
        400,
        `members must be reachable upstream ids (<provider>/<model>); "${unreachable}" is not one`,
        { code: "model_not_found", param: "members" },
      );
    }
    members = listed.members;
  } else {
    const fallback = pin || availableModels()[0]?.spec;
    if (!fallback) {
      return errorJson(503, "no model is available to run the pattern's members", {
        code: "pattern_unavailable",
      });
    }
    members = Array.from({ length: ensembleSize() }, () => fallback);
  }

  const capped = dailyCapRefusal();
  if (capped) return errorJson(429, capped, { code: "spend_cap_reached" });

  const checker = ensembleChecker(engine, members[0]!, pin);
  const requestId = generateRequestId();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("pattern run deadline reached", "TimeoutError")),
    PATTERN_RUN_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([req.signal, deadline.signal]);

  const complete: TextComplete = async (model, system, user) => {
    const resp = await proxyToUpstream(
      engine,
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
      },
      pin || undefined,
      { routeKind: "passthru", routeReason: `pattern:${pattern}` },
      { clientSignal: signal, providerFallback: false },
    );
    const raw = await resp.text();
    const cost = Number(resp.headers.get(COST_USD_HEADER));
    if (!resp.ok) throw new Error(`upstream ${resp.status}: ${raw.slice(0, 300)}`);
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // allow-empty-catch: a non-JSON body is reported below as no text
    }
    const text = textOf(firstMessage(parsed)?.content);
    return { text, costUsd: Number.isFinite(cost) ? cost : 0 };
  };

  let result: PatternRunResult;
  try {
    result = await runTextPattern(pattern, task, members, {
      complete,
      checker,
      budget: new SpendGuard({
        label: "pattern budget",
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        concurrency: members.length,
      }),
      signal,
    });
  } catch (e) {
    logger.warn("model-api", `pattern run ${pattern} failed: ${getErrorMessage(e)}`);
    return errorJson(500, `pattern run failed: ${getErrorMessage(e)}`, { code: "server_error" });
  } finally {
    clearTimeout(timer);
  }

  // One summary event: numbers and labels only (no task or answer text).
  const failed = result.trace.steps.filter((s) => s.status === "failed").length;
  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "completed",
    requestId,
    ...requestTrace(requestId),
    model: `pattern:${pattern}`,
    target: members.join(","),
    routeKind: "passthru",
    routeReason: `pattern:${pattern}:${result.success ? "ok" : "stopped"}:steps=${result.trace.steps.length}:failed=${failed}`,
    timestamp: Date.now(),
  });
  return json(result, 200, {
    "x-request-id": requestId,
    [COST_USD_HEADER]: result.trace.costUsd.toFixed(8),
  });
}
