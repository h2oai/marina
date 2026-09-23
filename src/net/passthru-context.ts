// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Engine } from "../engine/engine";
import { sanitizeEntityName } from "../engine/entity-name";
import { isLocalProfile } from "../engine/trust-profile";
import {
  buildUnifiedContext,
  byteLength,
  truncateToBytes,
  type UnifiedContextResult,
  type UnifiedTier,
} from "../memory/unified-context";
import type { Entity, EntityId } from "../types";
import type { MemoryReceiptDraft, MemoryReceiptRef, MemoryReceiptTier } from "./memory-receipt";
import type { PassthruAuthResult } from "./model-api";

export const DEFAULT_PASSTHRU_ENTITY = "passthru";
/** First line of every injected addendum — a label for humans and tests, NOT a
 *  suppression switch (clients opt out with `X-Marina-Context: off`). */
export const INJECTION_MARKER = "[marina:shared-world-context]";
export const INJECTION_FRAMING = "Untrusted, read-only Marina context; verify before acting:";
const CONTEXT_OPT_IN_PROP = "passthruContext";
const INJECT_BYTES_PROP = "passthruInjectBytes";
/** Default total injection budget (bytes, framing lines included). */
export const DEFAULT_PASSTHRU_INJECT_BYTES = 2048;
const MIN_INJECT_BYTES = 256;
const MAX_INJECT_BYTES = 65_536;
/** Below this many remaining bytes a line is dropped rather than stubbed. */
const MIN_LINE_BYTES = 48;
/** Repeated identical exchanges are captured once per entity per window. */
export const CAPTURE_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CAPTURE_CHARS = 2048;

export interface OpenAIMessage {
  role: string;
  content: unknown;
}

export interface PassthruIdentity {
  entityId: EntityId;
  name: string;
  contextOptIn: boolean;
  /**
   * True when resolution fell back to the anonymous, shared default passthru
   * entity. A shared identity is pure passthru: it MUST NOT participate in
   * transcript capture or cross-context injection (every non-distinct caller
   * collapses onto it, so writing/reading its memory would leak caller A's
   * transcripts to caller B). Only a distinct identity — a scoped bound key or an
   * authorized name-map to an existing entity — reads/writes the shared world.
   */
  shared: boolean;
  /** True for an operator-declared `secret:entity` binding — the only identity
   *  whose request headers (`X-Marina-Context: on|off`) are honored. */
  bound: boolean;
}

/** Where each protocol natively carries system context. */
export type InjectionFormat = "openai" | "anthropic" | "ollama-generate" | "responses";

