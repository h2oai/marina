// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only, hash-chained audit log (JSONL, mode 0600). Every entitlement
 * decision, import plan, gateway admission and anchor request is recorded.
 * Each entry commits to the previous one (`prev` → `hash`), so truncating or
 * editing the middle of the file is detectable by `verifyAuditLog` — the same
 * shape the design's stage-1 Marina ledger generalises.
 *
 * Entries never contain proofs, tokens, signatures or keys: only verifier kind,
 * outcome, artifact id, licensee label and a hash of the token nonce.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalFederationJson } from "../../../src/net/federation-crypto";
import { sha256Hex } from "./envelope";

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  outcome: "allowed" | "refused" | "info";
  artifact_id?: string;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256Hex(canonicalFederationJson(entry));
}

export class AuditLog {
  private last: { seq: number; hash: string } | undefined;

  constructor(readonly path: string) {}

  private tail(): { seq: number; hash: string } {
    if (this.last) return this.last;
    if (!existsSync(this.path)) return { seq: 0, hash: GENESIS };
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const lastLine = lines.at(-1);
    if (!lastLine) return { seq: 0, hash: GENESIS };
    const entry = JSON.parse(lastLine) as AuditEntry;
    return { seq: entry.seq, hash: entry.hash };
  }

  append(
    action: string,
    outcome: AuditEntry["outcome"],
    detail: Record<string, unknown>,
    artifactId?: string,
  ): AuditEntry {
    const tail = this.tail();
    const base = {
      seq: tail.seq + 1,
      at: new Date().toISOString(),
      action,
      outcome,
      ...(artifactId ? { artifact_id: artifactId } : {}),
      detail,
      prev: tail.hash,
    };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, "", { mode: 0o600 });
      chmodSync(this.path, 0o600);
    }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.last = { seq: entry.seq, hash: entry.hash };
    return entry;
  }

  head(): { seq: number; hash: string } {
    return this.tail();
  }
}

/** Recompute the chain. Returns the first broken sequence number, or null when intact. */
export function verifyAuditLog(
  path: string,
): { ok: true; entries: number } | { ok: false; seq: number } {
  if (!existsSync(path)) return { ok: true, entries: 0 };
  let prev = GENESIS;
  let seq = 0;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as AuditEntry;
    const { hash, ...base } = entry;
    seq += 1;
    if (entry.seq !== seq || entry.prev !== prev || entryHash(base) !== hash)
      return { ok: false, seq };
    prev = hash;
  }
  return { ok: true, entries: seq };
}

/** Short, non-reversible handle for a token nonce in audit records. */
export function nonceHandle(nonce: unknown): string | undefined {
  return typeof nonce === "string" ? sha256Hex(nonce).slice(0, 16) : undefined;
}
