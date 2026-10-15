// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The viewer's info side panel: facts, provenance, lineage and canvases from
 * `GET /api/assets/:id` (read under the viewer's own credential), with
 * caption / alt / tag editing for the owner (`PATCH /api/assets/:id`; the
 * server decides — an operator may edit too, anyone else gets its refusal).
 */

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { openCanvas } from "../../hooks/use-workspace-state";
import {
  assetDetailKey,
  formatBytes,
  formatDuration,
  type LibraryDetail,
  patchAsset,
  useAssetDetail,
} from "../../lib/asset-library";

const DERIVATIVE_KINDS = new Set(["thumbnail-256", "thumbnail-1024", "poster", "preview"]);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-0.5">
      <dt className="text-text-dim">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

export function AssetInfoPanel({
  assetId,
  canEdit,
  onOpenAsset,
  onClose,
}: {
  assetId: string;
  canEdit: (detail: LibraryDetail) => boolean;
  onOpenAsset: (id: string) => void;
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch } = useAssetDetail(assetId);
  return (
    <aside
      aria-label="Asset details"
      className="flex w-[min(320px,85vw)] shrink-0 flex-col overflow-hidden border-l border-border bg-bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-primary">Details</h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-dim hover:text-primary"
          aria-label="Hide details"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 text-[11px]">
        {isLoading && <p className="text-text-dim">Loading details…</p>}
        {error && (
          <div role="alert" className="text-danger">
            {error.message}{" "}
            <button type="button" className="underline" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        )}
        {data && <DetailBody detail={data} editable={canEdit(data)} onOpenAsset={onOpenAsset} />}
      </div>
    </aside>
  );
}

function DetailBody({
  detail,
  editable,
  onOpenAsset,
}: {
  detail: LibraryDetail;
  editable: boolean;
  onOpenAsset: (id: string) => void;
}) {
  const dims =
    detail.width && detail.height ? `${detail.width} × ${detail.height}` : (null as string | null);
  const p = detail.provenance;
  // Thumbnails, posters and previews are the asset's own derivatives, not lineage.
  const children = detail.children.filter((l) => !DERIVATIVE_KINDS.has(l.kind));
  return (
    <div className="space-y-3">
      <dl>
        <Row label="File">{detail.filename}</Row>
        <Row label="Type">
          {detail.type} <span className="text-text-dim">({detail.mime})</span>
        </Row>
        {dims && <Row label="Dimensions">{dims}</Row>}
        {detail.durationMs != null && (
          <Row label="Duration">{formatDuration(detail.durationMs)}</Row>
        )}
        {detail.pages != null && <Row label="Pages">{detail.pages}</Row>}
        <Row label="Size">{formatBytes(detail.size)}</Row>
        <Row label="Owner">{detail.owner}</Row>
        <Row label="Origin">{detail.origin}</Row>
        <Row label="Created">{new Date(detail.createdAt).toLocaleString()}</Row>
        {detail.derivativeState && detail.derivativeState !== "done" && (
          <Row label="Previews">
            {detail.derivativeState}
            {detail.derivativeNote && (
              <span className="block text-text-dim">{detail.derivativeNote}</span>
            )}
          </Row>
        )}
      </dl>

      <TagEditor detail={detail} editable={editable} />
      <TextField detail={detail} field="caption" label="Caption" editable={editable} />
      <TextField detail={detail} field="alt" label="Alt text" editable={editable} />

      {p && (p.prompt || p.model || p.provider || p.costUsd != null || p.source) && (
        <section aria-label="Provenance">
          <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">Provenance</h4>
          <dl>
            {p.prompt && <Row label="Prompt">{p.prompt}</Row>}
            {p.model && <Row label="Model">{p.model}</Row>}
            {p.provider && <Row label="Provider">{p.provider}</Row>}
            {p.costUsd != null && <Row label="Cost">${p.costUsd.toFixed(4)}</Row>}
            {p.source && <Row label="Source">{p.source}</Row>}
            {p.jobId && <Row label="Job">{p.jobId}</Row>}
          </dl>
        </section>
      )}

      {(detail.parents.length > 0 || children.length > 0) && (
        <section aria-label="Lineage">
          <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">Lineage</h4>
          <ul className="space-y-0.5">
            {detail.parents.map((l) => (
              <li key={`p-${l.id}`}>
                <span className="text-text-dim">from ({l.kind}) </span>
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => onOpenAsset(l.id)}
                >
                  {l.filename}
                </button>
              </li>
            ))}
            {children.map((l) => (
              <li key={`c-${l.id}`}>
                <span className="text-text-dim">to ({l.kind}) </span>
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => onOpenAsset(l.id)}
                >
                  {l.filename}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.usedIn.length > 0 && (
        <section aria-label="Used in">
          <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">Used in</h4>
          <ul className="space-y-0.5">
            {detail.usedIn.map((c) => (
              <li key={c.canvasId}>
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => openCanvas(c.canvasId)}
                >
                  {c.name}
                </button>
                <span className="text-text-dim">
                  {" "}
                  · {c.nodes} node{c.nodes === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function useSaveDetail(id: string) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (patch: Parameters<typeof patchAsset>[1]) => {
    setSaving(true);
    setError(null);
    try {
      const next = await patchAsset(id, patch);
      qc.setQueryData(assetDetailKey(id), next);
      void qc.invalidateQueries({ queryKey: ["assets", "library"] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { save, error, saving };
}

function TagEditor({ detail, editable }: { detail: LibraryDetail; editable: boolean }) {
  const { save, error, saving } = useSaveDetail(detail.id);
  const [draft, setDraft] = useState("");
  return (
    <section aria-label="Tags">
      <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">Tags</h4>
      <ul className="flex flex-wrap gap-1">
        {detail.tags.length === 0 && <li className="text-text-dim">No tags</li>}
        {detail.tags.map((tag) => (
          <li
            key={tag}
            className="flex items-center gap-0.5 rounded bg-bg-hover px-1.5 py-0.5 text-text"
          >
            {tag}
            {editable && (
              <button
                type="button"
                className="text-text-dim hover:text-danger"
                aria-label={`Remove tag ${tag}`}
                disabled={saving}
                onClick={() => void save({ removeTags: [tag] })}
              >
                <X size={10} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="mt-1 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const tags = draft
              .split(/[,\s]+/)
              .map((t) => t.trim())
              .filter(Boolean);
            if (tags.length === 0) return;
            void save({ addTags: tags }).then((ok) => ok && setDraft(""));
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="add tags…"
            aria-label="Add tags"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-0.5 text-text outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={saving || !draft.trim()}
            className="rounded border border-border px-1.5 text-text-dim hover:text-primary disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function TextField({
  detail,
  field,
  label,
  editable,
}: {
  detail: LibraryDetail;
  field: "caption" | "alt";
  label: string;
  editable: boolean;
}) {
  const { save, error, saving } = useSaveDetail(detail.id);
  const value = detail[field] ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const id = `asset-${field}-${detail.id}`;
  return (
    <section>
      {editable ? (
        <>
          <label
            htmlFor={id}
            className="mb-1 block text-[10px] uppercase tracking-wider text-text-dim"
          >
            {label}
          </label>
          <textarea
            id={id}
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full resize-y rounded border border-border bg-bg px-1.5 py-1 text-text outline-none focus:border-primary"
          />
          {draft !== value && (
            <div className="mt-1 flex gap-1">
              <button
                type="button"
                disabled={saving}
                onClick={() => void save({ [field]: draft.trim() ? draft : null })}
                className="rounded border border-primary/50 px-1.5 text-primary disabled:opacity-40"
              >
                Save {label.toLowerCase()}
              </button>
              <button
                type="button"
                onClick={() => setDraft(value)}
                className="rounded border border-border px-1.5 text-text-dim"
              >
                Cancel
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">{label}</h4>
          <p className={value ? "text-text" : "text-text-dim"}>{value || "—"}</p>
        </>
      )}
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
