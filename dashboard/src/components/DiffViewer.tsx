// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { splitDiff } from "../lib/split-diff";

export function DiffViewer({ patch }: { patch: string }) {
  const [split, setSplit] = useState(true);
  const rows = useMemo(() => splitDiff(patch), [patch]);
  return (
    <section
      aria-label="Artifact diff"
      className="mt-2 overflow-hidden rounded border border-border"
    >
      <div className="flex justify-between bg-bg-hover px-2 py-1 text-xs">
        <span>Patch review</span>
        <button type="button" aria-pressed={split} onClick={() => setSplit((value) => !value)}>
          {split ? "Show unified diff" : "Show side-by-side diff"}
        </button>
      </div>
      <div className="max-h-[420px] overflow-auto">
        {split ? (
          <table className="w-full table-fixed border-collapse font-mono text-[11px]">
            <thead>
              <tr>
                <th className="border-r border-border px-2 text-left">Before</th>
                <th className="px-2 text-left">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable patch rows have stable line order
                <tr key={index}>
                  {row.header !== undefined ? (
                    <td
                      colSpan={2}
                      className="whitespace-pre-wrap break-words bg-bg-hover px-2 text-primary"
                    >
                      {row.header}
                    </td>
                  ) : (
                    (["left", "right"] as const).map((side) => (
                      <td
                        key={side}
                        className={`border-r border-border align-top ${row[side]?.changed ? (side === "left" ? "bg-danger/10" : "bg-success/10") : ""}`}
                      >
                        <div className="flex gap-2 px-2">
                          <span className="w-8 shrink-0 select-none text-right text-text-dim">
                            {row[side]?.number}
                          </span>
                          <code className="whitespace-pre-wrap break-all">
                            {row[side]?.text ?? " "}
                          </code>
                        </div>
                      </td>
                    ))
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-2 font-mono text-xs">{patch}</pre>
        )}
      </div>
    </section>
  );
}
