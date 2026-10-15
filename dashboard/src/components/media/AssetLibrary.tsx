// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Asset Library: every file the viewer may read (uploads, generated media,
 * request images, tool output), from `GET /api/assets?view=library`.
 *
 * Facets (type / origin / owner / tag, counted by `facets=1` over the
 * viewer's visible set), a debounced search (`q`), sort and a look-back
 * window drive the query; pages follow `nextCursor` as the windowed grid
 * nears its end (a short page — rows hidden by the read check — simply asks
 * for the next). Selection supports click, Shift-range, Ctrl/Cmd-toggle and
 * select-all, with bulk tag / untag / add to canvas / download / delete.
 * Asset events invalidate `["assets"]`, so the grid stays live without
 * subscribing to the event feed. Uploads (picker, paste, drop) go through
 * the shared upload queue.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Grid2x2,
  List,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUploads } from "../../hooks/use-uploads";
import {
  ASSET_SORTS,
  ASSET_TYPES,
  type AssetSort,
  type AssetType,
  deleteAsset,
  type LibraryFacets,
  type LibraryFilters,
  type LibraryItem,
  patchAsset,
  useAssetLibrary,
} from "../../lib/asset-library";
import {
  EMPTY_SELECTION,
  pruneSelection,
  type Selection,
  selectAll,
  selectClick,
  toggleOne,
} from "../../lib/asset-selection";
import { resolveAssetUrl } from "../../lib/asset-url";
import { AddToCanvasMenu } from "./AddToCanvasMenu";
import { AssetGrid, type GridView } from "./AssetGrid";
import { useAssetViewer, viewableFromItem } from "./MediaViewer";
import { UploadButton, UploadDropZone, UploadTray } from "./UploadControls";

const SINCE_OPTIONS: [string, string][] = [
  ["", "Any time"],
  ["1d", "Last day"],
  ["7d", "Last week"],
  ["30d", "Last 30 days"],
];
const SORT_LABEL: Record<AssetSort, string> = {
  new: "Newest",
  old: "Oldest",
  size: "Largest",
  name: "Name",
};
const VIEW_PREF = "marina:asset-library-view";

