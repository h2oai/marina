// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ChevronDown, ChevronRight, Quote } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorldState } from "../../hooks/use-world-state";
import { describeApiError, fetchApi, postApi } from "../../lib/api";
import type {
  MemoryJobEvent,
  MemoryJobMarker,
  MemoryJobRole,
  MemoryJobsResponse,
  MemoryJobView,
} from "../../lib/memory-observability-types";
import type { DashboardEvent } from "../../lib/types";
import {
  formatAge,
  formatCountdown,
  JOB_MARKER_CLASS,
  JOB_MARKER_LABEL,
  JOB_STATE_CLASS,
} from "./format";

const PAGE_SIZE = 50;
const ROLES: MemoryJobRole[] = ["librarian", "reflector", "evaluator"];
const MARKERS: MemoryJobMarker[] = ["hygiene", "accumulation", "shared-write-review"];

type StateFilter = "open" | "all";
type RoleFilter = "all" | MemoryJobRole;
type MarkerFilter = "all" | MemoryJobMarker;

export const JOBS_EMPTY_COMMANDS = {
  assist: "memory assist evaluator <helper> <question>",
  spawn: "agent spawn <name> role memory-evaluator",
} as const;

function jobsQuery(state: StateFilter, role: RoleFilter, cursor?: string | null): string {
  const params = new URLSearchParams({ state, limit: String(PAGE_SIZE) });
  if (role !== "all") params.set("role", role);
  if (cursor) params.set("cursor", cursor);
  return `/api/memory/jobs?${params.toString()}`;
}

function isMemoryJobEvent(event: DashboardEvent): event is DashboardEvent & MemoryJobEvent {
  const job = (event as Partial<MemoryJobEvent>).job;
  return event.type === "memory_job" && !!job && typeof job.id === "string";
}

/** Replace a job by id, or prepend it when it is new and passes the filters. */
function patchJobs(
  jobs: MemoryJobView[],
  incoming: MemoryJobView,
  accept: (job: MemoryJobView) => boolean,
): MemoryJobView[] {
  const index = jobs.findIndex((job) => job.id === incoming.id);
  if (index >= 0) {
    const next = jobs.slice();
    // Keep task/answer already scoped to this session when the event omits them.
    next[index] = { ...jobs[index], ...incoming };
    return next;
  }
  return accept(incoming) ? [incoming, ...jobs] : jobs;
}

