// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderProbeSummary } from "../../lib/ops-types";
import { formatAgo, formatDuration, PROVIDER_VERDICT_CLASS, providerVerdict } from "./format";
import { Chip, Empty } from "./primitives";

export const PROVIDERS_EMPTY_TEXT = "No provider probe has run yet.";
export const PROVIDERS_EMPTY_HINT = "readiness providers";
export const PROVIDERS_SCOPED_TEXT = "Provider probes are visible to operators only.";

function Check({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span className="text-text-dim">—</span>;
  return (
    <span
      role="img"
      className={ok ? "text-success" : "text-danger"}
      aria-label={`${label}: ${ok ? "ok" : "failed"}`}
    >
      {ok ? "✓" : "✗"}
    </span>
  );
}

export function ProvidersSection({
  providers,
  privileged,
}: {
  providers: ProviderProbeSummary[] | null;
  privileged: boolean;
}) {
  if (!privileged) return <Empty>{PROVIDERS_SCOPED_TEXT}</Empty>;
  if (!providers || providers.length === 0) {
    return (
      <Empty>
        {PROVIDERS_EMPTY_TEXT} Run <code className="text-text">{PROVIDERS_EMPTY_HINT}</code>{" "}
        in-world.
      </Empty>
    );
  }
  const checkedAt = Math.max(...providers.map((p) => p.checkedAt));
  return (
    <div className="space-y-1">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[10px]">
          <thead className="text-[8px] uppercase text-text-dim">
            <tr>
              <th className="py-0.5 pr-2">Provider</th>
              <th className="py-0.5 pr-2">Verdict</th>
              <th className="py-0.5 pr-2 text-center">Text</th>
              <th className="py-0.5 pr-2 text-center">System</th>
              <th className="py-0.5 pr-2 text-center">Tool call</th>
              <th className="py-0.5 pr-2">Served by</th>
              <th className="py-0.5 pr-2 text-right">Latency</th>
              <th className="py-0.5">Detail</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const verdict = providerVerdict(p);
              return (
                <tr
                  key={`${p.provider}/${p.model}`}
                  className="border-t border-border/60 align-top"
                  data-testid={`ops-provider-${p.provider}`}
                >
                  <td className="py-0.5 pr-2">
                    <div className="text-text-bright">{p.provider}</div>
                    <div className="text-[9px] text-text-dim">{p.model}</div>
                  </td>
                  <td className="py-0.5 pr-2">
                    <Chip className={PROVIDER_VERDICT_CLASS[verdict]}>{verdict}</Chip>
                  </td>
                  <td className="py-0.5 pr-2 text-center">
                    <Check ok={p.textOk} label={`${p.provider} text`} />
                  </td>
                  <td className="py-0.5 pr-2 text-center">
                    <Check ok={p.systemHonored} label={`${p.provider} second system message`} />
                  </td>
                  <td className="py-0.5 pr-2 text-center" title={p.toolCallError ?? undefined}>
                    <Check ok={p.toolCallOk} label={`${p.provider} tool call`} />
                  </td>
                  <td className="py-0.5 pr-2 text-text-dim">{p.servedBy ?? "—"}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">
                    {formatDuration(p.latencyMs)}
                  </td>
                  <td className="max-w-[260px] py-0.5 text-text-dim">
                    <span
                      className="line-clamp-2 break-words"
                      title={p.error ?? p.toolCallError ?? undefined}
                    >
                      {p.error ?? p.toolCallError ?? (p.status === null ? "" : `HTTP ${p.status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[9px] text-text-dim">Last probe {formatAgo(checkedAt)}.</div>
    </div>
  );
}
