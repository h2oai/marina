// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowUpRight, CircleHelp, Sparkles } from "lucide-react";
import { investigationEstimate } from "../../../../src/sdk/investigation-text";
import type { InvestigationAttempt } from "../../../../src/sdk/investigation-types";
import { renderChatText } from "../chat-render-text";

export function InvestigationAnswer({
  attempt,
  compact = false,
}: {
  attempt: InvestigationAttempt;
  compact?: boolean;
}) {
  const result = attempt.result;
  const value = investigationEstimate(result?.estimate);
  return (
    <section
      className={`rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-surface to-surface ${compact ? "p-4" : "p-5 sm:p-8"}`}
      aria-label="Investigation answer"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <Sparkles size={14} className="text-primary" />
        <span>{attempt.request.kind === "prediction" ? "Marina predicts" : "Marina research"}</span>
        <span className="rounded-full border border-border px-2 py-0.5">
          {result?.availability === "final"
            ? "Answer ready"
            : result?.availability === "partial"
              ? "Partial answer"
              : attempt.state}
        </span>
      </div>
      <h2
        className={`${compact ? "text-base" : "text-lg sm:text-xl"} font-display font-medium leading-snug text-text`}
      >
        {attempt.request.question}
      </h2>
      {result ? (
        <>
          {value && (
            <p
              className={`${compact ? "text-2xl" : "text-3xl sm:text-5xl"} my-5 break-words font-display font-semibold tracking-tight text-primary`}
            >
              {value}
            </p>
          )}
          {(!value || result.summary !== value) && (
            <div className="mt-3 text-base leading-relaxed text-text">
              {renderChatText(result.summary)}
            </div>
          )}
          {result.estimate?.type === "binary" && result.estimate.probability !== undefined && (
            <div
              className="mt-4 flex h-2 overflow-hidden rounded-full bg-border"
              aria-hidden="true"
            >
              <span
                className="bg-primary"
                style={{ width: `${result.estimate.probability * 100}%` }}
              />
            </div>
          )}
          {result.estimate?.type === "choice" && (
            <ul className="mt-4 space-y-2" aria-label="Outcome probabilities">
              {result.estimate.options.map((option) => (
                <li key={option.id} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 break-words">{option.label}</span>
                  <span className="tabular-nums text-primary">
                    {option.probability === undefined
                      ? "unavailable"
                      : `${Number((option.probability * 100).toFixed(1))}%`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!!result.limitations.length && (
            <div className="mt-5 rounded-xl bg-surface/80 p-3 text-sm text-text-secondary">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <CircleHelp size={14} /> Keep in mind
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {result.limitations.slice(0, compact ? 2 : undefined).map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-dim">
            {result.horizon && <span>By {new Date(result.horizon).toLocaleString()}</span>}
            {result.cutoff && (
              <span>Evidence as of {new Date(result.cutoff).toLocaleString()}</span>
            )}
            <span>
              {result.sources.length} source{result.sources.length === 1 ? "" : "s"}
            </span>
          </div>
        </>
      ) : (
        <div
          className="mt-5 rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary"
          role="status"
        >
          {attempt.state === "queued" || attempt.state === "running" ? (
            <>
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />{" "}
              Gathering evidence and evaluating the question. Live work appears below.
            </>
          ) : (
            (attempt.error ??
            `This attempt was ${attempt.state}. Its captured work remains available.`)
          )}
        </div>
      )}
      {compact && (
        <a
          className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          href={`/${attempt.request.kind === "research" ? "research" : "predict"}/${encodeURIComponent(attempt.caseId)}?attempt=${encodeURIComponent(attempt.id)}`}
        >
          Explore the answer <ArrowUpRight size={14} />
        </a>
      )}
    </section>
  );
}