/** Re-renders every `intervalMs` so ages and deadline countdowns stay honest. */
function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function JobsSection({ focusJobId }: { focusJobId?: string } = {}) {
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [markerFilter, setMarkerFilter] = useState<MarkerFilter>("all");
  const [jobs, setJobs] = useState<MemoryJobView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, MemoryJobView>>({});
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const requestSeq = useRef(0);
  const now = useNow();

  const accepts = useCallback(
    (job: MemoryJobView) =>
      (stateFilter === "all" || job.workOpen) && (roleFilter === "all" || job.role === roleFilter),
    [stateFilter, roleFilter],
  );

  const load = useCallback(
    async (cursor?: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(undefined);
      try {
        const page = await fetchApi<MemoryJobsResponse>(jobsQuery(stateFilter, roleFilter, cursor));
        if (seq !== requestSeq.current) return;
        setJobs((current) => {
          if (!cursor) return page.jobs;
          const seen = new Set(current.map((job) => job.id));
          return [...current, ...page.jobs.filter((job) => !seen.has(job.id))];
        });
        setNextCursor(page.nextCursor ?? null);
        setLoaded(true);
      } catch (cause) {
        if (seq !== requestSeq.current) return;
        setError(describeApiError(cause));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [stateFilter, roleFilter],
  );

  // Bootstrap + refetch when server-side filters change.
  useEffect(() => {
    setJobs([]);
    setNextCursor(null);
    setLoaded(false);
    void load();
  }, [load]);

  // Live: patch jobs in place from `memory_job` WebSocket events. Mirrors the
  // newest-slice scan in `useInvalidateOnEvent` so old feed entries are never
  // re-applied on unrelated renders.
  const feed = useWorldState((s) => s.eventFeed);
  const lastSeenRef = useRef<number>(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (feed.length === 0) return;
    const fresh: MemoryJobView[] = [];
    for (const event of feed) {
      if (event.timestamp <= lastSeenRef.current) break;
      if (isMemoryJobEvent(event)) fresh.push(event.job);
    }
    lastSeenRef.current = feed[0]!.timestamp;
    if (fresh.length === 0) return;
    // Feed is newest-first; apply oldest-first so the latest state wins.
    setJobs((current) => fresh.reduceRight((acc, job) => patchJobs(acc, job, accepts), current));
  }, [feed, accepts]);

  // Deep link (canvas inspector → Admin → Memory): fetch the job by id so a
  // closed or paged-out job still appears, widen the filter, and expand it.
  // The pinned row is merged at render time so the filter-change reload
  // (which replaces `jobs`) cannot drop it.
  const [pinned, setPinned] = useState<MemoryJobView>();
  useEffect(() => {
    if (!focusJobId) return;
    let cancelled = false;
    setStateFilter("all");
    fetchApi<MemoryJobView>(`/api/memory/jobs/${encodeURIComponent(focusJobId)}`)
      .then((full) => {
        if (cancelled) return;
        setDetails((current) => ({ ...current, [full.id]: full }));
        setPinned(full);
        setExpanded((current) => ({ ...current, [full.id]: true }));
      })
      .catch((cause) => {
        if (!cancelled) setError(describeApiError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [focusJobId]);

  const toggle = useCallback(
    (job: MemoryJobView) => {
      setExpanded((current) => ({ ...current, [job.id]: !current[job.id] }));
      if (job.task === undefined && job.answer === undefined && !details[job.id]) {
        fetchApi<MemoryJobView>(`/api/memory/jobs/${encodeURIComponent(job.id)}`)
          .then((full) => setDetails((current) => ({ ...current, [job.id]: full })))
          .catch(() => {
            /* detail is optional — the row already shows the scoped summary */
          });
      }
    },
    [details],
  );

  const cancel = useCallback(async (job: MemoryJobView) => {
    setCancelling((current) => ({ ...current, [job.id]: true }));
    setError(undefined);
    // Optimistic: flip to cancelled immediately, reconcile with the server row.
    setJobs((current) =>
      current.map((row) =>
        row.id === job.id ? { ...row, state: "cancelled", workOpen: false } : row,
      ),
    );
    try {
      const updated = await postApi<MemoryJobView>(
        `/api/memory/jobs/${encodeURIComponent(job.id)}/cancel`,
      );
      setJobs((current) =>
        current.map((row) => (row.id === job.id ? { ...row, ...updated } : row)),
      );
    } catch (cause) {
      setJobs((current) => current.map((row) => (row.id === job.id ? job : row)));
      setError(describeApiError(cause));
    } finally {
      setCancelling((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  }, []);

  const listed = pinned && !jobs.some((job) => job.id === pinned.id) ? [pinned, ...jobs] : jobs;
  const visible = listed.filter(
    (job) => job.id === pinned?.id || markerFilter === "all" || job.marker === markerFilter,
  );

  return (
    <div className="space-y-2">
      <div role="toolbar" className="flex flex-wrap items-center gap-1" aria-label="Job filters">
        <FilterChips
          label="state"
          value={stateFilter}
          options={["open", "all"]}
          onChange={(value) => setStateFilter(value as StateFilter)}
        />
        <span className="mx-1 text-text-dim">·</span>
        <FilterChips
          label="role"
          value={roleFilter}
          options={["all", ...ROLES]}
          onChange={(value) => setRoleFilter(value as RoleFilter)}
        />
        <span className="mx-1 text-text-dim">·</span>
        <FilterChips
          label="marker"
          value={markerFilter}
          options={["all", ...MARKERS]}
          render={(value) => (value === "all" ? "all" : JOB_MARKER_LABEL[value as MemoryJobMarker])}
          onChange={(value) => setMarkerFilter(value as MarkerFilter)}
        />
        <button
          type="button"
          className="ml-auto text-primary hover:underline"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/30 p-2 text-red-300">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loaded && !error && visible.length === 0 && (
        <div className="space-y-1 rounded border border-border p-2 text-text-dim">
          <div>
            No assistance jobs {stateFilter === "open" ? "open" : "recorded"}
            {markerFilter !== "all" ? ` with marker ${JOB_MARKER_LABEL[markerFilter]}` : ""}.
          </div>
          <div>
            File one from the world: <code className="text-text">{JOBS_EMPTY_COMMANDS.assist}</code>{" "}
            (roles: librarian · reflector · evaluator).
          </div>
          <div>
            No helper running? Spawn one first:{" "}
            <code className="text-text">{JOBS_EMPTY_COMMANDS.spawn}</code> (or{" "}
            <code>memory-librarian</code> / <code>memory-reflector</code>).
          </div>
          <div>
            Automatic jobs arrive from the hourly hygiene tick, note accumulation, and shared-write
            review — every one is listed here and cancellable.
          </div>
        </div>
      )}

      <section className="space-y-1" aria-label="Assistance jobs">
        <AnimatePresence initial={false}>
          {visible.map((job) => (
            <motion.div
              key={job.id}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <JobRow
                job={job}
                detail={details[job.id]}
                now={now}
                expanded={!!expanded[job.id]}
                cancelling={!!cancelling[job.id]}
                onToggle={() => toggle(job)}
                onCancel={() => void cancel(job)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </section>

      <div className="flex items-center gap-2 text-text-dim">
        {loading && <span>Loading jobs…</span>}
        {!loading && nextCursor && (
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-text hover:border-primary hover:text-primary"
            onClick={() => void load(nextCursor)}
          >
            Load more
          </button>
        )}
        {loaded && visible.length > 0 && (
          <span className="ml-auto">
            {visible.length} shown{listed.length !== visible.length ? ` of ${listed.length}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterChips({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  render?: (value: string) => string;
}) {
  return (
    <fieldset
      className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0"
      aria-label={`Filter ${label}`}
    >
      <span className="mr-0.5 text-[9px] uppercase text-text-dim">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
            value === option
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-text-dim hover:text-text"
          }`}
        >
          {render ? render(option) : option}
        </button>
      ))}
    </fieldset>
  );
}

function JobRow({
  job,
  detail,
  now,
  expanded,
  cancelling,
  onToggle,
  onCancel,
}: {
  job: MemoryJobView;
  detail?: MemoryJobView;
  now: number;
  expanded: boolean;
  cancelling: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const task = job.task ?? detail?.task;
  const answer = job.answer ?? detail?.answer;
  const space = job.spaceName ?? job.spaceId;
  const overdue = job.workOpen && job.deadline < now;
  return (
    <div
      data-testid={`job-${job.id}`}
      data-state={job.state}
      className={`rounded border border-border bg-bg/30 px-2 py-1 transition-opacity ${
        job.workOpen ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-text-dim hover:text-text"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} job ${job.id}`}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        <span
          className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${JOB_STATE_CLASS[job.state]}`}
          data-testid={`job-state-${job.id}`}
        >
          {job.state}
        </span>
        <span className="text-text">{job.role}</span>
        {job.marker && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[9px] ${JOB_MARKER_CLASS[job.marker]}`}
          >
            {JOB_MARKER_LABEL[job.marker]}
          </span>
        )}
        <span className="text-text-dim">
          <span className="text-text">{job.workerName}</span> → {job.requesterName}
        </span>
        <span className="truncate text-text-dim" title={job.spaceId}>
          {space}
        </span>
        {job.depth > 0 && (
          <span className="text-text-dim" title={`root ${job.rootId}`}>
            depth {job.depth}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[9px] text-text-dim">
        <span title={new Date(job.createdAt).toLocaleString()}>
          {formatAge(job.createdAt, now)} ago
        </span>
        <span>{job.remainingOperations} ops left</span>
        {job.workOpen && (
          <span className={overdue ? "text-amber-300" : ""}>
            {formatCountdown(job.deadline, now)}
          </span>
        )}
        {typeof job.citations === "number" && (
          <span className="inline-flex items-center gap-0.5" title="citations">
            <Quote size={9} /> {job.citations}
          </span>
        )}
        {job.adopted && (
          <span
            className="rounded border border-emerald-400/60 px-1 text-emerald-400"
            title={`record ${job.adopted.recordId} in ${job.adopted.spaceId}`}
          >
            adopted
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span className="font-mono text-text-dim/70" title={job.id}>
            {job.id.length > 12 ? `${job.id.slice(0, 12)}…` : job.id}
          </span>
          {job.workOpen && (
            <button
              type="button"
              disabled={cancelling}
              onClick={onCancel}
              className="rounded border border-border px-1.5 py-0.5 text-text hover:border-danger hover:text-danger disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <div className="mt-1 space-y-1 border-t border-border/60 pt-1 text-[10px]">
          {task !== undefined && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-text-dim">task</div>
              <div className="whitespace-pre-wrap text-text">{task}</div>
            </div>
          )}
          {answer !== undefined && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-text-dim">answer</div>
              <div className="whitespace-pre-wrap text-text">{answer}</div>
            </div>
          )}
          {task === undefined && answer === undefined && (
            <div className="text-text-dim">
              Task and answer are not visible to this session (scoped to the requester, worker, and
              space members).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
