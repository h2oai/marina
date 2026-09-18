// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { hash } from "../persistence/db-memory-service";
import { MarinaMemoryClient, MemoryClientError } from "../sdk/memory-client";
import type {
  MemoryFederatedEntry,
  MemoryFederatedPin,
  MemoryFederatedResult,
  MemoryFederatedRetrievalResult,
  MemoryRecord,
  MemoryRetrievalInput,
  MemoryRetrievedEvidence,
  MemorySearchInput,
  MemorySourceRange,
} from "../sdk/memory-types";
import { integer, MemoryError, object, textValue } from "./service-types";

interface Mount {
  alias: string;
  client: MarinaMemoryClient;
  space: string;
}
export interface MemoryFederatedSeal {
  pin: MemoryFederatedPin;
  origin: string;
  generation: number;
  digest: string;
}

export function federatedCachePins(raw: unknown): MemoryFederatedPin[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32)
    throw new MemoryError(400, "invalid_pins", "Use at most 32 federated pins");
  return raw.map((value) => {
    const pin = object(value);
    const common = {
      mount: textValue(pin.mount, "mount", 128),
      space_id: textValue(pin.space_id, "space_id", 128),
      id: textValue(pin.id, "id", 128),
    };
    if (pin.kind === "record")
      return {
        ...common,
        kind: "record",
        version: integer(pin.version, "version", 1, Number.MAX_SAFE_INTEGER),
      };
    if (pin.kind === "source")
      return {
        ...common,
        kind: "source",
        content_hash: textValue(pin.content_hash, "content_hash", 128),
      };
    throw new MemoryError(400, "invalid_pins", "Use record or source pins");
  });
}
/** Operator-defined capabilities, bound to a local principal. Callers explicitly
 * select aliases; no request-controlled URLs, credential forwarding or replication. */
