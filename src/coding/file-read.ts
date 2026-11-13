// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export const MAX_READ_LINES = 2000;
export const MAX_READ_PAGE_BYTES = 50 * 1024;

export interface FileReadOptions {
  /** One-based starting line (default 1). */
  offset?: number;
  /** Requested lines (default and maximum 2000). */
  limit?: number;
  /** One-based Unicode character column, for continuing an oversized line. */
  column?: number;
}

export interface FileReadPage {
  offset: number;
  limit: number;
  column: number;
  endLine: number;
  numberedContent: string;
  next?: { offset: number; column: number };
}

export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  /** Present for line-range reads; numeric byte-limit reads retain raw content. */
  page?: FileReadPage;
}

export function resolveFileReadOptions(options: FileReadOptions): Required<FileReadOptions> {
  const { offset = 1, limit = MAX_READ_LINES, column = 1 } = options;
  for (const [key, value] of Object.entries({ offset, limit, column })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${key} must be a positive safe integer.`);
  }
  return { offset, limit: Math.min(limit, MAX_READ_LINES), column };
}

/** Scan to the requested line without buffering the file or any oversized line.
 * Count the numbered rendering against the byte cap, and split only between
 * Unicode characters. A continuation can therefore read every character. */
export async function readFilePage(
  chunks: AsyncIterable<string>,
  options: FileReadOptions,
): Promise<Pick<FileReadResult, "content" | "truncated"> & { page: FileReadPage }> {
  const { offset, limit, column } = resolveFileReadOptions(options);
  const content: string[] = [];
  const numbered: string[] = [];
  const page: FileReadPage = { offset, limit, column, endLine: offset - 1, numberedContent: "" };
  let line = 1;
  let characterColumn = 1;
  let bytes = 0;
  let prefixNeeded = true;
  outer: for await (const chunk of chunks) {
    for (const character of chunk) {
      if (line >= offset && (line > offset || characterColumn >= column)) {
        const prefix = prefixNeeded ? `${line}: ` : "";
        const addedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(character);
        if (line - offset >= limit || bytes + addedBytes > MAX_READ_PAGE_BYTES) {
          page.next = { offset: line, column: characterColumn };
          break outer;
        }
        content.push(character);
        numbered.push(prefix, character);
        bytes += addedBytes;
        page.endLine = line;
        prefixNeeded = character === "\n";
      }
      if (character === "\n") {
        line++;
        characterColumn = 1;
      } else characterColumn++;
    }
  }
  page.numberedContent = numbered.join("");
  return { content: content.join(""), truncated: page.next !== undefined, page };
}

/** Modifiers precede `--` so paths that resemble modifiers remain literal. */
export function fileReadContinuation(path: string, page: FileReadPage): string | undefined {
  if (!page.next) return undefined;
  const { offset, column } = page.next;
  return `code read offset:${offset} limit:${page.limit}${column > 1 ? ` column:${column}` : ""} -- ${path}`;
}
