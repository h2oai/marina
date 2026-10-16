// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ArrowRight, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import type {
  InvestigationAttempt,
  InvestigationKind,
  InvestigationRequest,
} from "../../../../src/sdk/investigation-types";
import { investigations } from "../../hooks/use-investigations";

const field =
  "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary";

export function InvestigationComposer({
  kind,
  onStarted,
  previous,
  onCancel,
}: {
  kind: InvestigationKind;
  onStarted(attempt: InvestigationAttempt): void;
  previous?: InvestigationAttempt;
  onCancel?: () => void;
}) {
  const questionId = useId();
  const [question, setQuestion] = useState(previous?.request.question ?? "");
  const [context, setContext] = useState(previous?.request.context ?? "");
  const [type, setType] = useState<"binary" | "number" | "choice">(
    previous?.request.answer?.type ?? "binary",
  );
  const [unit, setUnit] = useState(
    previous?.request.answer?.type === "number" ? (previous.request.answer.unit ?? "") : "",
  );
  const [options, setOptions] = useState(
    previous?.request.answer?.type === "choice"
      ? previous.request.answer.options.map((option) => option.label).join("\n")
      : "",
  );
  const [horizon, setHorizon] = useState(previous?.request.horizon?.slice(0, 10) ?? "");
  const [runs, setRuns] = useState(previous?.request.runs ?? 3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An uncertain network response reuses the same key for the same input. Deliberate edits get a new key.
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !question.trim()) return;
    const labels = options
      .split("\n")
      .map((label) => label.trim())
      .filter(Boolean);
    if (kind === "prediction" && type === "choice" && labels.length < 2) {
      setError("Add at least two mutually exclusive outcomes, one per line.");
      return;
    }
    const request: InvestigationRequest = {
      kind,
      question: question.trim(),
      ...(kind === "prediction"
        ? {
            answer:
              type === "choice"
                ? { type, options: labels.map((label, i) => ({ id: `option-${i + 1}`, label })) }
                : type === "number"
                  ? { type, ...(unit.trim() ? { unit: unit.trim() } : {}) }
                  : { type },
          }
        : {}),
      ...(context.trim() ? { context: context.trim() } : {}),
      ...(horizon ? { horizon: `${horizon}T23:59:59.999Z` } : {}),
      ...(kind === "prediction" ? { runs } : {}),
      ...(previous ? { caseId: previous.caseId, parentAttemptId: previous.id } : {}),
    };
    const fingerprint = JSON.stringify(request);
    if (submission.current?.fingerprint !== fingerprint)
      submission.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      onStarted((await investigations.start(request, submission.current.key)).attempt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start this investigation");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-primary/25 bg-surface/90 p-5 shadow-xl shadow-primary/5 sm:p-7"
    >
      <label className="block font-display text-xl text-text" htmlFor={questionId}>
        {kind === "prediction" ? "What shall we predict?" : "What would you like to understand?"}
      </label>
      <textarea
        id={questionId}
        className={`${field} mt-4 min-h-28 resize-y text-base`}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        maxLength={4000}
        placeholder={
          kind === "prediction"
            ? "Will our next release ship by the end of the month?"
            : "What are the strongest options, and what does the evidence say?"
        }
        required
      />
      <details className="mt-4 text-sm text-text-secondary">
        <summary className="cursor-pointer list-none">
          <ChevronDown className="mr-1 inline" size={14} /> Refine the question
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {kind === "prediction" && (
            <label>
              Answer format
              <select
                className={field}
                value={type}
                onChange={(event) => setType(event.target.value as typeof type)}
              >
                <option value="binary">Yes / No probability</option>
                <option value="number">Numeric estimate</option>
                <option value="choice">Mutually exclusive outcomes</option>
              </select>
            </label>
          )}
          {kind === "prediction" && (
            <label>
              Prediction horizon (end of UTC day)
              <input
                className={field}
                type="date"
                value={horizon}
                onChange={(event) => setHorizon(event.target.value)}
              />
            </label>
          )}
          {type === "number" && kind === "prediction" && (
            <label>
              Unit
              <input
                className={field}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                maxLength={80}
                placeholder="users, days, USD…"
              />
            </label>
          )}
          {type === "choice" && kind === "prediction" && (
            <label className="sm:col-span-2">
              Outcomes, one per line
              <textarea
                className={field}
                value={options}
                onChange={(event) => setOptions(event.target.value)}
                rows={3}
              />
            </label>
          )}
          <label className="sm:col-span-2">
            Context and assumptions
            <textarea
              className={field}
              value={context}
              onChange={(event) => setContext(event.target.value)}
              rows={3}
              maxLength={8000}
            />
          </label>
          {kind === "prediction" && (
            <label>
              Analyst runs
              <input
                className={field}
                type="number"
                min={1}
                max={9}
                value={runs}
                onChange={(event) => setRuns(Number(event.target.value))}
              />
            </label>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          {error} Try again to safely resume the same request.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy
            ? "Starting…"
            : previous
              ? "Run a new attempt"
              : kind === "prediction"
                ? "Predict"
                : "Research"}
          <ArrowRight size={16} />
        </button>
        {onCancel && (
          <button
            type="button"
            className="px-3 py-2 text-sm text-text-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        <p className="text-xs text-text-dim">Private to your account · uses configured providers</p>
      </div>
    </form>
  );
}
