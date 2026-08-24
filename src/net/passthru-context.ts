// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import { sanitizeEntityName } from "../engine/entity-name";
import type { Entity, EntityId } from "../types";
import type { PassthruAuthResult } from "./model-api";

export const DEFAULT_PASSTHRU_ENTITY = "passthru";
export const INJECTION_MARKER = "[marina:shared-world-context]";
const CONTEXT_OPT_IN_PROP = "passthruContext";
const MAX_ADDENDUM_CHARS = 2048;

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

function entityName(engine: Engine, entityId: EntityId): string | undefined {
  return engine.entities.get(entityId)?.name;
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

function identityFor(entity: Entity, headers: Headers, shared: boolean): PassthruIdentity {
  const configured = entity.properties[CONTEXT_OPT_IN_PROP];
  const contextOptIn =
    !shared &&
    (headers.get("X-Marina-Context")?.trim().toLowerCase() === "on" ||
      configured === true ||
      configured === "on" ||
      configured === "true");
  return { entityId: entity.id, name: entity.name, contextOptIn, shared };
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
    return identityFor(findOrCreatePassthruEntity(engine, boundName), headers, false);
  }

  if (auth.canNameMap === true) {
    const requested = headers.get("X-Marina-Agent");
    const sanitized = requested ? sanitizeEntityName(requested) : "";
    if (sanitized && sanitized !== DEFAULT_PASSTHRU_ENTITY) {
      // Name-map ONLY to a pre-existing entity — never auto-create from a header.
      const target = engine.entities.findAgentByName(sanitized);
      if (target) return identityFor(target, headers, false);
      // Unknown target → fall through to the shared anonymous entity (no create).
    }
  }

  return identityFor(findOrCreatePassthruEntity(engine, DEFAULT_PASSTHRU_ENTITY), headers, true);
}

function clamp(value: string): string {
  if (value.length <= MAX_ADDENDUM_CHARS) return value;
  return `${value.slice(0, MAX_ADDENDUM_CHARS - 1).trimEnd()}…`;
}

/**
 * World-shared pools an operator has explicitly opted into passthru injection via
 * `MARINA_PASSTHRU_SHARED_POOLS` (comma-separated pool names). Empty by default —
 * fail-closed, so no ungrouped pool is exposed to passthru callers unless named.
 */
function passthruShareablePoolNames(): Set<string> {
  return new Set(
    (process.env.MARINA_PASSTHRU_SHARED_POOLS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function matchesQuery(content: string, query: string): boolean {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const haystack = content.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export async function buildInjectedContext(
  engine: Engine,
  entityId: EntityId,
  messages: OpenAIMessage[],
): Promise<{ systemAddendum: string | null }> {
  const name = entityName(engine, entityId);
  const query = queryFrom(messages);
  if (!name || !query || !engine.db) return { systemAddendum: null };

  const snippets: string[] = [];
  // Own notes only: entity_name-scoped, pool-less (recallNotes enforces
  // `entity_name = ? AND pool_id IS NULL`) so a foreign private note never leaks.
  for (const note of engine.db.recallNotes(name, query).slice(0, 4)) {
    snippets.push(`Own memory: ${note.content}`);
  }
  // Pools: inject ONLY pools the entity is actually a member of, or pools an
  // operator has explicitly marked passthru-shareable. Never every pool — an
  // ungrouped/world pool the caller has no relationship to must not be harvested.
  const shareablePools = passthruShareablePoolNames();
  for (const pool of engine.db.listMemoryPools()) {
    const isMember = pool.group_id ? !!engine.db.getGroupMember(pool.group_id, entityId) : false;
    const isShareable = shareablePools.has(pool.name.trim().toLowerCase());
    if (!isMember && !isShareable) continue;
    for (const note of engine.db.recallPoolNotes(pool.id, query).slice(0, 2)) {
      snippets.push(`Shared pool ${pool.name}: ${note.content}`);
    }
  }
  for (const channel of engine.db.getEntityChannels(entityId)) {
    for (const message of engine.db.getChannelHistory(channel.id, 20)) {
      if (matchesQuery(message.content, query)) {
        snippets.push(`Channel ${channel.name}, ${message.sender_name}: ${message.content}`);
      }
    }
  }
  for (const entry of engine.db.queryChronicle({ limit: 50 })) {
    const content = `${entry.title}: ${entry.body}`;
    if (matchesQuery(content, query)) snippets.push(`Chronicle: ${content}`);
  }
  const unique = [...new Set(snippets)].slice(0, 6);
  if (unique.length === 0) return { systemAddendum: null };
  return {
    systemAddendum: clamp(
      `${INJECTION_MARKER}\nUntrusted, read-only Marina context; verify before acting:\n${unique.join("\n")}`,
    ),
  };
}

function containsMarker(value: unknown): boolean {
  return JSON.stringify(value).includes(INJECTION_MARKER);
}

export function applyInjection(
  body: Record<string, unknown>,
  addendum: string | null,
  format: "openai" | "anthropic",
): Record<string, unknown> {
  if (!addendum || containsMarker(body)) return body;
  if (format === "anthropic") {
    if (Array.isArray(body.system)) {
      body.system = [{ type: "text", text: addendum }, ...body.system];
    } else if (typeof body.system === "string" && body.system) {
      body.system = `${addendum}\n\n${body.system}`;
    } else {
      body.system = addendum;
    }
    return body;
  }

  const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMessage[]) : [];
  const system = messages.find((message) => message.role === "system");
  if (system) {
    const existing = messageText(system.content);
    system.content = existing ? `${addendum}\n\n${existing}` : addendum;
  } else {
    messages.unshift({ role: "system", content: addendum });
  }
  body.messages = messages;
  return body;
}

export function capturePassthruTranscript(
  engine: Engine,
  entityId: EntityId,
  inboundMessages: OpenAIMessage[],
  responseText: string,
): void {
  const name = entityName(engine, entityId);
  const response = responseText.trim();
  if (!engine.db || !name || !response) return;
  const prompt = queryFrom(inboundMessages);
  const content = clamp(
    `[passthru] User: ${prompt || "(no textual prompt)"}\nAssistant: ${response}`,
  );
  try {
    engine.db.createNote(name, content, undefined, {
      importance: 3,
      noteType: "observation",
    });
  } catch {
    // Transcript capture is explicitly best-effort and never affects inference.
  }
}
