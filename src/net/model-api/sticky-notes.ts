// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Sticky trailing notes: keep a passthru conversation's upstream prompt
// append-only for providers whose prompt cache reuses only a WHOLE earlier
// prompt (OpenAI's automatic prefix cache, observed live: a hit is always the
// previous request's full input, never a shorter shared prefix).
//
// The instrument stack's per-request note (memory context, lessons, the
// obligations reminder, a nudge) rides at the very end of the request
// (`withTrailingNote`). The client never sees it, so the next turn's history
// lacks it and the previous prompt is no longer a prefix of the new one: every
// turn misses the cache. Here each note sent is remembered under a hash chain
// of the client's messages it followed (scoped to the caller), and re-inserted
// at the same place, with the same bytes, on every later turn of that
// conversation; the new note still goes last. Turn N's upstream prompt is then
// an exact prefix of turn N+1's.
//
// Rules: a remembered note is never re-inserted at the final position (that is
// where this request's own note goes — a nudge or a retry of the same history
// replaces it); a new note identical to the most recent one already in the
// history is not repeated. In-process memory only, bounded and expiring; a
// miss just means no re-insertion (the request is what it was before).
// `MARINA_PASSTHRU_STICKY_NOTES=off` restores the plain trailing note.

import { createHash } from "node:crypto";
import type { PassthruAuthResult } from "./shared";

/** How a note was attached: into the final user message, or as a new user message. */
type Placement = { note: string; mode: "append" | "message" };

const STORE_MAX = 4096;
const STORE_TTL_MS = 2 * 60 * 60 * 1000;
const store = new Map<string, Placement & { at: number }>();

/** `MARINA_PASSTHRU_STICKY_NOTES=on|off` (default on; junk ⇒ on). */
export function stickyNotesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MARINA_PASSTHRU_STICKY_NOTES?.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "none");
}

/**
 * The caller a remembered note belongs to: the credential that matched (hashed,
 * never the key itself) plus the name a multi-tenant key maps to, so one
 * caller's notes (its memory context among them) never reach another's request.
 */
export function noteScopeFor(
  req: { headers: Headers },
  auth: PassthruAuthResult | undefined,
): string {
  const credential = auth?.matchedKey
    ? `k:${createHash("sha256").update(auth.matchedKey).digest("hex")}`
    : auth?.internal
      ? "internal"
      : auth?.openMode
        ? "open"
        : "anon";
  const agent = req.headers.get("X-Marina-Agent")?.trim() ?? "";
  return `${credential}|${auth?.boundEntityName ?? ""}|${agent}`;
}

/** Test hook: forget every remembered note. */
export function resetStickyNotesForTests(): void {
  store.clear();
}

/** Key order never changes the hash (a client may re-serialize its history). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function chain(prev: string, message: unknown): string {
  return createHash("sha256")
    .update(prev)
    .update("\u0000")
    .update(canonical(message))
    .digest("hex");
}

/**
 * `message` with `note` appended to its content (string or parts) — the exact
 * bytes `withTrailingNote` produces for a final user message.
 */
export function appendNoteToMessage(
  message: Record<string, unknown>,
  note: string,
): Record<string, unknown> {
  const content = message.content;
  return {
    ...message,
    content:
      typeof content === "string"
        ? content
          ? `${content}\n\n${note}`
          : note
        : Array.isArray(content)
          ? [...content, { type: "text", text: note }]
          : note,
  };
}

/** `messages` with `note` at the very end (into a final user message, else a new one). */
export function placeTrailingNote(messages: unknown[], note: string): unknown[] {
  const out = [...messages];
  const last = out[out.length - 1] as Record<string, unknown> | undefined;
  if (last && last.role === "user") out[out.length - 1] = appendNoteToMessage(last, note);
  else out.push({ role: "user", content: note });
  return out;
}

function sweep(now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.at <= STORE_TTL_MS && store.size <= STORE_MAX) break;
    store.delete(key);
  }
}

export interface StickyNotePlan {
  /** The client's messages with every remembered earlier note re-inserted. */
  messages: unknown[];
  /** This request's note to place at the end, or undefined (none, or a repeat). */
  note?: string;
  /** Remember this request's placement (call once the request is sent). */
  commit(): void;
}

/**
 * Re-insert the notes earlier turns of this conversation carried and decide
 * this request's own note. `scope` keeps one caller's notes from ever reaching
 * another caller's request.
 */
export function planStickyNotes(
  messages: unknown[],
  note: string | undefined,
  scope: string,
): StickyNotePlan {
  // Nothing remembered and nothing to remember: the request is unchanged.
  if (!note && store.size === 0) return { messages, commit() {} };
  const now = Date.now();
  const out: unknown[] = [];
  let hash = createHash("sha256").update(`sticky-notes:${scope}`).digest("hex");
  let latest: string | undefined;
  for (const [i, raw] of messages.entries()) {
    hash = chain(hash, raw);
    const entry = i < messages.length - 1 ? store.get(hash) : undefined;
    const message = raw as Record<string, unknown>;
    if (entry && now - entry.at <= STORE_TTL_MS) {
      // Most-recently used last, so the sweep drops the coldest first.
      store.delete(hash);
      store.set(hash, { ...entry, at: now });
      if (entry.mode === "append" && message?.role === "user") {
        out.push(appendNoteToMessage(message, entry.note));
      } else {
        out.push(raw, { role: "user", content: entry.note });
      }
      latest = entry.note;
    } else {
      out.push(raw);
    }
  }
  const finalKey = hash;
  const own = note && note !== latest ? note : undefined;
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  return {
    messages: out,
    ...(own ? { note: own } : {}),
    commit() {
      store.delete(finalKey);
      if (!own || messages.length === 0) return;
      store.set(finalKey, {
        note: own,
        mode: last?.role === "user" ? "append" : "message",
        at: Date.now(),
      });
      sweep(Date.now());
    },
  };
}
