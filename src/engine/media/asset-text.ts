// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Text that describes or is contained in an asset, as one shape for every
 * reader: the media-memory indexer (`asset-memory.ts`), cited evidence
 * (`asset:<id>` in src/decisions/evidence.ts) and `asset show`.
 *
 * Where each part lives on the asset row:
 *   - `caption`, `alt` (columns, set by people), tags, the generation prompt
 *     (`provenance.prompt`);
 *   - `metadata.<kind>` = `{ text, model?, language?, tool?, createdAt, … }`
 *     for the machine-made kinds in {@link ASSET_TEXT_KINDS}: `transcript`
 *     (audio/video speech), `ocr` (text read off an image), `pdf_text`
 *     (text extracted from a PDF) and `caption_suggestion` (a model's caption,
 *     never copied over a caption a person set; `asset caption <id> accept`
 *     takes it). They are written ONLY through `setAssetText`
 *     (asset-library.ts).
 *
 * All of it is untrusted content: it came from a file or a model looking at
 * one, so every reader frames it as data, never as instructions.
 */

import type { AssetRow } from "../../persistence/db-assets";

/** Machine-made text kinds stored under `metadata.<kind>`. */
export const ASSET_TEXT_KINDS = ["transcript", "ocr", "pdf_text", "caption_suggestion"] as const;
export type AssetTextKind = (typeof ASSET_TEXT_KINDS)[number];

/** Characters of one stored machine-made text (longer text is cut and marked `truncated`). */
export const MAX_ASSET_TEXT_CHARS = 100_000;

/** The citation form of an asset: `asset:<id>`. */
export function assetRef(id: string): string {
  return `asset:${id}`;
}

/** `asset:<id>` where the id is a UUID or another id of 8–64 safe characters. */
const ASSET_REF = /\basset:([A-Za-z0-9][A-Za-z0-9_-]{7,63})\b/g;

/** Distinct asset ids cited as `asset:<id>` in `text`, first-seen order, at most `max`. */
export function parseAssetRefs(text: string, max = 8): string[] {
  const out: string[] = [];
  if (max <= 0) return out;
  for (const m of text.matchAll(ASSET_REF)) {
    const id = m[1] as string;
    if (!out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** One stored machine-made text part. */
export interface StoredAssetText {
  text: string;
  model?: string;
  language?: string;
  tool?: string;
  createdAt?: number;
  truncated?: boolean;
  [key: string]: unknown;
}

function parseMetadata(row: Pick<AssetRow, "metadata">): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.metadata || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The stored `metadata.<kind>` text of an asset, when it has a non-empty one. */
export function storedAssetText(
  row: Pick<AssetRow, "metadata">,
  kind: AssetTextKind,
): StoredAssetText | undefined {
  const value = parseMetadata(row)[kind];
  if (!value || typeof value !== "object") return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? (value as StoredAssetText) : undefined;
}

/** The kinds of text an asset's memory records are made from. */
export type AssetTextPartKind = "label" | "description" | "ocr" | "pdf" | "transcript";

export interface AssetTextPart {
  kind: AssetTextPartKind;
  text: string;
  /** Who or what produced it: `person`, a model id, `pdftotext`, … */
  by: string;
}

function promptOf(row: Pick<AssetRow, "provenance">): string | undefined {
  try {
    const p = JSON.parse(row.provenance || "{}") as { prompt?: unknown };
    return typeof p.prompt === "string" && p.prompt.trim() ? p.prompt.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every text part of an asset, in a fixed order: the label (caption, alt,
 * tags, generation prompt), a model's description, OCR, PDF text and a
 * transcript. `pdfText` overrides a stored `pdf_text` (the indexer passes
 * freshly extracted text). Empty parts are omitted.
 */
export function assetTextParts(
  row: Pick<AssetRow, "caption" | "alt" | "metadata" | "provenance">,
  tags: readonly string[],
  extra: { pdfText?: { text: string; by: string } } = {},
): AssetTextPart[] {
  const parts: AssetTextPart[] = [];
  const label = [
    row.caption?.trim() ? `Caption: ${row.caption.trim()}` : "",
    row.alt?.trim() ? `Alt text: ${row.alt.trim()}` : "",
    tags.length ? `Tags: ${tags.join(", ")}` : "",
    promptOf(row) ? `Generated from the prompt: ${promptOf(row)}` : "",
  ].filter(Boolean);
  if (label.length) parts.push({ kind: "label", text: label.join("\n"), by: "person" });
  const machine: [AssetTextKind, AssetTextPartKind][] = [
    ["caption_suggestion", "description"],
    ["ocr", "ocr"],
  ];
  for (const [kind, part] of machine) {
    const stored = storedAssetText(row, kind);
    if (stored) parts.push({ kind: part, text: stored.text.trim(), by: stored.model ?? "model" });
  }
  const pdf = extra.pdfText ?? storedPdf(row);
  if (pdf?.text.trim()) parts.push({ kind: "pdf", text: pdf.text.trim(), by: pdf.by });
  const transcript = storedAssetText(row, "transcript");
  if (transcript)
    parts.push({
      kind: "transcript",
      text: transcript.text.trim(),
      by: transcript.model ?? "transcriber",
    });
  return parts;
}

function storedPdf(row: Pick<AssetRow, "metadata">): { text: string; by: string } | undefined {
  const stored = storedAssetText(row, "pdf_text");
  return stored ? { text: stored.text, by: stored.tool ?? stored.model ?? "extractor" } : undefined;
}

/** Characters per memory chunk of a long text. */
export const ASSET_CHUNK_CHARS = 2_000;

/**
 * Split text into chunks of at most `size` characters, cutting at a form feed
 * (a PDF page), a blank line, a line end or a space when one is near the
 * limit. Deterministic: the same text always gives the same chunks, so chunk
 * numbers are stable ids.
 */
export function chunkAssetText(text: string, size = ASSET_CHUNK_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const floor = Math.floor(size * 0.5);
    let cut = -1;
    for (const sep of ["\f", "\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= floor) {
        cut = at;
        break;
      }
    }
    if (cut < 0) cut = size;
    const piece = rest.slice(0, cut).replace(/\f/g, "\n").trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).replace(/^[\f\s]+/, "");
  }
  const last = rest.replace(/\f/g, "\n").trim();
  if (last) out.push(last);
  return out;
}

/** Cut `text` to {@link MAX_ASSET_TEXT_CHARS}; reports whether it was cut. */
export function capAssetText(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_ASSET_TEXT_CHARS
    ? { text: text.slice(0, MAX_ASSET_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}
