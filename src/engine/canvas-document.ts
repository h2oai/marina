// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { MarinaDB } from "../persistence/database";
import {
  PANEL_LIMITS,
  type PanelValidationOptions,
  panelRecord,
  validatePanelDocument,
} from "../sdk/panel-document";
import type { StorageProvider } from "../storage/provider";

/**
 * Resolves stored assets only. No publisher-supplied URL is fetched. Reads are
 * tolerant of component types a newer Marina wrote; a write passes
 * `{ unknownComponents: "refuse" }` so its author learns at once.
 */
export async function canvasDocumentData(
  input: unknown,
  assetId: string | null | undefined,
  db: Pick<MarinaDB, "getAsset">,
  storage?: StorageProvider,
  options?: PanelValidationOptions,
): Promise<Record<string, unknown>> {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  let document: unknown = data;
  if (panelRecord(data) && data.components === undefined && assetId) {
    const asset = db.getAsset(assetId);
    if (!asset || !storage) throw new Error("Panel asset is unavailable.");
    if (asset.size > PANEL_LIMITS.bytes) throw new Error("Panel asset exceeds 256 KiB.");
    const stored = await storage.get(asset.storage_key);
    if (!stored) throw new Error("Panel asset is unavailable.");
    if (stored.data.byteLength > PANEL_LIMITS.bytes)
      throw new Error("Panel asset exceeds 256 KiB.");
    document = JSON.parse(new TextDecoder().decode(stored.data));
  }
  const parsed = validatePanelDocument(document, options);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...(panelRecord(data) ? data : {}), ...parsed.document };
}

/** Changes only when the interactive definition changes, not on a field event or geometry edit. */
export function panelRevision(data: unknown): string | undefined {
  const result = validatePanelDocument(data);
  return result.ok
    ? createHash("sha256").update(JSON.stringify(result.document)).digest("hex")
    : undefined;
}
