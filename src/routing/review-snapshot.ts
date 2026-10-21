// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RoutingEventInput } from "../sdk/routing-types";

const exec = promisify(execFile);

/** Routing event kind of one part of a review snapshot. */
export const REVIEW_SNAPSHOT_KIND = "review.snapshot";
/** The `code review request` modifier naming a snapshot the supervisor attached. */
export const REVIEW_SNAPSHOT_MODIFIER = "snapshot";
/** Largest diff a snapshot carries; the rest is cut and the cut is labelled. */
export const REVIEW_SNAPSHOT_MAX_BYTES = 512 * 1024;
/** Encoded bytes of text per event part (routing payloads are at most 32 KiB). */
const PART_BYTES = 24_000;
/** Most parts the server reads back for one snapshot (escaping can inflate a part). */
export const REVIEW_SNAPSHOT_MAX_PARTS = 256;

export interface ReviewSnapshot {
  /** Unified diff of the worktree against HEAD, untracked files included. */
  text: string;
  /** Bytes before any cut. */
  totalBytes: number;
  truncated: boolean;
  files: string[];
}

export interface ReviewSnapshotPart {
  snapshotId: string;
  part: number;
  parts: number;
  text: string;
  totalBytes: number;
  truncated: boolean;
  files: string[];
}

/** Whether a relayed world command is a review request (it gets a snapshot). */
export function isReviewRequestCommand(command: string): boolean {
  return /^code\s+review\s+request(\s|$)/i.test(command.trim());
}

/**
 * Name the snapshot on the command: the modifier goes before a `--` that
 * starts the claims, else at the end. A snapshot the agent typed itself is
 * replaced, so only the supervisor's own reaches the server.
 */
export function withSnapshotModifier(command: string, snapshotId: string): string {
  const trimmed = command.trim();
  const split = trimmed.search(/\s--(\s|$)/);
  const head = (split < 0 ? trimmed : trimmed.slice(0, split))
    .split(/\s+/)
    .filter((token) => !/^(--)?snapshot[:=]/i.test(token))
    .join(" ");
  const tail = split < 0 ? "" : trimmed.slice(split);
  return `${head} ${REVIEW_SNAPSHOT_MODIFIER}:${snapshotId}${tail}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: REVIEW_SNAPSHOT_MAX_BYTES * 4,
    encoding: "utf8",
  });
  return stdout;
}

/** git diff --no-index exits 1 when the files differ; that is its success. */
async function untrackedDiff(cwd: string, path: string): Promise<string> {
  try {
    return await git(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
  } catch (error) {
    const out = (error as { stdout?: unknown }).stdout;
    if (typeof out === "string") return out;
    throw error;
  }
}

/** The worktree's changes against HEAD, bounded. */
export async function captureReviewSnapshot(cwd: string): Promise<ReviewSnapshot> {
  const tracked = await git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff"]);
  const changed = (await git(cwd, ["diff", "HEAD", "--name-only"])).split("\n").filter(Boolean);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean);
  let text = tracked;
  for (const path of untracked) {
    if (Buffer.byteLength(text) > REVIEW_SNAPSHOT_MAX_BYTES) break;
    text += await untrackedDiff(cwd, path);
  }
  const totalBytes = Buffer.byteLength(text);
  const truncated = totalBytes > REVIEW_SNAPSHOT_MAX_BYTES;
  if (truncated) text = Buffer.from(text).subarray(0, REVIEW_SNAPSHOT_MAX_BYTES).toString("utf8");
  return { text, totalBytes, truncated, files: [...changed, ...untracked].slice(0, 200) };
}

/** Cut text into pieces whose JSON encoding stays within `PART_BYTES`. */
function pieces(text: string): string[] {
  const out: string[] = [];
  const step = 1000;
  let current = "";
  for (let at = 0; at < text.length; at += step) {
    const next = text.slice(at, at + step);
    if (current && Buffer.byteLength(JSON.stringify(current + next)) > PART_BYTES) {
      out.push(current);
      current = "";
    }
    current += next;
  }
  out.push(current);
  return out;
}

/** Split a snapshot into routing events `<snapshotId>:<part>`. */
export function snapshotEvents(snapshotId: string, snapshot: ReviewSnapshot): RoutingEventInput[] {
  const texts = pieces(snapshot.text);
  const parts = texts.length;
  return texts.map((text, part) => ({
    id: `${snapshotId}:${part}`,
    kind: REVIEW_SNAPSHOT_KIND,
    payload: {
      snapshotId,
      part,
      parts,
      text,
      totalBytes: snapshot.totalBytes,
      truncated: snapshot.truncated,
      // The file list rides on the first part only.
      files: part === 0 ? snapshot.files : [],
    } satisfies ReviewSnapshotPart,
  }));
}

/** Reassemble parts read back from the store; undefined when any is missing. */
export function assembleSnapshot(
  parts: { payload: unknown }[],
  snapshotId: string,
): ReviewSnapshot | undefined {
  const rows = parts
    .map((row) => row.payload as Partial<ReviewSnapshotPart>)
    .filter((row) => row.snapshotId === snapshotId && typeof row.text === "string");
  const first = rows.find((row) => row.part === 0);
  if (!first || typeof first.parts !== "number") return undefined;
  const ordered: string[] = [];
  for (let part = 0; part < first.parts; part++) {
    const row = rows.find((entry) => entry.part === part);
    if (!row) return undefined;
    ordered.push(row.text as string);
  }
  return {
    text: ordered.join(""),
    totalBytes: Number(first.totalBytes) || 0,
    truncated: first.truncated === true,
    files: Array.isArray(first.files) ? first.files.map(String) : [],
  };
}