export interface InjectedContext {
  systemAddendum: string | null;
  /** Receipt draft (no request id yet) — null whenever nothing was injected. */
  receipt: MemoryReceiptDraft | null;
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function queryFrom(messages: OpenAIMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  return messageText(user?.content).trim().slice(0, 500);
}

/** Lazily resolve (or create) a passthru entity by an already-trusted name. */
function findOrCreatePassthruEntity(engine: Engine, rawName: string): Entity {
  const name = sanitizeEntityName(rawName) || DEFAULT_PASSTHRU_ENTITY;
  const existing = engine.entities.findAgentByName(name);
  if (existing) return existing;
  return engine.entities.create({
    kind: "agent",
    name,
    short: `${name} (model API)`,
    long: "A caller represented by Marina's model API.",
    room: engine.config.startRoom,
    properties: { passthru: true },
  });
}

function identityFor(
  entity: Entity,
  headers: Headers,
  shared: boolean,
  bound: boolean,
): PassthruIdentity {
  const configured = entity.properties[CONTEXT_OPT_IN_PROP];
  const storedOptIn = configured === true || configured === "on" || configured === "true";
  // Request headers are honored ONLY for a bound identity (an operator
  // explicitly declared that binding). For a NAME-MAPPED target the request
  // header is attacker-controlled and MUST NOT force the target agent into —
  // or out of — shared-context participation; the target opts in solely via
  // its own stored `properties[passthruContext]`. Shared/anonymous never
  // participates at all.
  const header = bound ? headers.get("X-Marina-Context")?.trim().toLowerCase() : undefined;
  let contextOptIn: boolean;
  if (shared) contextOptIn = false;
  // Explicit opt-out wins over stored config AND the local-profile default: a
  // bound client that says "off" gets a byte-identical proxy for that request.
  else if (header === "off") contextOptIn = false;
  // LOCAL trust profile: identified loopback clients get memory injection
  // without opting in — the operator's own tools should just remember.
  else contextOptIn = header === "on" || storedOptIn || isLocalProfile();
  return { entityId: entity.id, name: entity.name, contextOptIn, shared, bound };
}

/**
 * Map an authenticated model-API caller to a Marina entity. Fail-closed identity
 * model (mirrors MEM_API_KEYS scoping):
 *
 *  - A scoped `secret:entity` MODEL_API_KEYS key (`auth.boundEntityName`) is
 *    CONFINED to its bound entity. `X-Marina-Agent` is IGNORED for it — a bound
 *    key can never impersonate another entity. The binding is operator-declared
 *    config (not attacker input), so the bound entity may be lazily created.
 *  - `X-Marina-Agent` name-mapping to an arbitrary entity is honored ONLY for a
 *    genuinely privileged credential (internal token, open dev mode, or an
 *    explicitly-flagged multi-tenant/operator key) — i.e. `auth.canNameMap`, the
 *    authoritative flag computed by `authenticate()`. Merely holding a binding
 *    does NOT grant name-map authority.
 *  - Even a name-map-authorized caller may only target an ALREADY-EXISTING
 *    entity: a header can never conjure a new agent. Only the shared default
 *    passthru entity is auto-created.
 *  - Everything else collapses onto the anonymous shared default entity, flagged
 *    `shared: true` so the caller performs pure passthru (no capture, no
 *    cross-context injection).
 */
export function resolvePassthruIdentity(
  engine: Engine,
  headers: Headers,
  auth: Partial<PassthruAuthResult>,
): PassthruIdentity {
  const boundName = auth.boundEntityName ? sanitizeEntityName(auth.boundEntityName) : "";
  if (boundName) {
    // Bound identity: operator-declared, so the request MAY opt it in or out.
    return identityFor(findOrCreatePassthruEntity(engine, boundName), headers, false, true);
  }

  if (auth.canNameMap === true) {
    const requested = headers.get("X-Marina-Agent");
    const sanitized = requested ? sanitizeEntityName(requested) : "";
    if (sanitized && sanitized !== DEFAULT_PASSTHRU_ENTITY) {
      // Name-map ONLY to a pre-existing entity — never auto-create from a header.
      const target = engine.entities.findAgentByName(sanitized);
      // Name-mapped target: IGNORE the request X-Marina-Context header — the
      // target participates in shared context only if IT has itself opted in via
      // stored properties. This blocks an operator key from forcing context
      // sharing/capture on an agent that never consented.
      if (target) return identityFor(target, headers, false, false);
      // Unknown target → fall through to the shared anonymous entity (no create).
    }
  }

  return identityFor(
    findOrCreatePassthruEntity(engine, DEFAULT_PASSTHRU_ENTITY),
    headers,
    true,
    false,
  );
}

function clampBudget(value: number): number {
  return Math.min(MAX_INJECT_BYTES, Math.max(MIN_INJECT_BYTES, Math.floor(value)));
}

/**
 * Total injection budget for an identity: the entity's own `passthruInjectBytes`
 * property (operator-set per bound key) → `MARINA_PASSTHRU_INJECT_BYTES` → 2048.
 */
export function resolveInjectBudget(
  entity: Entity | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const own = entity?.properties[INJECT_BYTES_PROP];
  const ownNumber = typeof own === "number" ? own : typeof own === "string" ? Number(own) : NaN;
  if (Number.isFinite(ownNumber) && ownNumber > 0) return clampBudget(ownNumber);
  const fromEnv = Number.parseInt(env.MARINA_PASSTHRU_INJECT_BYTES ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampBudget(fromEnv);
  return DEFAULT_PASSTHRU_INJECT_BYTES;
}

function clampChars(value: string): string {
  if (value.length <= MAX_CAPTURE_CHARS) return value;
  return `${value.slice(0, MAX_CAPTURE_CHARS - 1).trimEnd()}…`;
}

/**
 * World-shared pools an operator has explicitly opted into passthru injection via
 * `MARINA_PASSTHRU_SHARED_POOLS` (comma-separated pool names). Empty by default —
 * fail-closed, so no ungrouped pool is exposed to passthru callers unless named.
 */
let shareablePoolsCache: { raw: string; set: Set<string> } | null = null;

function passthruShareablePoolNames(): Set<string> {
  // Cached on the raw env string — this runs on every context-injected passthru
  // request, and the env only changes in tests.
  const raw = process.env.MARINA_PASSTHRU_SHARED_POOLS ?? "";
  if (shareablePoolsCache?.raw !== raw) {
    shareablePoolsCache = {
      raw,
      set: new Set(
        raw
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    };
  }
  return shareablePoolsCache.set;
}

function matchesQuery(content: string, query: string): boolean {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const haystack = content.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/** One candidate addendum line with the provenance the receipt records. */
interface ContextLine {
  tier: string;
  ref: MemoryReceiptRef;
  text: string;
}

/**
 * Stable-first render order. Provider prompt caches (Anthropic / OpenAI prefix
 * caching) hit only on a byte-identical prefix, so content that changes
 * rarely — skills, [trusted] notes, durable [evidence] — renders first, and
 * content that churns per request — [proposal], [unverified] own notes,
 * recent channel / chronicle lines — renders last.
 */
const STABLE_TIERS: readonly UnifiedTier[] = ["skill", "trusted", "evidence"];
const VOLATILE_TIERS: readonly UnifiedTier[] = ["proposal", "unverified"];

function unifiedRef(
  tier: UnifiedTier,
  item: UnifiedContextResult["tiers"][number]["items"][number],
) {
  const ref: MemoryReceiptRef = { id: item.id };
  if (tier === "evidence") {
    if (item.meta?.kind === "record" && typeof item.meta.version === "number") {
      ref.version = item.meta.version;
    } else if (item.meta?.kind === "source" && typeof item.meta.content_hash === "string") {
      ref.hash = item.meta.content_hash;
    }
  }
  return ref;
}

/**
 * Build the injected system addendum for `entityId` from the unified memory
 * surface plus the world sections the entity may read (member / shareable
 * pools, its channels, the chronicle). Deterministic and budgeted:
 *
 *   [marina:shared-world-context]
 *   Untrusted, read-only Marina context; verify before acting:
 *   Marina memory for <name>.
 *   <stable: skills, [trusted], [evidence]>
 *   <volatile: [proposal], [unverified], pools, channels, chronicle>
 *
 * The three framing lines count against the budget so `budgetBytes` bounds
 * the whole addendum. Every admitted line is recorded in the receipt draft
 * with its tier and id (record version / source hash for durable evidence).
 */
export async function buildInjectedContext(
  engine: Engine,
  entityId: EntityId,
  messages: OpenAIMessage[],
  opts: { budgetBytes?: number } = {},
): Promise<InjectedContext> {
  const entity = engine.entities.get(entityId);
  const name = entity?.name;
  const query = queryFrom(messages);
  if (!name || !query || !engine.db) return { systemAddendum: null, receipt: null };

  const budgetBytes = opts.budgetBytes
    ? clampBudget(opts.budgetBytes)
    : resolveInjectBudget(entity);
  const header = `${INJECTION_MARKER}\n${INJECTION_FRAMING}\nMarina memory for ${name}.`;
  const headerBytes = byteLength(header) + 1; // + newline before the first line
  const contentBudget = Math.max(0, budgetBytes - headerBytes);
  // Own memory takes the larger share so pools / channels / chronicle are never
  // starved; the final admission pass below enforces the exact total.
  const ownBudget = contentBudget >= 512 ? Math.floor(contentBudget * 0.6) : contentBudget;
  const maxLines = Math.min(60, Math.max(10, Math.floor(contentBudget / 180)));
  const maxOwnLines = Math.min(24, Math.max(6, Math.floor(maxLines * 0.6)));

  const stable: ContextLine[] = [];
  const volatile: ContextLine[] = [];
  const degraded: string[] = [];
  let unifiedTruncated = false;

  // Own memory through the unified surface — the same tiers the entity's own
  // continuation prompt sees: skills, [trusted], [evidence] (durable records +
  // captured sources), [proposal] (finished assistance answers), [unverified].
  // Legacy tiers stay entity_name-scoped and pool-less (a foreign private note
  // never leaks); durable tiers bind to the entity's server-resolved world
  // account and are silently skipped (degraded) when it has none — the shared
  // anonymous passthru entity never reaches here at all. Each line keeps its
  // tier label so the upstream model can weigh provenance.
  try {
    const unified = await buildUnifiedContext(engine.db, name, query, {
      scope: "all",
      budgetBytes: ownBudget,
      perTier: { skill: 2, trusted: 3, evidence: 4, proposal: 2, unverified: 3 },
    });
    unifiedTruncated = unified.truncated;
    let own = 0;
    for (const tier of unified.tiers) {
      const bucket = STABLE_TIERS.includes(tier.tier)
        ? stable
        : VOLATILE_TIERS.includes(tier.tier)
          ? volatile
          : undefined;
      if (!bucket) continue;
      for (const item of tier.items) {
        if (own >= maxOwnLines) break;
        bucket.push({
          tier: tier.tier,
          ref: unifiedRef(tier.tier, item),
          text: `Own memory ${tier.label} (${item.provenance}): ${item.content}`,
        });
        own++;
      }
    }
    const seenDegraded = new Set<string>();
    for (const d of unified.degraded) {
      const key = `${d.tier}:${d.code}`;
      if (seenDegraded.has(key)) continue;
      seenDegraded.add(key);
      degraded.push(key);
    }
  } catch {
    // Context injection is best-effort; a memory failure never blocks inference.
    degraded.push("unified:error");
  }

  const worldCap = () => stable.length + volatile.length >= maxLines;
  // Pools: inject ONLY pools the entity is actually a member of, or pools an
  // operator has explicitly marked passthru-shareable. Never every pool — an
  // ungrouped/world pool the caller has no relationship to must not be harvested.
  const shareablePools = passthruShareablePoolNames();
  if (!worldCap()) {
    for (const pool of engine.db.listMemoryPools()) {
      if (worldCap()) break;
      const isMember = pool.group_id ? !!engine.db.getGroupMember(pool.group_id, entityId) : false;
      const isShareable = shareablePools.has(pool.name.trim().toLowerCase());
      if (!isMember && !isShareable) continue;
      for (const note of engine.db.recallPoolNotes(pool.id, query).slice(0, 2)) {
        volatile.push({
          tier: "pool",
          ref: { id: String(note.id) },
          text: `Shared pool ${pool.name}: ${note.content}`,
        });
        if (worldCap()) break;
      }
    }
  }
  if (!worldCap()) {
    for (const channel of engine.db.getEntityChannels(entityId)) {
      if (worldCap()) break;
      for (const message of engine.db.getChannelHistory(channel.id, 20)) {
        if (matchesQuery(message.content, query)) {
          volatile.push({
            tier: "channel",
            ref: { id: String(message.id) },
            text: `Channel ${channel.name}, ${message.sender_name}: ${message.content}`,
          });
          if (worldCap()) break;
        }
      }
    }
  }
  if (!worldCap()) {
    for (const entry of engine.db.queryChronicle({ limit: 50 })) {
      const content = `${entry.title}: ${entry.body}`;
      if (matchesQuery(content, query)) {
        volatile.push({
          tier: "chronicle",
          ref: { id: String(entry.id) },
          text: `Chronicle: ${content}`,
        });
        if (worldCap()) break;
      }
    }
  }

  // Admission: exact byte accounting over the ordered candidates. Identical
  // text is emitted once; a line that only partially fits is cut with a visible
  // marker, and one that cannot fit at all is dropped — both flag `truncated`.
  const admitted: ContextLine[] = [];
  const seenText = new Set<string>();
  let used = 0;
  let truncated = unifiedTruncated;
  for (const line of [...stable, ...volatile]) {
    if (seenText.has(line.text)) continue;
    seenText.add(line.text);
    const remaining = contentBudget - used - (admitted.length > 0 ? 1 : 0);
    const size = byteLength(line.text);
    if (size <= remaining) {
      admitted.push(line);
      used += size + (admitted.length > 1 ? 1 : 0);
      continue;
    }
    truncated = true;
    if (remaining >= MIN_LINE_BYTES) {
      const text = truncateToBytes(line.text, remaining);
      admitted.push({ ...line, text });
      used += byteLength(text) + (admitted.length > 1 ? 1 : 0);
    }
  }
  if (admitted.length === 0) return { systemAddendum: null, receipt: null };

  const tiers: MemoryReceiptTier[] = [];
  for (const line of admitted) {
    let tier = tiers.find((t) => t.tier === line.tier);
    if (!tier) {
      tier = { tier: line.tier, ids: [], bytes: 0 };
      tiers.push(tier);
    }
    tier.ids.push(line.ref);
    tier.bytes += byteLength(line.text);
  }
  const systemAddendum = `${header}\n${admitted.map((line) => line.text).join("\n")}`;
  return {
    systemAddendum,
    receipt: {
      schema: "marina.memory.receipt.v1",
      entity: name,
      tiers,
      budgetBytes,
      usedBytes: byteLength(systemAddendum),
      truncated,
      degraded,
    },
  };
}

/**
 * Put the addendum where each protocol natively carries system context —
 * ALWAYS after the caller's own (stable) system text, as its own block where
 * the protocol has blocks:
 *  - `openai`           — a separate `system` message inserted right after the
 *                         leading run of system/developer messages (index 0
 *                         when the caller sent none); also the Ollama `/api/chat`
 *                         shape.
 *  - `anthropic`        — appended as the LAST text block of the top-level
 *                         `system` (a string system becomes a two-block array).
 *  - `ollama-generate`  — appended to the `system` string of `/api/generate`.
 *  - `responses`        — appended to the `instructions` string of `/v1/responses`.
 * Stable-first matters for provider prefix caches: the memory block is the
 * volatile part (relevance-gated, changes as notes accrue), so it must sit
 * after the caller's prompt and — for Anthropic — after the breakpoint the
 * proxy places on the last stable block (`placeCacheBreakpoints`). A null
 * addendum is a strict no-op (byte-identical body).
 */
export function applyInjection(
  body: Record<string, unknown>,
  addendum: string | null,
  format: InjectionFormat,
): Record<string, unknown> {
  if (!addendum) return body;
  if (format === "anthropic") {
    const block = { type: "text", text: addendum };
    if (Array.isArray(body.system)) {
      body.system = [...body.system, block];
    } else if (typeof body.system === "string" && body.system) {
      body.system = [{ type: "text", text: body.system }, block];
    } else {
      body.system = addendum;
    }
    return body;
  }
  if (format === "ollama-generate" || format === "responses") {
    const field = format === "responses" ? "instructions" : "system";
    const existing = typeof body[field] === "string" ? (body[field] as string) : "";
    body[field] = existing ? `${existing}\n\n${addendum}` : addendum;
    return body;
  }

  const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMessage[]) : [];
  // Stable prefix = the leading run of system/developer messages; the memory
  // block goes right after it so every provider sees caller prompt → memory.
  let insertAt = 0;
  while (insertAt < messages.length && isSystemRole(messages[insertAt]?.role)) insertAt++;
  messages.splice(insertAt, 0, { role: "system", content: addendum });
  body.messages = messages;
  return body;
}

function isSystemRole(role: unknown): boolean {
  return role === "system" || role === "developer";
}

// ─── Transcript capture ──────────────────────────────────────────────────────

/** entityId → (content sha256 → captured-at). Pruned on write. */
const recentCaptures = new Map<string, Map<string, number>>();

/** Test hook: forget the capture dedup window. */
export function resetPassthruCaptureDedupForTests(): void {
  recentCaptures.clear();
}

function alreadyCaptured(entityId: EntityId, content: string, now: number): boolean {
  const digest = createHash("sha256").update(content).digest("hex");
  let seen = recentCaptures.get(entityId);
  if (!seen) {
    seen = new Map();
    recentCaptures.set(entityId, seen);
  }
  for (const [hash, at] of seen) {
    if (now - at > CAPTURE_DEDUP_WINDOW_MS) seen.delete(hash);
  }
  if (seen.has(digest)) return true;
  seen.set(digest, now);
  return false;
}

/**
 * Record one `[passthru] User/Assistant` pair in the caller's OWN memory. The
 * caller invokes this at most once per request (one pair per request), and an
 * identical exchange is written once per entity per 24h window — a client that
 * retries or replays a prompt does not multiply observation notes. Returns true
 * when a note was written.
 */
export function capturePassthruTranscript(
  engine: Engine,
  entityId: EntityId,
  inboundMessages: OpenAIMessage[],
  responseText: string,
  now: number = Date.now(),
): boolean {
  const name = engine.entities.get(entityId)?.name;
  const response = responseText.trim();
  if (!engine.db || !name || !response) return false;
  const prompt = queryFrom(inboundMessages);
  const content = clampChars(
    `[passthru] User: ${prompt || "(no textual prompt)"}\nAssistant: ${response}`,
  );
  if (alreadyCaptured(entityId, content, now)) return false;
  try {
    engine.db.createNote(name, content, undefined, {
      importance: 3,
      noteType: "observation",
    });
    return true;
  } catch {
    // Transcript capture is explicitly best-effort and never affects inference.
    return false;
  }
}
