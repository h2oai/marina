// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admin → Memory: operator view of the memory system's moving parts —
 * trust posture, assistance jobs, resolutions/ratifications, standing credits,
 * passthru receipts, hygiene lines, and institutional spaces.
 *
 * Bootstraps from `GET /api/memory/overview` and stays live through the
 * dashboard WebSocket: `memory_service_event` refreshes the overview
 * (debounced 2 s); `memory_job` patches jobs in place (see JobsSection).
 */

import { useQuery } from "@tanstack/react-query";
import {
  Coins,
  Gauge,
  Landmark,
  ListChecks,
  Receipt,
  Scale,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { useInvalidateOnEvent } from "../hooks/use-realtime";
import { describeApiError, fetchApi } from "../lib/api";
import type {
  MemoryCreditView,
  MemoryOverview,
  MemoryRatificationView,
  MemoryReceiptView,
  MemoryResolutionView,
} from "../lib/memory-observability-types";
import type { DashboardEvent } from "../lib/types";
import { AnimatedNumber } from "./AnimatedNumber";
import { GlassPanel } from "./GlassPanel";
import {
  cacheHitRate,
  formatAge,
  formatBytes,
  HYGIENE_KEYS,
  parseHygieneLine,
  resolutionPolicyClass,
  trustProfileClass,
  trustProfileLabel,
} from "./memory-ops/format";
import { JobsSection } from "./memory-ops/JobsSection";
import { RatiosSection } from "./memory-ops/RatiosSection";
import { TierBars } from "./memory-ops/TierBars";

export const MEMORY_OVERVIEW_KEY = ["memory-overview"] as const;

/** Service events that change what the overview reports. */
const OVERVIEW_REFRESH_KINDS = new Set(["memory.resolved", "assistance.adopted", "memory.created"]);

export function MemoryOpsTab({
  onOpenTrace,
  focusJobId,
}: {
  onOpenTrace?: (traceId: string) => void;
  /** Deep-link from the canvas MEMORY layer: load, reveal and expand this job. */
  focusJobId?: string;
}) {
  const overview = useQuery<MemoryOverview>({
    queryKey: [...MEMORY_OVERVIEW_KEY],
    queryFn: () => fetchApi<MemoryOverview>("/api/memory/overview"),
    refetchInterval: 30_000,
  });
  useInvalidateOnEvent(
    MEMORY_OVERVIEW_KEY,
    useCallback(
      (event: DashboardEvent) =>
        (event.type === "memory_service_event" &&
          typeof event.kind === "string" &&
          OVERVIEW_REFRESH_KINDS.has(event.kind)) ||
        // Job counters in Posture drift with every job transition too.
        event.type === "memory_job",
      [],
    ),
    2_000,
  );

  const data = overview.data;
  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="text-text-dim">
          {overview.isLoading && !data ? "Loading memory overview…" : "Live · refreshes on events"}
        </span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void overview.refetch()}
        >
          Refresh
        </button>
      </div>
      {overview.error && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-red-300">
          {describeApiError(overview.error)}{" "}
          <button type="button" className="underline" onClick={() => void overview.refetch()}>
            Retry
          </button>
        </div>
      )}

      <Section title="Posture" icon={<ShieldCheck size={12} />}>
        {data ? <PostureSection data={data} /> : <Placeholder />}
      </Section>

      <Section title="Continuous hygiene" icon={<Gauge size={12} />}>
        {data ? <RatiosSection ratios={data.ratios} /> : <Placeholder />}
      </Section>

      <Section title="Jobs" icon={<ListChecks size={12} />}>
        <JobsSection focusJobId={focusJobId} />
      </Section>

      <Section title="Resolutions & ratifications" icon={<Scale size={12} />}>
        {data ? (
          <ResolutionsSection resolutions={data.resolutions} ratifications={data.ratifications} />
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section title="Standing credits" icon={<Coins size={12} />}>
        {data ? <CreditsSection credits={data.credits} /> : <Placeholder />}
      </Section>

      <Section title="Receipts" icon={<Receipt size={12} />}>
        {data ? (
          <ReceiptsSection receipts={data.receipts} onOpenTrace={onOpenTrace} />
        ) : (
          <Placeholder />
        )}
      </Section>

      <Section title="Hygiene" icon={<Sparkles size={12} />}>
        {data ? <HygieneSection hygiene={data.hygiene} /> : <Placeholder />}
      </Section>

      <Section title="Institutional spaces" icon={<Landmark size={12} />}>
        {data ? <SpacesSection spaces={data.spaces.institutional} /> : <Placeholder />}
      </Section>
    </div>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * GlassPanel frame with a local header. We deliberately do not pass `title`
 * to GlassPanel: its header doubles as the grid `drag-handle`, and nesting one
 * inside the Admin body would make every section header drag the Admin panel.
 */
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <GlassPanel className="h-auto shrink-0">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
          <span className="text-primary">{icon}</span>
          <h3 className="flex-1 font-display text-[11px] font-semibold tracking-wider text-primary uppercase">
            {title}
          </h3>
        </div>
        <div className="p-2">{children}</div>
      </GlassPanel>
    </section>
  );
}

