// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import type { InvestigationSnapshot } from "../../../../src/sdk/investigation-types";
import { investigations } from "../../hooks/use-investigations";

export function InvestigationResolution({
  snapshot,
  onSaved,
}: {
  snapshot: InvestigationSnapshot;
  onSaved(): void;
}) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!snapshot.attempt.result?.answerId) return null;
  const shape = snapshot.attempt.request.answer ?? { type: "binary" };
  if (snapshot.resolution)
    return (
      <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm">
        <h3 className="mb-2 font-medium text-primary">Outcome recorded</h3>
        <pre className="whitespace-pre-wrap break-words text-xs text-text-secondary">
          {JSON.stringify(snapshot.resolution.value, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-text-dim">
          Loss: {snapshot.resolution.loss ?? "unavailable"} ·{" "}
          {new Date(snapshot.resolution.at).toLocaleString()} · kept private
        </p>
      </div>
    );
  if (snapshot.case.access === "read") return null;
  const options =
    shape.type === "binary"
      ? [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]
      : shape.type === "choice"
        ? shape.options
        : [];
  return (
    <details className="rounded-xl border border-border p-4 text-sm">
      <summary className="cursor-pointer text-text-secondary">Record the observed outcome</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await investigations.resolve(
              snapshot.attempt.id,
              shape.type === "number" ? { value: Number(value) } : { option: value },
            );
            onSaved();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Could not record outcome");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-xs text-text-dim">
          File the actual outcome once it is known. Marina uses its existing forecast scorer. This
          settlement is final and stays out of shared learning.
        </p>
        <label className="block" htmlFor={inputId}>
          Observed outcome
          {shape.type === "number" ? (
            <input
              id={inputId}
              type="number"
              step="any"
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="ml-3 rounded border border-border bg-bg p-2"
            />
          ) : (
            <select
              id={inputId}
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="ml-3 rounded border border-border bg-bg p-2"
            >
              <option value="">Select…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </label>
        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        <button
          disabled={busy || !value}
          className="rounded-lg border border-primary/30 px-3 py-2 text-primary disabled:opacity-40"
          type="submit"
        >
          Record final outcome
        </button>
      </form>
    </details>
  );
}