function loadView(): GridView {
  try {
    return localStorage.getItem(VIEW_PREF) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** Debounce a value (search box → query). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AssetLibrary({ active = true }: { active?: boolean }) {
  const [type, setType] = useState<AssetType | undefined>();
  const [owner, setOwner] = useState<string | undefined>();
  const [origin, setOrigin] = useState<string | undefined>();
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState<AssetSort>("new");
  const [since, setSince] = useState("");
  const [qDraft, setQDraft] = useState("");
  const q = useDebounced(qDraft, 300);
  const [view, setViewState] = useState<GridView>(loadView);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState("");
  const viewer = useAssetViewer();
  const qc = useQueryClient();
  const uploads = useUploads();

  const filters = useMemo<LibraryFilters>(
    () => ({
      ...(type ? { type } : {}),
      ...(owner ? { owner } : {}),
      ...(origin ? { origin } : {}),
      ...(tags.length ? { tags } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(sort !== "new" ? { sort } : {}),
      ...(since ? { since } : {}),
    }),
    [type, owner, origin, tags, q, sort, since],
  );

  const query = useAssetLibrary(filters, active);
  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = query;
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const facets = data?.pages[0]?.facets;
  const order = useMemo(() => items.map((i) => i.id), [items]);

  // A new query starts at the top with nothing active.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change only.
  useEffect(() => {
    setActiveIndex(-1);
  }, [filters]);
  useEffect(() => {
    setSelection((s) => pruneSelection(s, order));
  }, [order]);

  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setView = (v: GridView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_PREF, v);
    } catch {
      // allow-empty-catch: preference persistence is best-effort.
    }
  };

  const open = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      viewer.open(viewableFromItem(item), { collection: items.map(viewableFromItem), index });
    },
    [items, viewer],
  );

  const selectedItems = useMemo(
    () => items.filter((i) => selection.selected.has(i.id)),
    [items, selection],
  );
  const clearFilters = () => {
    setType(undefined);
    setOwner(undefined);
    setOrigin(undefined);
    setTags([]);
    setSince("");
    setQDraft("");
  };
  const anyFilter = !!(type || owner || origin || tags.length || since || q.trim());

  return (
    <UploadDropZone onFiles={uploads.upload} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className={`rounded p-1 ${filtersOpen ? "text-primary" : "text-text-dim"} hover:bg-bg-hover`}
          aria-label="Filters"
          aria-pressed={filtersOpen}
          aria-controls="asset-library-filters"
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
        </button>
        <label className="flex min-w-[10rem] flex-1 items-center gap-1 rounded border border-border bg-bg px-1.5 focus-within:border-primary">
          <Search size={12} className="text-text-dim" aria-hidden="true" />
          <input
            type="search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search filename, caption, prompt, tags…"
            aria-label="Search assets"
            className="min-w-0 flex-1 bg-transparent py-1 text-[11px] text-text outline-none"
          />
        </label>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as AssetSort)}
          className="rounded border border-border bg-bg px-1 py-1 text-[11px] text-text"
        >
          {ASSET_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Created"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="rounded border border-border bg-bg px-1 py-1 text-[11px] text-text"
        >
          {SINCE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <fieldset className="flex rounded border border-border">
          <legend className="sr-only">Layout</legend>
          <button
            type="button"
            className={`p-1 ${view === "grid" ? "bg-primary/15 text-primary" : "text-text-dim"}`}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <Grid2x2 size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`p-1 ${view === "list" ? "bg-primary/15 text-primary" : "text-text-dim"}`}
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List size={12} aria-hidden="true" />
          </button>
        </fieldset>
        <button
          type="button"
          className="rounded p-1 text-text-dim hover:bg-bg-hover hover:text-primary"
          aria-label="Refresh"
          onClick={() => void refetch()}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
        <UploadButton onFiles={uploads.upload} />
      </div>

      {selectedItems.length > 0 && (
        <BulkBar
          items={selectedItems}
          visibleCount={items.length}
          onSelectAll={() => setSelection(selectAll(order))}
          onClear={() => setSelection(EMPTY_SELECTION)}
          onStatus={setStatus}
          onChanged={() => void qc.invalidateQueries({ queryKey: ["assets"] })}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {filtersOpen && (
          <FacetSidebar
            facets={facets}
            type={type}
            owner={owner}
            origin={origin}
            tags={tags}
            onType={setType}
            onOwner={setOwner}
            onOrigin={setOrigin}
            onTags={setTags}
            onClear={anyFilter ? clearFilters : undefined}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-1">
          {error && (
            <div
              role="alert"
              className="m-2 rounded border border-danger/50 p-2 text-[11px] text-danger"
            >
              {error.message}{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Retry
              </button>
            </div>
          )}
          {isLoading && (
            <p role="status" className="p-3 text-[11px] text-text-dim">
              Loading assets…
            </p>
          )}
          {!isLoading && !error && items.length === 0 && !hasNextPage && (
            <EmptyState filtered={anyFilter} onClear={clearFilters} onFiles={uploads.upload} />
          )}
          {items.length > 0 && (
            <div className="min-h-0 flex-1">
              <AssetGrid
                items={items}
                view={view}
                selected={selection.selected}
                activeIndex={activeIndex}
                onActiveIndex={setActiveIndex}
                onSelect={(id, mods) => setSelection((s) => selectClick(s, id, order, mods))}
                onToggle={(id) => setSelection((s) => toggleOne(s, id))}
                onSelectAll={() => setSelection(selectAll(order))}
                onExtend={(id) => setSelection((s) => selectClick(s, id, order, { shift: true }))}
                onOpen={open}
                onEndReached={onEndReached}
                label={`Assets${facets ? ` (${facets.total}${facets.truncated ? "+" : ""})` : ""}`}
              />
            </div>
          )}
          {isFetchingNextPage && (
            <p role="status" className="p-1 text-center text-[10px] text-text-dim">
              Loading more…
            </p>
          )}
          <UploadTray
            entries={uploads.entries}
            onCancel={uploads.cancel}
            onDismiss={uploads.dismiss}
            onClearFinished={uploads.clearFinished}
            className="absolute bottom-2 right-2 z-20 w-72 rounded border border-border bg-bg-card p-2 text-[11px] text-text shadow-xl"
          />
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {status && (
        <div className="flex items-center justify-between border-t border-border px-2 py-1 text-[11px] text-text-dim">
          <span>{status}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            className="hover:text-primary"
            onClick={() => setStatus("")}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      )}
    </UploadDropZone>
  );
}

function EmptyState({
  filtered,
  onClear,
  onFiles,
}: {
  filtered: boolean;
  onClear: () => void;
  onFiles: (files: File[]) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-text-dim">
      {filtered ? (
        <>
          <p>No assets match these filters.</p>
          <button type="button" className="text-primary underline" onClick={onClear}>
            Clear filters
          </button>
        </>
      ) : (
        <>
          <p className="text-text">Your library is empty.</p>
          <p>Upload files, paste an image, or drop files here. Generated media lands here too.</p>
          <UploadButton onFiles={onFiles} label="Upload files" />
        </>
      )}
    </div>
  );
}

function FacetGroup({
  title,
  counts,
  value,
  onChange,
  labels,
}: {
  title: string;
  counts: Record<string, number> | undefined;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  labels?: readonly string[];
}) {
  const keys = labels
    ? labels.filter((k) => (counts?.[k] ?? 0) > 0 || k === value)
    : Object.keys(counts ?? {}).sort((a, b) => (counts?.[b] ?? 0) - (counts?.[a] ?? 0));
  if (keys.length === 0) return null;
  return (
    <fieldset className="mb-2">
      <legend className="mb-0.5 text-[10px] uppercase tracking-wider text-text-dim">{title}</legend>
      <ul>
        {keys.slice(0, 12).map((k) => (
          <li key={k}>
            <button
              type="button"
              aria-pressed={value === k}
              onClick={() => onChange(value === k ? undefined : k)}
              className={`flex w-full items-center justify-between rounded px-1.5 py-0.5 text-left text-[11px] ${
                value === k ? "bg-primary/15 text-primary" : "text-text hover:bg-bg-hover"
              }`}
            >
              <span className="truncate">{k}</span>
              <span className="tabular-nums text-text-dim">{counts?.[k] ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function FacetSidebar({
  facets,
  type,
  owner,
  origin,
  tags,
  onType,
  onOwner,
  onOrigin,
  onTags,
  onClear,
}: {
  facets: LibraryFacets | undefined;
  type: AssetType | undefined;
  owner: string | undefined;
  origin: string | undefined;
  tags: string[];
  onType: (t: AssetType | undefined) => void;
  onOwner: (o: string | undefined) => void;
  onOrigin: (o: string | undefined) => void;
  onTags: (t: string[]) => void;
  onClear?: () => void;
}) {
  const tagKeys = Object.keys(facets?.tag ?? {}).sort(
    (a, b) => (facets?.tag[b] ?? 0) - (facets?.tag[a] ?? 0),
  );
  return (
    <nav
      id="asset-library-filters"
      aria-label="Asset filters"
      className="w-44 shrink-0 overflow-auto border-r border-border p-2"
    >
      <div className="mb-2 flex items-center justify-between text-[10px] text-text-dim">
        <span>{facets ? `${facets.total}${facets.truncated ? "+" : ""} visible` : " "}</span>
        {onClear && (
          <button type="button" className="text-primary hover:underline" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <fieldset className="mb-2">
        <legend className="mb-0.5 text-[10px] uppercase tracking-wider text-text-dim">Scope</legend>
        <button
          type="button"
          aria-pressed={owner === "me"}
          onClick={() => onOwner(owner === "me" ? undefined : "me")}
          className={`w-full rounded px-1.5 py-0.5 text-left text-[11px] ${
            owner === "me" ? "bg-primary/15 text-primary" : "text-text hover:bg-bg-hover"
          }`}
        >
          Mine
        </button>
      </fieldset>
      <FacetGroup
        title="Type"
        counts={facets?.type}
        value={type}
        onChange={(v) => onType(v as AssetType | undefined)}
        labels={ASSET_TYPES}
      />
      <FacetGroup title="Origin" counts={facets?.origin} value={origin} onChange={onOrigin} />
      <FacetGroup
        title="Owner"
        counts={facets?.owner}
        value={owner === "me" ? undefined : owner}
        onChange={onOwner}
      />
      {tagKeys.length > 0 && (
        <fieldset className="mb-2">
          <legend className="mb-0.5 text-[10px] uppercase tracking-wider text-text-dim">
            Tags (all must match)
          </legend>
          <ul className="flex flex-wrap gap-1">
            {tagKeys.slice(0, 30).map((t) => {
              const on = tags.includes(t);
              return (
                <li key={t}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onTags(on ? tags.filter((x) => x !== t) : [...tags, t])}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      on ? "bg-primary/20 text-primary" : "bg-bg-hover text-text hover:text-primary"
                    }`}
                  >
                    {t} <span className="text-text-dim">{facets?.tag[t]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </nav>
  );
}

function BulkBar({
  items,
  visibleCount,
  onSelectAll,
  onClear,
  onStatus,
  onChanged,
}: {
  items: readonly LibraryItem[];
  visibleCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onStatus: (message: string) => void;
  onChanged: () => void;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = items.length;
  const noun = n === 1 ? "asset" : "assets";

  const each = async (label: string, run: (item: LibraryItem) => Promise<unknown>) => {
    setBusy(true);
    let failed = 0;
    let firstError = "";
    for (const item of items) {
      try {
        await run(item);
      } catch (err) {
        failed++;
        firstError ||= err instanceof Error ? err.message : String(err);
      }
    }
    setBusy(false);
    onChanged();
    onStatus(
      failed
        ? `${label}: ${n - failed} of ${n} done — ${firstError}`
        : `${label}: ${n} ${noun} done.`,
    );
  };

  const tagList = () =>
    tagDraft
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

  const download = async () => {
    for (const item of items) {
      const url = await resolveAssetUrl(item.url);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    onStatus(`Downloading ${n} ${noun}.`);
  };

  return (
    <div
      role="toolbar"
      aria-label="Selected assets"
      className="flex flex-wrap items-center gap-1.5 border-b border-primary/30 bg-primary/5 px-2 py-1 text-[11px]"
    >
      <span className="font-semibold text-primary">{n} selected</span>
      {n < visibleCount && (
        <button type="button" className="text-text-dim hover:text-primary" onClick={onSelectAll}>
          Select all {visibleCount}
        </button>
      )}
      <button type="button" className="text-text-dim hover:text-primary" onClick={onClear}>
        Clear
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <label className="flex items-center gap-1">
        <Tag size={11} className="text-text-dim" aria-hidden="true" />
        <input
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          placeholder="tags"
          aria-label="Tags for selected assets"
          className="w-24 rounded border border-border bg-bg px-1 py-0.5 text-text outline-none focus:border-primary"
        />
      </label>
      <button
        type="button"
        disabled={busy || tagList().length === 0}
        className="rounded border border-border px-1.5 py-0.5 text-text hover:text-primary disabled:opacity-40"
        onClick={() => {
          const tags = tagList();
          void each("Tag", (i) => patchAsset(i.id, { addTags: tags })).then(() => setTagDraft(""));
        }}
      >
        Tag
      </button>
      <button
        type="button"
        disabled={busy || tagList().length === 0}
        className="rounded border border-border px-1.5 py-0.5 text-text hover:text-primary disabled:opacity-40"
        onClick={() => {
          const tags = tagList();
          void each("Untag", (i) => patchAsset(i.id, { removeTags: tags })).then(() =>
            setTagDraft(""),
          );
        }}
      >
        Untag
      </button>
      <AddToCanvasMenu
        assets={items.map((i) => ({ id: i.id, url: i.url, filename: i.filename, mime: i.mime }))}
        onDone={(message) => onStatus(message)}
      />
      <button
        type="button"
        disabled={busy}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-text-dim hover:bg-bg-hover hover:text-primary"
        onClick={() => void download()}
      >
        <Download size={12} aria-hidden="true" /> Download
      </button>
      {confirming ? (
        <span role="alert" className="flex items-center gap-1 text-danger">
          Delete {n} {noun}? This cannot be undone.
          <button
            type="button"
            disabled={busy}
            className="rounded border border-danger px-1.5 py-0.5"
            onClick={() => {
              setConfirming(false);
              void each("Delete", (i) => deleteAsset(i.id));
            }}
          >
            Delete {n}
          </button>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-text-dim"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-text-dim hover:bg-bg-hover hover:text-danger"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={12} aria-hidden="true" /> Delete
        </button>
      )}
    </div>
  );
}