export class MemoryFederation {
  private owners = new Map<string, Map<string, Mount>>();
  mount(owner: string, alias: string, client: MarinaMemoryClient, space: string) {
    textValue(owner, "owner", 128);
    textValue(alias, "alias", 128);
    textValue(space, "space", 128);
    const mounts = this.owners.get(owner) ?? new Map<string, Mount>();
    if (mounts.size >= 8 && !mounts.has(alias))
      throw new Error("At most eight memory mounts per owner");
    mounts.set(alias, { alias, client, space });
    this.owners.set(owner, mounts);
  }
  unmount(owner: string, alias: string) {
    this.owners.get(owner)?.delete(alias);
  }
  list(owner: string) {
    return [...(this.owners.get(owner)?.keys() ?? [])].sort();
  }
  private select(owner: string, aliases: unknown) {
    if (!Array.isArray(aliases) || !aliases.length || aliases.length > 8)
      throw new MemoryError(400, "invalid_mounts", "Explicitly select 1–8 mounted aliases");
    return [...new Set(aliases.map((alias) => textValue(alias, "alias", 128)))].map((alias) => {
      const mount = this.owners.get(owner)?.get(alias);
      if (!mount) throw new MemoryError(404, "mount_not_found", "Memory mount not found");
      return mount;
    });
  }
  private check(owner: string, mounts: Mount[], authorize: () => unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    authorize();
    if (mounts.some((m) => this.owners.get(owner)?.get(m.alias) !== m))
      throw new MemoryError(
        409,
        "mount_changed",
        "Federation configuration changed during retrieval",
      );
  }
  /** A read on each peer at lookup time, never a TTL-only authorization cache.
   * Seals bind endpoint, principal, space, generation and exact record bytes.
   * This is per-peer consistency, not a distributed transaction. */
  async seal(
    owner: string,
    pins: MemoryFederatedPin[],
    authorize: () => unknown,
    signal?: AbortSignal,
  ): Promise<MemoryFederatedSeal[]> {
    if (!pins.length) return [];
    const mounts = this.select(owner, [...new Set(pins.map((pin) => pin.mount))]);
    this.check(owner, mounts, authorize, signal);
    const sealed = await Promise.all(
      mounts.map(async (mount) => {
        const client = signal ? mount.client.withSignal(signal) : mount.client;
        const selected = pins.filter((pin) => pin.mount === mount.alias);
        if (selected.some((pin) => pin.space_id !== mount.space))
          throw new MemoryError(409, "cache_basis_changed", "Pinned space differs from its mount");
        const before = await client.space(mount.space);
        const identity = await client.request<{ principal_id: string }>("/me");
        if (
          typeof identity.principal_id !== "string" ||
          !identity.principal_id ||
          before.id !== mount.space ||
          !Number.isSafeInteger(before.retrieval_generation) ||
          before.retrieval_generation < 0
        )
          throw new MemoryError(502, "invalid_peer", "Peer identity is unavailable");
        const origin = hash({
          url: mount.client.url.replace(/\/$/, ""),
          space: mount.space,
          principal: identity.principal_id,
        });
        const result = await Promise.all(
          selected.map(async (pin): Promise<MemoryFederatedSeal> => {
            let digest: string;
            if (pin.kind === "record") {
              const record = await client.get(mount.space, pin.id);
              if (
                record.id !== pin.id ||
                record.space_id !== pin.space_id ||
                record.version !== pin.version ||
                record.freshness !== "current"
              )
                throw new MemoryError(409, "cache_basis_changed", "Pinned remote record changed");
              digest = hash(record);
            } else {
              const source = await client.sourceRange(mount.space, pin.id, { start: 0, end: 0 });
              if (source.id !== pin.id || source.content_hash !== pin.content_hash)
                throw new MemoryError(409, "cache_basis_changed", "Pinned remote source changed");
              digest = hash({ content_hash: source.content_hash, text_hash: source.text_hash });
            }
            return { pin, origin, generation: before.retrieval_generation, digest };
          }),
        );
        const after = await client.space(mount.space);
        if (after.id !== mount.space || before.retrieval_generation !== after.retrieval_generation)
          throw new MemoryError(409, "cache_basis_changed", "Peer changed during validation");
        return result;
      }),
    );
    this.check(owner, mounts, authorize, signal);
    const byPin = new Map(sealed.flat().map((seal) => [hash(seal.pin), seal]));
    return pins.map((pin) => byPin.get(hash(pin))!);
  }
  async retrieve(
    owner: string,
    raw: unknown,
    authorize: () => unknown,
    signal?: AbortSignal,
  ): Promise<MemoryFederatedRetrievalResult> {
    const body = object(raw),
      mounts = this.select(owner, body.mounts);
    const input = object(body.retrieval) as unknown as MemoryRetrievalInput;
    const maxResults = integer(input.max_results ?? 6, "max_results", 1, 20);
    const maxBytes = integer(input.max_bytes ?? 8192, "max_bytes", 256, 65536);
    if (input.use_model || input.observe)
      throw new MemoryError(
        400,
        "invalid_input",
        "Federated retrieval uses bounded deterministic reads without observation pools",
      );
    if (body.allow_partial !== undefined && typeof body.allow_partial !== "boolean")
      throw new MemoryError(400, "invalid_input", "allow_partial must be boolean");
    this.check(owner, mounts, authorize, signal);
    const evidence: (MemoryRetrievedEvidence & { mount: string })[] = [];
    const peers: MemoryFederatedRetrievalResult["peers"] = [];
    // Sequential allocation makes this one total evidence budget, not N peer budgets.
    for (const mount of mounts) {
      this.check(owner, mounts, authorize, signal);
      const remainingBytes = maxBytes - Buffer.byteLength(JSON.stringify(evidence)) - 128;
      const remainingResults = maxResults - evidence.length;
      if (remainingResults < 1 || remainingBytes < 256) {
        peers.push({ mount: mount.alias, status: "budget_exhausted" });
        continue;
      }
      try {
        const client = signal ? mount.client.withSignal(signal) : mount.client;
        const before = await client.space(mount.space);
        const result = await client.retrieve(mount.space, {
          ...input,
          max_results: remainingResults,
          max_bytes: remainingBytes,
        });
        const after = await client.space(mount.space);
        if (
          before.id !== mount.space ||
          result.space_id !== mount.space ||
          before.retrieval_generation !== result.retrieval_generation ||
          after.retrieval_generation !== result.retrieval_generation
        )
          throw new MemoryError(409, "peer_changed", "Peer changed during retrieval");
        let limited = false;
        for (const item of result.evidence) {
          const entry = { ...item, mount: mount.alias };
          if (
            evidence.length >= maxResults ||
            Buffer.byteLength(JSON.stringify([...evidence, entry])) > maxBytes
          ) {
            limited = true;
            continue;
          }
          evidence.push(entry);
        }
        peers.push({
          mount: mount.alias,
          space_id: mount.space,
          status: limited || result.truncated ? "truncated" : "ok",
          retrieval_generation: result.retrieval_generation,
          vocabulary_version: result.vocabulary_version,
          valid_at: result.valid_at,
        });
      } catch (error) {
        this.check(owner, mounts, authorize, signal);
        if (body.allow_partial !== true)
          throw new MemoryError(
            503,
            "peer_unavailable",
            `Selected peer ${mount.alias} could not complete retrieval`,
          );
        peers.push({
          mount: mount.alias,
          status: "unavailable",
          code:
            error instanceof MemoryClientError || error instanceof MemoryError
              ? error.code
              : "peer_unavailable",
        });
      }
    }
    this.check(owner, mounts, authorize, signal);
    return {
      schema: "marina.memory.federated-retrieval.v1",
      evidence,
      peers,
      bytes: Buffer.byteLength(JSON.stringify(evidence)),
      consistency: "per-peer",
      answer_sufficiency: "not_assessed",
      truncated: peers.some((peer) => peer.status !== "ok"),
    };
  }
  async search(
    owner: string,
    raw: unknown,
    authorize: () => unknown,
    signal?: AbortSignal,
  ): Promise<MemoryFederatedResult> {
    const body = object(raw),
      mounts = this.select(owner, body.mounts),
      limit = integer(body.limit ?? 10, "limit", 1, 100),
      maxBytes = integer(body.max_bytes ?? 65536, "max_bytes", 256, 1048576);
    if (body.allow_partial !== undefined && typeof body.allow_partial !== "boolean")
      throw new MemoryError(400, "invalid_input", "allow_partial must be boolean");
    const query = textValue(body.query, "query", 8192);
    const mode = body.mode ?? "lexical";
    const kind = body.kind ?? "records";
    if (kind !== "records" && kind !== "sources")
      throw new MemoryError(400, "invalid_input", "Use kind records or sources");
    if (kind === "sources" && mode !== "lexical")
      throw new MemoryError(400, "invalid_input", "Original source retrieval uses lexical mode");
    if (mode !== "lexical" && mode !== "hybrid")
      throw new MemoryError(400, "invalid_input", "Invalid retrieval mode");
    const input: MemorySearchInput = { query, mode, limit: Math.min(limit, 20) };
    this.check(owner, mounts, authorize, signal);
    const outcomes = await Promise.all(
      mounts.map(async (mount) => {
        try {
          const client = signal ? mount.client.withSignal(signal) : mount.client;
          if (kind === "sources") {
            const result = await client.sourceSearch(mount.space, { query, limit: input.limit });
            const entries: MemoryFederatedEntry[] = result.results.map((source, index) => ({
              kind: "source",
              source,
              score: 1 / (61 + index),
              origin: { mount: mount.alias, space_id: mount.space, id: source.id },
            }));
            return { mount, entries, truncated: result.truncated };
          }
          const result = await client.search(mount.space, input);
          const entries: MemoryFederatedEntry[] = result.results.map((record, index) => ({
            kind: "record",
            record,
            score: 1 / (61 + index),
            origin: {
              mount: mount.alias,
              space_id: mount.space,
              id: record.id,
              version: record.version,
            },
          }));
          return { mount, entries, truncated: result.results.length >= input.limit! };
        } catch (error) {
          return {
            mount,
            error: error instanceof MemoryClientError ? error.code : "peer_unavailable",
          };
        }
      }),
    );
    this.check(owner, mounts, authorize, signal);
    const failures = outcomes.flatMap((o) =>
      o.error ? [{ mount: o.mount.alias, code: o.error }] : [],
    );
    if (failures.length && !body.allow_partial)
      throw new MemoryError(
        503,
        "federation_incomplete",
        "A selected peer failed; use allow_partial only if incomplete evidence is acceptable",
      );
    const ranked = outcomes
      .flatMap((o) => o.entries ?? [])
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.origin.mount.localeCompare(b.origin.mount) ||
          a.origin.id.localeCompare(b.origin.id),
      );
    let bytes = 0;
    const results: typeof ranked = [];
    for (const result of ranked) {
      const size = Buffer.byteLength(JSON.stringify(result));
      if (results.length >= limit || bytes + size > maxBytes) break;
      results.push(result);
      bytes += size;
    }
    return {
      results,
      failures,
      incomplete: failures.length > 0,
      bytes,
      truncated: ranked.length > results.length || outcomes.some((o) => o.truncated),
      consistency: "per-peer-read-snapshots",
      replicated: false,
    };
  }
  async read(owner: string, raw: unknown, authorize: () => unknown, signal?: AbortSignal) {
    const body = object(raw),
      mounts = this.select(owner, [body.mount]),
      mount = mounts[0]!;
    const id = textValue(body.id, "id", 128),
      client = signal ? mount.client.withSignal(signal) : mount.client;
    if (body.kind !== "record" && body.kind !== "source")
      throw new MemoryError(400, "invalid_input", "Use kind record or source");
    this.check(owner, mounts, authorize, signal);
    let result: MemoryRecord | MemorySourceRange;
    try {
      result =
        body.kind === "record"
          ? await client.get(
              mount.space,
              id,
              body.version === undefined
                ? undefined
                : integer(body.version, "version", 1, Number.MAX_SAFE_INTEGER),
            )
          : await client.sourceRange(mount.space, id, {
              start:
                body.start === undefined
                  ? undefined
                  : integer(body.start, "start", 0, Number.MAX_SAFE_INTEGER),
              end:
                body.end === undefined
                  ? undefined
                  : integer(body.end, "end", 0, Number.MAX_SAFE_INTEGER),
            });
    } catch (error) {
      this.check(owner, mounts, authorize, signal);
      const missing = error instanceof MemoryClientError && error.status === 404;
      throw new MemoryError(
        missing ? 404 : 503,
        missing ? "peer_not_found" : "peer_unavailable",
        missing
          ? "Selected peer no longer exposes that evidence"
          : "Selected peer could not provide evidence",
      );
    }
    this.check(owner, mounts, authorize, signal);
    return { origin: { mount: mount.alias, space_id: mount.space, id }, result };
  }
}

export function configuredMemoryFederation() {
  const federation = new MemoryFederation(),
    path = process.env.MARINA_MEMORY_FEDERATION_CONFIG;
  if (!path) return federation;
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries) || entries.length > 256)
    throw new Error("Federation config must contain at most 256 mounts");
  for (const raw of entries) {
    const entry = object(raw),
      url = new URL(textValue(entry.url, "url", 2048));
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid federation endpoint");
    const token = process.env[textValue(entry.token_env, "token_env", 128)];
    if (!token) throw new Error("Federation credential environment variable is missing");
    federation.mount(
      textValue(entry.owner_principal_id, "owner_principal_id", 128),
      textValue(entry.alias, "alias", 128),
      new MarinaMemoryClient(url.toString().replace(/\/$/, ""), token, 10000),
      textValue(entry.space_id, "space_id", 128),
    );
  }
  return federation;
}
