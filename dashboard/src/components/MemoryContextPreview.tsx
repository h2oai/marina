// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import type { UnifiedContextResult } from "../../../src/sdk/memory-context";
import { openMemory } from "../hooks/use-workspace-state";
import { requestParticipant } from "../lib/memory-service";

export function MemoryContextPreview({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState("all");
  const [budget, setBudget] = useState(4096);
  const [result, setResult] = useState<{ createdAt: number; context: UnifiedContextResult } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function refresh() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const value = await requestParticipant<{ createdAt: number; context: UnifiedContextResult }>(
        "context_preview",
        { query, scope, budgetBytes: budget },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(value);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Context unavailable");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Your memory context" className="overflow-auto space-y-4 p-4">
      <h3 className="font-semibold">Your memory context preview</h3>
      <p className="text-sm text-text-dim">
        Inspect what your own memory contributes for a query. This uses the same retrieval builder
        as agent context. It is not another participant’s private context or a record of an earlier
        model prompt. Previewing does not award recall credit.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label className="block">
          Query
          <input
            className="block w-full rounded border border-border bg-bg p-2"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={4000}
            required
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label>
            Scope
            <select
              className="block rounded bg-bg p-2"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">All tiers</option>
              <option value="evidence">Evidence and proposals</option>
            </select>
          </label>
          <label>
            Content budget (bytes)
            <input
              className="block rounded bg-bg p-2"
              type="number"
              min={256}
              max={16384}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </label>
          <button
            className="self-end rounded border border-border px-3 py-2"
            type="submit"
            disabled={busy}
          >
            {busy ? "Retrieving…" : "Refresh context"}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="text-sm text-text-dim">
            {result.context.entity} · query “{result.context.query}” · {result.context.scope} ·{" "}
            {result.context.usedBytes}/{result.context.budgetBytes} content bytes · refreshed{" "}
            {new Date(result.createdAt).toLocaleTimeString()}
            {result.context.truncated ? " · truncated to budget" : ""}
          </p>
          {result.context.degraded.map((item) => (
            <p key={`${item.tier}:${item.code}`} role="status">
              {item.tier}: {item.message}
            </p>
          ))}
          {result.context.tiers.map((tier) => (
            <details key={tier.tier} className="rounded border border-border p-3">
              <summary className="cursor-pointer">
                [{tier.tier}] {tier.items.length} items
                {tier.omitted ? ` · ${tier.omitted} omitted` : ""}
              </summary>
              {tier.items.map((item) => (
                <article key={item.id} className="mt-3 border-t border-border pt-3">
                  <p className="text-xs text-text-dim">
                    {item.provenance} · {item.bytes} bytes{item.truncated ? " · truncated" : ""}
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{item.content}</p>
                  {(item.meta?.kind === "record" || typeof item.meta?.record_id === "string") && (
                    <button
                      type="button"
                      className="mt-1 text-xs text-primary"
                      onClick={() =>
                        openMemory(
                          "",
                          typeof item.meta?.record_id === "string" ? item.meta.record_id : item.id,
                          typeof item.meta?.space_id === "string" ? item.meta.space_id : undefined,
                        )
                      }
                    >
                      Inspect or correct memory
                    </button>
                  )}
                  {item.meta && (
                    <details>
                      <summary className="text-xs">Provenance and references</summary>
                      <pre className="overflow-auto text-xs">
                        {JSON.stringify(item.meta, null, 2)}
                      </pre>
                    </details>
                  )}
                </article>
              ))}
            </details>
          ))}
          <p className="text-xs text-text-dim">
            To correct a record, open Memories, find the record, and revise it with its source.
            Refresh this preview afterward.
          </p>
        </>
      )}
    </section>
  );
}
