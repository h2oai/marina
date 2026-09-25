// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../auth/rate-limiter";
import type { ForecastAnswer } from "../../forecast/question";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, RoomContext } from "../../types";

const USAGE = "Usage: forecast <question>   e.g. forecast Will the Fed cut rates in October 2026?";
/** Each forecast spends real money (web research + several models): a small per-entity budget. */
const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, refillInterval: 12 * 60_000 });

/**
 * `forecast <question>` — a calibrated, evidence-backed answer to any question:
 * web research with cited sources, figures checked against those sources, one
 * analyst per model vendor, a judge that weights them by how well the evidence
 * supports them (src/forecast). Rank 0: any entity may ask; the budget caps spend.
 */
export function forecastCommand(): CommandDef {
  return {
    name: "forecast",
    aliases: ["predict"],
    help: `Forecast any question with cited, verified evidence and several models.\n${USAGE}`,
    minRank: 0,
    handler: (ctx: RoomContext, input) => {
      const question = input.args.trim();
      if (!question) return ctx.send(input.entity, USAGE);
      if (!limiter.consume(input.entity)) {
        return ctx.send(
          input.entity,
          "Forecast budget used up for now — try again in a few minutes.",
        );
      }
      ctx.send(
        input.entity,
        dim("Researching, checking sources, asking several models… (~20–60 s)"),
      );
      return (async () => {
        const [{ forecastQuestion }, { forecastDeps }] = await Promise.all([
          import("../../forecast/question"),
          import("../../forecast/service"),
        ]);
        const made = forecastDeps();
        if ("error" in made) return ctx.send(input.entity, made.error);
        const a = await forecastQuestion({ question }, made.deps);
        a.costUsd = made.costUsd();
        ctx.send(input.entity, render(a));
      })().catch((err) =>
        ctx.send(
          input.entity,
          `Forecast failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    },
  };
}

export function render(a: ForecastAnswer): string {
  const headline =
    a.kind === "probability"
      ? a.probability === undefined
        ? "no answer"
        : `${Math.round(a.probability * 100)}% yes`
      : a.mean === undefined
        ? "no answer"
        : `${a.mean} (80%: ${a.interval?.[0]} – ${a.interval?.[1]})`;
  return [
    header("Forecast"),
    separator(),
    a.question,
    `→ ${bold(headline)}`,
    ...(a.caveat ? [dim(`caveat: ${a.caveat}`)] : []),
    "",
    ...a.analysts.map((x) => {
      const v =
        x.probability !== undefined
          ? `${Math.round(x.probability * 100)}%`
          : x.mean !== undefined
            ? `${x.mean} ± ${x.sd}`
            : x.status;
      return `  ${bold(x.name)} ${v}${x.grounded === undefined ? "" : dim(` · grounded ${x.grounded.toFixed(2)}`)}\n    ${dim(x.reason ?? "")}`;
    }),
    ...(a.verification
      ? [
          dim(
            `evidence: ${a.verification.verified ?? 0} verified · ${a.verification.unverified ?? 0} unverified · ${a.verification.unreachable ?? 0} unreachable`,
          ),
        ]
      : []),
    ...a.sources.slice(0, 5).map((s) => dim(`  - ${s.url}`)),
    dim(`cost $${a.costUsd.toFixed(3)} · ${(a.latencyMs / 1000).toFixed(0)} s`),
  ].join("\n");
}
