// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upload queue shared by every upload surface (Library, chat attach, canvas
 * drop): per-file progress, per-file errors, cancel, and the server's
 * `deduplicated` answer surfaced as "already in your library". Files over the
 * server's `maxUploadBytes` (from `/api/ui-config`) fail before any bytes are
 * sent; without that number a 413 is reported the same way.
 */

import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiOrigin } from "../lib/api-origin";
import {
  formatMb,
  UploadError,
  type UploadedAsset,
  uploadAsset,
  uploadTracksProgress,
} from "../lib/upload";

export type UploadStatus = "queued" | "uploading" | "done" | "duplicate" | "error" | "cancelled";

export interface UploadEntry {
  id: string;
  name: string;
  size: number;
  mime: string;
  progress: number;
  /** True while uploading on a transport that reports no byte progress. */
  indeterminate?: boolean;
  status: UploadStatus;
  error?: string;
  asset?: UploadedAsset;
}

export interface UseUploadsOptions {
  /** Called once per finished upload (new or deduplicated). */
  onUploaded?: (asset: UploadedAsset, file: File) => void | Promise<void>;
  /** Parallel uploads (default 3). */
  concurrency?: number;
  /** Override the server cap (tests). */
  maxBytes?: number;
  /** The page location (tests); defaults to `window.location`. */
  location?: Pick<Location, "protocol" | "origin">;
}

interface UiConfig {
  maxUploadBytes?: number;
}

let uiConfig: Promise<UiConfig> | undefined;

/** Server UI capabilities (open endpoint, fetched once): the upload cap, when published. */
export function loadUiConfig(): Promise<UiConfig> {
  uiConfig ??= fetch(`${apiOrigin()}/api/ui-config`)
    .then((res) => (res.ok ? (res.json() as Promise<UiConfig>) : {}))
    .catch(() => ({}));
  return uiConfig;
}

/** Forget the cached `/api/ui-config` (tests). */
export function resetUiConfigForTests(): void {
  uiConfig = undefined;
}

function useMaxUploadBytes(override?: number): number | undefined {
  const [max, setMax] = useState<number | undefined>(override);
  useEffect(() => {
    if (override !== undefined) return;
    let live = true;
    void loadUiConfig().then((c) => {
      if (live && typeof c.maxUploadBytes === "number") setMax(c.maxUploadBytes);
    });
    return () => {
      live = false;
    };
  }, [override]);
  return override ?? max;
}

let nextId = 0;

/**
 * Works with or without a react-query provider (the canvas page also renders
 * standalone); with one, a finished upload invalidates `["assets"]`.
 */
export function useUploads(opts: UseUploadsOptions = {}) {
  const maxBytes = useMaxUploadBytes(opts.maxBytes);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const qc = useContext(QueryClientContext);
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const active = useRef(0);
  const queue = useRef<string[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const c of controllers.current.values()) c.abort();
    };
  }, []);

  const patch = useCallback((id: string, update: Partial<UploadEntry>) => {
    if (!mounted.current) return;
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...update } : e)));
  }, []);

  const pump = useCallback(() => {
    while (active.current < concurrency && queue.current.length > 0) {
      const id = queue.current.shift() as string;
      const file = files.current.get(id);
      if (!file) continue;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      active.current++;
      const location = optsRef.current.location ?? window.location;
      patch(id, { status: "uploading", indeterminate: !uploadTracksProgress(location) });
      let last = 0;
      uploadAsset(file, {
        location,
        signal: controller.signal,
        onProgress: (fraction) => {
          // Coalesce progress events to whole percents.
          const pct = Math.floor(fraction * 100);
          if (pct === last) return;
          last = pct;
          patch(id, { progress: fraction });
        },
      })
        .then(async (asset) => {
          patch(id, {
            status: asset.deduplicated ? "duplicate" : "done",
            progress: 1,
            indeterminate: false,
            asset,
          });
          void qc?.invalidateQueries({ queryKey: ["assets"] });
          try {
            await optsRef.current.onUploaded?.(asset, file);
          } catch (err) {
            patch(id, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err: unknown) => {
          if (err instanceof UploadError && err.cancelled) patch(id, { status: "cancelled" });
          else
            patch(id, {
              status: "error",
              error:
                err instanceof UploadError && err.status === 413 && maxBytes
                  ? `File too large (max ${formatMb(maxBytes)}).`
                  : err instanceof Error
                    ? err.message
                    : String(err),
            });
        })
        .finally(() => {
          active.current--;
          controllers.current.delete(id);
          files.current.delete(id);
          pump();
        });
    }
  }, [concurrency, patch, qc, maxBytes]);

  const upload = useCallback(
    (input: readonly File[] | FileList) => {
      const list = Array.from(input);
      const added: UploadEntry[] = [];
      for (const file of list) {
        const id = `up-${++nextId}`;
        const entry: UploadEntry = {
          id,
          name: file.name || "upload",
          size: file.size,
          mime: file.type,
          progress: 0,
          status: "queued",
        };
        if (file.size === 0) {
          entry.status = "error";
          entry.error = "Empty file.";
        } else if (maxBytes && file.size > maxBytes) {
          entry.status = "error";
          entry.error = `File too large (max ${formatMb(maxBytes)}).`;
        } else {
          files.current.set(id, file);
          queue.current.push(id);
        }
        added.push(entry);
      }
      setEntries((prev) => [...prev, ...added]);
      pump();
      return added.map((e) => e.id);
    },
    [maxBytes, pump],
  );

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id);
      if (controller) controller.abort();
      else if (queue.current.includes(id)) {
        queue.current = queue.current.filter((q) => q !== id);
        files.current.delete(id);
        patch(id, { status: "cancelled" });
      }
    },
    [patch],
  );

  const dismiss = useCallback((id: string) => {
    setEntries((list) => list.filter((e) => e.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setEntries((list) => list.filter((e) => e.status === "queued" || e.status === "uploading"));
  }, []);

  return { entries, upload, cancel, dismiss, clearFinished, maxBytes };
}
