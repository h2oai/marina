// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MemoryOperationRequest } from "../../../src/sdk/memory-operations";
import { memoryPortableDigest } from "../../../src/sdk/memory-portable";
import type { MemoryTransferList, MemoryTransferStatus } from "../../../src/sdk/memory-transfer";
import type {
  MemoryQueryResult,
  MemoryRecord,
  MemoryReviewResult,
  MemorySourceRange,
  MemorySpace,
} from "../../../src/sdk/memory-types";
import { useChatState } from "../hooks/use-chat-state";
import { requestResidentMemory } from "../lib/memory-service";

const button =
  "rounded border border-border px-2 py-1 text-text hover:border-primary disabled:opacity-40";
const field =
  "w-full rounded border border-border bg-bg p-2 text-text outline-none focus:border-primary";
type Tab = "Memories" | "Sources" | "Review" | "Transfers";

export function MemoryWorkspace({ open, onClose }: { open: boolean; onClose: () => void }) {
  const identity = useChatState((s) => s.entityName);
  const loggedIn = useChatState((s) => s.loggedIn);
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 1, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          aria-label="Memory workspace"
          className="fixed inset-x-2 bottom-2 top-12 z-[100] flex flex-col overflow-hidden rounded-lg border border-border bg-bg-card shadow-2xl md:left-auto md:w-[min(900px,95vw)]"
        >
          <div className="flex items-center gap-3 border-b border-border p-3">
            <h2 className="font-semibold text-text-bright">Memory</h2>
            <span className="text-text-dim">{loggedIn ? identity : "Sign in to world chat"}</span>
            <button type="button" className={`${button} ml-auto`} onClick={onClose}>
              Close memory
            </button>
          </div>
          {loggedIn && identity ? (
            <Workspace key={identity} />
          ) : (
            <p className="p-5 text-text-dim">
              Sign in to world chat to search and review your durable memory.
            </p>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Workspace() {
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [space, setSpace] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void requestResidentMemory<{ spaces: MemorySpace[] }>(
      { operation: "spaces" },
      controller.signal,
    )
      .then((result) => setSpaces(result.spaces))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <>
      <label className="flex items-center gap-2 border-b border-border p-3 text-sm">
        Space
        <select className={field} value={space} onChange={(e) => setSpace(e.target.value)}>
          <option value="">My resident memory</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <MemoryContents key={space} space={space || undefined} />
    </>
  );
}
function MemoryContents({ space }: { space?: string }) {
  const [tab, setTab] = useState<Tab>("Memories");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const [headVersion, setHeadVersion] = useState(0);
  const [previous, setPrevious] = useState<MemoryRecord | null>(null);
  const [sources, setSources] = useState<
    { id: string; seq?: number; text?: string; excerpt?: string }[]
  >([]);
  const [source, setSource] = useState<MemorySourceRange | null>(null);
  const [transfers, setTransfers] = useState<MemoryTransferList | null>(null);
  const [transfer, setTransfer] = useState<MemoryTransferStatus | null>(null);
  const [expired, setExpired] = useState(false);
  const [reviewItems, setReviewItems] = useState<MemoryReviewResult["items"]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [pins, setPins] = useState<Record<string, number> | null>(null);
  const [premises, setPremises] = useState<MemoryRecord[]>([]);
  const controller = useRef(new AbortController());
  const request = <T,>(input: MemoryOperationRequest) =>
    requestResidentMemory<T>({ ...input, space_id: space }, controller.current.signal);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (!controller.current.signal.aborted)
        setError(e instanceof Error ? e.message : "Memory request failed");
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  const inspect = async (id: string, version?: number) => {
    const record = await request<MemoryRecord>({
      operation: "get",
      id,
      input: version ? { version } : undefined,
    });
    setSelected(record);
    setPrevious(null);
    setReviewed(false);
    setPins(null);
    setPremises([]);
    if (version === undefined) setHeadVersion(record.version);
    if (record.version > 1)
      setPrevious(
        await request<MemoryRecord>({
          operation: "get",
          id,
          input: { version: record.version - 1 },
        }),
      );
  };
  const load = async (cursor?: string) => {
    setSelected(null);
    setSource(null);
    setTransfer(null);
    if (tab === "Transfers") {
      setTransfers(
        await request<MemoryTransferList>({
          operation: "transfers",
          input: { limit: 20, ...(expired ? { expired: true } : {}), cursor },
        }),
      );
      return;
    }
    if (tab === "Sources") {
      if (query.trim()) {
        const r = await request<{ results: typeof sources }>({
          operation: "source_search",
          input: { query, limit: 20 },
        });
        setSources(r.results);
        setNext(null);
      } else {
        const r = await request<{ sources: typeof sources; next_cursor: number | null }>({
          operation: "source_headers",
          input: { limit: 20, after: cursor ? Number(cursor) : 0 },
        });
        setSources(r.sources);
        setNext(r.next_cursor === null ? null : String(r.next_cursor));
      }
      return;
    }
    if (tab === "Review") {
      const r = await request<MemoryReviewResult>({
        operation: "review",
        input: { limit: 20, cursor },
      });
      setReviewItems(r.items);
      setRecords(r.items.map((item) => item.record));
      setNext(r.next_cursor);
      return;
    }
    if (query.trim()) {
      const r = await request<{ results: MemoryRecord[] }>({
        operation: "search",
        input: { query, limit: 20 },
      });
      setRecords(r.results);
      setNext(null);
    } else {
      const r = await request<MemoryQueryResult>({
        operation: "query",
        input: { limit: 20, cursor, include_stale: true },
      });
      setRecords(r.results);
      setNext(r.next_cursor);
    }
  };
  const readSource = async (id: string, start = 0, text_hash?: string) =>
    setSource(
      await request<MemorySourceRange>({
        operation: "source_range",
        id,
        input: { start, text_hash },
      }),
    );
  const reviewPremises = async () => {
    if (!selected) return;
    const rows = [];
    for (const id of selected.depends_on)
      rows.push(await request<MemoryRecord>({ operation: "get", id }));
    setPremises(rows);
    setPins(Object.fromEntries(rows.map((r) => [r.id, r.version])));
    setReviewed(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <nav aria-label="Memory views" className="flex gap-2 border-b border-border p-3">
        {(["Memories", "Sources", "Review", "Transfers"] as Tab[]).map((name) => (
          <button
            type="button"
            key={name}
            className={`${button} ${tab === name ? "bg-primary/15 text-primary" : ""}`}
            aria-pressed={tab === name}
            disabled={busy}
            onClick={() => {
              setTab(name);
              setRecords([]);
              setSources([]);
              setTransfers(null);
              setSelected(null);
              setSource(null);
              setTransfer(null);
              setNext(null);
              setError("");
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      <form
        className="flex gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => load());
        }}
      >
        {tab === "Transfers" ? (
          <label className="flex flex-1 items-center gap-2">
            <input
              type="checkbox"
              checked={expired}
              onChange={(e) => setExpired(e.target.checked)}
            />
            Expired only
          </label>
        ) : tab === "Review" ? (
          <p className="flex-1 text-text-dim">Stale and competing assertions need your review.</p>
        ) : (
          <input
            className={field}
            aria-label="Search memory"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "Sources"
                ? "Search original source text"
                : "Search memories; leave empty to browse"
            }
          />
        )}
        <button className={button} type="submit" disabled={busy}>
          {busy ? "Loading…" : "Load"}
        </button>
      </form>
      {error && (
        <p role="alert" className="px-3 pb-3 text-danger">
          {error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 overflow-auto md:grid-cols-[minmax(180px,1fr)_2fr]">
        <div className="space-y-2 border-r border-border p-3">
          {records.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`${button} block w-full text-left`}
              disabled={busy}
              onClick={() => void run(() => inspect(r.id))}
            >
              <span className="block line-clamp-3 whitespace-pre-wrap">{r.content}</span>
              <small className="text-text-dim">
                v{r.version} · {r.freshness} · {r.type}
              </small>
            </button>
          ))}
          {sources.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`${button} block w-full break-all text-left`}
              disabled={busy}
              onClick={() => void run(() => readSource(s.id))}
            >
              {s.excerpt ?? s.text ?? s.id}
            </button>
          ))}
          {transfers?.transfers.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`${button} block w-full break-all text-left`}
              disabled={busy}
              onClick={() => setTransfer(t)}
            >
              {t.id}
              <small className="block">
                {t.state}
                {t.expired ? " · expired" : ""} · {t.bytes.toLocaleString()} bytes
              </small>
            </button>
          ))}
          {(next || transfers?.next_cursor) && (
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => void run(() => load(next ?? transfers?.next_cursor ?? undefined))}
            >
              Next page
            </button>
          )}
          {!records.length && !sources.length && !transfers?.transfers.length && (
            <p className="text-text-dim">Load this view to browse available entries.</p>
          )}
        </div>
        <div className="space-y-4 overflow-auto p-4">
          {selected && (
            <>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">
                  Revision {selected.version} of {headVersion}
                </h3>
                <button
                  className={button}
                  type="button"
                  disabled={busy || selected.version <= 1}
                  onClick={() => void run(() => inspect(selected.id, selected.version - 1))}
                >
                  Previous
                </button>
                <button
                  className={button}
                  type="button"
                  disabled={busy || selected.version >= headVersion}
                  onClick={() => void run(() => inspect(selected.id, selected.version + 1))}
                >
                  Next
                </button>
              </div>
              <p className="break-all text-xs text-text-dim">
                {selected.id} · {selected.freshness} · {selected.type}
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans">{selected.content}</pre>
              {previous && (
                <details>
                  <summary>Compare with revision {previous.version}</summary>
                  <div className="grid gap-3 pt-3 sm:grid-cols-2">
                    <pre className="whitespace-pre-wrap break-words rounded border border-border p-2">
                      {previous.content}
                    </pre>
                    <pre className="whitespace-pre-wrap break-words rounded border border-primary/40 p-2">
                      {selected.content}
                    </pre>
                  </div>
                </details>
              )}
              {selected.claim && (
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(selected.claim, null, 2)}
                </pre>
              )}
              <h4>Original sources</h4>
              {selected.source_ids.length ? (
                selected.source_ids.map((id) => (
                  <button
                    key={id}
                    className={`${button} block break-all`}
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => readSource(id))}
                  >
                    {id}
                  </button>
                ))
              ) : (
                <p className="text-text-dim">No original source declared.</p>
              )}
              {reviewItems
                .find((item) => item.record.id === selected.id)
                ?.competing_records.map((peer) => (
                  <div key={peer.id} className="rounded border border-warning/50 p-2">
                    <p className="font-semibold">Competing assertion · v{peer.version}</p>
                    <p className="whitespace-pre-wrap">{peer.content}</p>
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => void run(() => inspect(peer.id))}
                    >
                      Inspect competing assertion
                    </button>
                  </div>
                ))}
              {reviewItems.find((item) => item.record.id === selected.id)?.competing_truncated && (
                <p>
                  Additional competing assertions exist; query this subject and predicate to review
                  them.
                </p>
              )}
              <details>
                <summary>Provenance and metadata</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(
                    {
                      depends_on: selected.depends_on,
                      dependency_versions: selected.dependency_versions,
                      valid_time: selected.valid_time,
                      stale_reason: selected.stale_reason,
                      metadata: selected.metadata,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {selected.freshness === "stale" && selected.version === headVersion && (
                <div className="space-y-2 rounded border border-warning/50 p-3">
                  <p>Reaffirm only after reviewing the current premises and this conclusion.</p>
                  <button
                    className={button}
                    type="button"
                    disabled={busy}
                    onClick={() => void run(reviewPremises)}
                  >
                    Read current premises
                  </button>
                  {premises.map((p) => (
                    <div key={p.id} className="rounded border border-border p-2">
                      <p className="text-xs">
                        {p.id} · v{p.version} · {p.freshness}
                      </p>
                      <p className="whitespace-pre-wrap">{p.content}</p>
                    </div>
                  ))}
                  {pins && (
                    <>
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={reviewed}
                          onChange={(e) => setReviewed(e.target.checked)}
                        />
                        I reviewed these premises and still endorse the conclusion.
                      </label>
                      <button
                        type="button"
                        className={button}
                        disabled={
                          busy || !reviewed || premises.some((p) => p.freshness === "stale")
                        }
                        onClick={() =>
                          void run(async () => {
                            await request({
                              operation: "reaffirm",
                              id: selected.id,
                              key: `review:${await memoryPortableDigest({ id: selected.id, version: selected.version, pins })}`,
                              input: {
                                expected_version: selected.version,
                                dependency_versions: pins,
                              },
                            });
                            await inspect(selected.id);
                          })
                        }
                      >
                        Reaffirm reviewed conclusion
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {source && (
            <section className="space-y-2 rounded border border-border p-3">
              <h3 className="font-semibold">
                Original source · bytes {source.start}–{source.end}
              </h3>
              <p className="break-all text-xs text-text-dim">
                {source.id} · SHA-256 {source.text_hash}
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans">{source.text}</pre>
              {source.next_start !== null && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(() => readSource(source.id, source.next_start!, source.text_hash))
                  }
                >
                  Read next range
                </button>
              )}
            </section>
          )}
          {transfer && (
            <section className="space-y-3">
              <h3 className="break-all font-semibold">Transfer {transfer.id}</h3>
              <p>
                {transfer.state} · {transfer.bytes.toLocaleString()} bytes staged
              </p>
              <p>Write expiry: {new Date(transfer.expires_at).toLocaleString()}</p>
              <pre className="whitespace-pre-wrap text-xs">
                {JSON.stringify(transfer.header, null, 2)}
              </pre>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setTransfer(await request({ operation: "transfer_status", id: transfer.id })),
                  )
                }
              >
                Refresh status
              </button>
              {!["committed", "aborted"].includes(transfer.state) && (
                <button
                  type="button"
                  className={`${button} text-danger`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Discard unpublished staging for this transfer?"))
                      void run(async () => {
                        await request({
                          operation: "transfer_abort",
                          id: transfer.id,
                          key: `${transfer.id}:abort`,
                        });
                        setTransfer(
                          await request({ operation: "transfer_status", id: transfer.id }),
                        );
                      });
                  }}
                >
                  Abort unpublished transfer
                </button>
              )}
              <p className="text-text-dim">
                Resume uploads with the TypeScript client or the transfer-resume CLI using the
                original source credentials.
              </p>
            </section>
          )}
          {!selected && !source && !transfer && (
            <p className="text-text-dim">
              Select an entry to inspect its sources, history, or status. Assertions remain authored
              claims; review does not establish independent truth.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