function Placeholder() {
  return <div className="text-text-dim">Waiting for the memory overview…</div>;
}

function Metric({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  title?: string;
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-text-bright";
  return (
    <div className="rounded border border-border bg-bg/40 p-1.5" title={title}>
      <div className="truncate text-[8px] uppercase text-text-dim">{label}</div>
      <strong className={color}>{value}</strong>
    </div>
  );
}

function Chip({
  className,
  children,
  title,
}: {
  className: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${className}`}
      title={title}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-border p-2 text-text-dim">{children}</div>;
}

// ── 1. Posture ──────────────────────────────────────────────────────────────

function PostureSection({ data }: { data: MemoryOverview }) {
  const rate = cacheHitRate(data.receipts.cache);
  const { cache } = data.receipts;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          className={trustProfileClass(data.trust.profile)}
          title="Trust profile — local is ungated; shared/public gate adoption and ratification"
        >
          {trustProfileLabel(data.trust)}
        </Chip>
        <Chip className="border-border text-text" title="MARINA_AUTONOMY posture (env-only)">
          autonomy · {data.trust.autonomy}
        </Chip>
        <span className="ml-auto flex items-baseline gap-1 text-text-dim">
          cache hit rate{" "}
          <AnimatedNumber
            value={rate * 100}
            format={(n) => `${Math.round(n)}%`}
            className="text-[13px] font-semibold text-text-bright"
          />
          <span title={`${cache.hits} hits · ${cache.misses} misses · ${cache.stores} stores`}>
            ({cache.hits}/{cache.hits + cache.misses}, {cache.stores} stored)
          </span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        <Metric
          label="Open jobs"
          value={<AnimatedNumber value={data.jobs.open} />}
          tone={data.jobs.open > 0 ? "warning" : "default"}
        />
        <Metric label="Hygiene / 24h" value={data.dispatch.hygieneJobs24h} />
        <Metric label="Accumulation / 24h" value={data.dispatch.accumulationJobs24h} />
        <Metric label="Shared-write / 24h" value={data.dispatch.sharedWriteJobs24h} />
      </div>
      <div className="grid grid-cols-4 gap-1">
        <Metric label="Answered / 24h" value={data.jobs.answered24h} tone="success" />
        <Metric label="Abstained / 24h" value={data.jobs.abstained24h} />
        <Metric
          label="Cancelled / 24h"
          value={data.jobs.cancelled24h}
          tone={data.jobs.cancelled24h > 0 ? "warning" : "default"}
        />
        <Metric
          label="By marker"
          value={
            Object.keys(data.jobs.byMarker).length === 0
              ? "—"
              : Object.entries(data.jobs.byMarker)
                  .map(([marker, count]) => `${marker} ${count}`)
                  .join(" · ")
          }
        />
      </div>
    </div>
  );
}

// ── 3. Resolutions & ratifications ──────────────────────────────────────────

function ResolutionsSection({
  resolutions,
  ratifications,
}: {
  resolutions: MemoryResolutionView[];
  ratifications: MemoryRatificationView[];
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <section className="space-y-1" aria-label="Resolutions">
        <div className="text-[9px] uppercase tracking-wider text-text-dim">Resolutions</div>
        {resolutions.length === 0 ? (
          <Empty>
            No resolutions yet. Resolve a competing pair from the world with{" "}
            <code className="text-text">
              memory resolve &lt;ID&gt;
              last_writer_wins|evidence_weighted|await_confirmation|keep_both &lt;JSON&gt;
            </code>
            . The hygiene line reports <code>competing=N</code> when there is work to do.
          </Empty>
        ) : (
          resolutions.map((resolution) => (
            <ResolutionRow key={resolution.id} resolution={resolution} />
          ))
        )}
      </section>
      <section className="space-y-1" aria-label="Ratifications">
        <div className="text-[9px] uppercase tracking-wider text-text-dim">Ratifications</div>
        {ratifications.length === 0 ? (
          <Empty>
            Nothing ratified into an institutional space yet. Adopt an answered job into{" "}
            <code>guide</code> with{" "}
            <code className="text-text">memory adopt &lt;JOB&gt; space &lt;ID&gt;</code>, or promote
            a proposal with <code className="text-text">pool guide ratify &lt;noteId&gt;</code>.
          </Empty>
        ) : (
          ratifications.map((ratification) => (
            <RatificationRow
              key={`${ratification.spaceId}:${ratification.recordId}`}
              ratification={ratification}
            />
          ))
        )}
      </section>
    </div>
  );
}

function ResolutionRow({ resolution }: { resolution: MemoryResolutionView }) {
  const space = resolution.spaceName ?? resolution.spaceId;
  return (
    <details
      className="rounded border border-border bg-bg/30 px-2 py-1"
      title={resolution.rationale}
      data-testid={`resolution-${resolution.id}`}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <Chip className={resolutionPolicyClass(resolution.policy)}>
          {resolution.policy.replaceAll("_", " ")}
        </Chip>
        <span className="text-text">{resolution.actorName}</span>
        <span className="truncate text-text-dim" title={resolution.spaceId}>
          {space}
        </span>
        <span className="ml-auto text-[9px] text-text-dim">{formatAge(resolution.at)} ago</span>
      </summary>
      <div className="mt-1 space-y-0.5 text-[9px] text-text-dim">
        <div>
          winner:{" "}
          <span className="font-mono text-text">{resolution.winnerId ?? "none (kept both)"}</span> ·{" "}
          {resolution.loserIds.length} loser{resolution.loserIds.length === 1 ? "" : "s"}
          {resolution.loserIds.length > 0 && (
            <span className="font-mono" title={resolution.loserIds.join(", ")}>
              {" "}
              ({resolution.loserIds.slice(0, 3).join(", ")}
              {resolution.loserIds.length > 3 ? ", …" : ""})
            </span>
          )}
        </div>
        {resolution.rationale && <div className="text-text">{resolution.rationale}</div>}
      </div>
    </details>
  );
}

function RatificationRow({ ratification }: { ratification: MemoryRatificationView }) {
  return (
    <div className="rounded border border-border bg-bg/30 px-2 py-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className="border-emerald-400/60 text-emerald-400">{ratification.spaceName}</Chip>
        <span className="font-mono text-[9px] text-text-dim" title={ratification.recordId}>
          {ratification.recordId.length > 14
            ? `${ratification.recordId.slice(0, 14)}…`
            : ratification.recordId}
        </span>
        <span className="ml-auto text-[9px] text-text-dim">{formatAge(ratification.at)} ago</span>
      </div>
      {ratification.preview && (
        <div className="mt-0.5 truncate text-text" title={ratification.preview}>
          {ratification.preview}
        </div>
      )}
      <div className="mt-0.5 text-[9px] text-text-dim">
        ratified by <span className="text-text">{ratification.ratifiedBy.name}</span> · standing{" "}
        {ratification.ratifiedBy.standing.toFixed(1)} · {ratification.ratifiedBy.basis}
      </div>
    </div>
  );
}

// ── 4. Standing credits ─────────────────────────────────────────────────────

function CreditsSection({ credits }: { credits: MemoryCreditView[] }) {
  if (credits.length === 0) {
    return (
      <Empty>
        No assistance credits recorded. Standing flows when a proposal is adopted (
        <code>assistance_adopted</code> +1.0 to the helper), an abstention is confirmed (
        <code>assistance_abstained_confirmed</code> +0.25), or a record is superseded by a
        resolution (<code>assistance_superseded</code> −0.5).
      </Empty>
    );
  }
  return (
    <div className="space-y-1">
      {credits.map((credit) => (
        <div
          key={`${credit.kind}:${credit.ref}:${credit.at}`}
          className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-bg/30 px-2 py-1"
        >
          <Chip
            className={
              credit.amount < 0 ? "border-red-400/60 text-red-300" : "border-border text-text"
            }
          >
            {credit.kind.replace(/^assistance_/, "").replaceAll("_", " ")}
          </Chip>
          <span className="text-text">{credit.entityName}</span>
          <span
            className={`font-mono ${credit.amount < 0 ? "text-red-300" : "text-emerald-400"}`}
            data-testid="credit-amount"
          >
            {credit.amount >= 0 ? "+" : "−"}
            {Math.abs(credit.amount).toFixed(2)}
          </span>
          <span className="truncate font-mono text-[9px] text-text-dim" title={credit.ref}>
            {credit.ref}
          </span>
          <span className="ml-auto text-[9px] text-text-dim">{formatAge(credit.at)} ago</span>
        </div>
      ))}
    </div>
  );
}

// ── 5. Receipts ─────────────────────────────────────────────────────────────

function ReceiptsSection({
  receipts,
  onOpenTrace,
}: {
  receipts: MemoryOverview["receipts"];
  onOpenTrace?: (traceId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2 text-[9px] text-text-dim">
        <span>
          response cache: <span className="text-text">{receipts.cache.hits}</span> hits ·{" "}
          <span className="text-text">{receipts.cache.misses}</span> misses ·{" "}
          <span className="text-text">{receipts.cache.stores}</span> stores
        </span>
      </div>
      {receipts.recent.length === 0 ? (
        <Empty>
          No memory receipts yet. Receipts are minted on every passthru response that injected
          unified context (<code>/v1/chat/completions</code>, <code>/v1/messages</code>, Ollama,{" "}
          <code>/v1/responses</code>) and ride the <code>x-marina-memory-receipt</code> header plus
          the trace. Bind a key to an entity and send a request to see one.
        </Empty>
      ) : (
        receipts.recent.map((receipt) => (
          <ReceiptRow key={receipt.requestId} receipt={receipt} onOpenTrace={onOpenTrace} />
        ))
      )}
    </div>
  );
}

function ReceiptRow({
  receipt,
  onOpenTrace,
}: {
  receipt: MemoryReceiptView;
  onOpenTrace?: (traceId: string) => void;
}) {
  const pct =
    receipt.budgetBytes > 0 ? Math.round((receipt.usedBytes / receipt.budgetBytes) * 100) : 0;
  return (
    <div
      className="rounded border border-border bg-bg/30 px-2 py-1"
      data-testid={`receipt-${receipt.requestId}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className="border-cyan-400/60 text-cyan-300">{receipt.surface}</Chip>
        <span className="text-text">{receipt.entity}</span>
        {receipt.cacheHit && (
          <Chip
            className="border-emerald-400/60 text-emerald-400"
            title="served from the response cache"
          >
            cache hit
          </Chip>
        )}
        {receipt.truncated && (
          <Chip
            className="border-amber-400/60 text-amber-300"
            title="an item was cut or dropped for budget"
          >
            truncated
          </Chip>
        )}
        <span className="ml-auto text-[9px] text-text-dim">{formatAge(receipt.at)} ago</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <TierBars tiers={receipt.tiers} budgetBytes={receipt.budgetBytes} className="flex-1" />
        <span className="shrink-0 text-[9px] text-text-dim">
          {formatBytes(receipt.usedBytes)} / {formatBytes(receipt.budgetBytes)} ({pct}%)
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[9px] text-text-dim">
        {receipt.tiers.map((tier) => (
          <span key={tier.tier}>
            {tier.tier} ×{tier.count}
          </span>
        ))}
        <button
          type="button"
          className="ml-auto text-primary hover:underline"
          onClick={() => onOpenTrace?.(receipt.requestId)}
          title={receipt.requestId}
        >
          open trace →
        </button>
      </div>
    </div>
  );
}

// ── 6. Hygiene ──────────────────────────────────────────────────────────────

const HYGIENE_WARN_KEYS = new Set(["stale", "competing", "pending"]);

function HygieneSection({ hygiene }: { hygiene: MemoryOverview["hygiene"] }) {
  if (hygiene.length === 0) {
    return (
      <Empty>
        No hygiene lines yet. The hourly hygiene tick writes one{" "}
        <code>[hygiene] stale=N competing=M pending=P duplicates=D overlong=O unsupported=U</code>{" "}
        process note per online account; <code>orient</code> shows the latest.
      </Empty>
    );
  }
  return (
    <div className="space-y-1">
      {hygiene.map((entry) => {
        const stats = parseHygieneLine(entry.line);
        return (
          <div
            key={entry.entityName}
            className="rounded border border-border bg-bg/30 px-2 py-1"
            data-testid={`hygiene-${entry.entityName}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-text">{entry.entityName}</span>
              <span className="ml-auto text-[9px] text-text-dim" title={entry.line}>
                {formatAge(entry.at)} ago
              </span>
            </div>
            <div className="mt-1 grid grid-cols-6 gap-1">
              {HYGIENE_KEYS.map((key) => {
                const value = stats[key];
                const tone = value > 0 && HYGIENE_WARN_KEYS.has(key) ? "warning" : "default";
                return <Metric key={key} label={key} value={value} tone={tone} />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 7. Institutional spaces ─────────────────────────────────────────────────

function SpacesSection({ spaces }: { spaces: MemoryOverview["spaces"]["institutional"] }) {
  if (spaces.length === 0) {
    return (
      <Empty>
        No institutional spaces reported. <code>guide</code> is seeded on first boot and tradition
        pools are created lazily — if this stays empty after boot, check <code>readiness</code>.
      </Empty>
    );
  }
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {spaces.map((space) => (
        <div
          key={space.id}
          className="flex items-center gap-2 rounded border border-border bg-bg/30 px-2 py-1"
          data-testid={`space-${space.id}`}
        >
          <Landmark size={10} className="text-primary" />
          <span className="text-text" title={space.id}>
            {space.name}
          </span>
          <span className="ml-auto text-[9px] text-text-dim">
            <span className="text-text">{space.records}</span> records ·{" "}
            <span className="text-emerald-400">{space.ratified}</span> ratified
          </span>
        </div>
      ))}
    </div>
  );
}
