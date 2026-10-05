// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The marketplace import path: verify the proof, then hand the bundle and the
 * resulting grant to the CORE importer (`importLearnedBundle`), which applies
 * only the slices the grant covers, at trust `imported`. This module never
 * writes memory, roles or rooms itself; there is one importer.
 *
 * The always-free line: open slices need no proof, so this path verifies
 * nothing and makes no network call for them.
 */

import { verifyBundle } from "../../../src/learned/bundle";
import {
  type EntitlementGrant,
  importContext,
  verifyEntitlement,
} from "../../../src/learned/entitlement";
import { type ImportOutcome, importLearnedBundle } from "../../../src/learned/import";
import type { MarinaDB } from "../../../src/persistence/database";
import { nonceHandle } from "./audit";
import type { MarketRuntime } from "./config";

export interface MarketImportOptions {
  /** Slice ids; default every slice (open items then import, gated ones are withheld). */
  slices?: string[];
  /** A `{ kind: "token", token }` or `{ kind: "evm-wallet", … }` proof. */
  proof?: unknown;
  actor?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export type MarketImportResult =
  | { ok: true; outcome: ImportOutcome; grant: EntitlementGrant | null; network_used: boolean }
  | { ok: false; error: string };

export async function importWithEntitlement(
  db: MarinaDB,
  dir: string,
  runtime: Pick<MarketRuntime, "pinned" | "verifiersFor" | "revocations" | "audit">,
  opts: MarketImportOptions = {},
): Promise<MarketImportResult> {
  const v = verifyBundle(dir, runtime.pinned);
  if (!v.ok) {
    runtime.audit.append("bundle.verify", "refused", { error: v.error });
    return { ok: false, error: v.error };
  }
  const m = v.bundle.manifest;
  const requested = opts.slices?.length ? opts.slices : m.slices.map((s) => s.id);
  const gated = requested.filter((id) => {
    const s = m.slices.find((x) => x.id === id);
    return s && !s.open && s.access !== "open";
  });
  let grant: EntitlementGrant | null = null;
  let networkUsed = false;
  if (opts.proof !== undefined && gated.length) {
    networkUsed = (opts.proof as { kind?: unknown })?.kind === "evm-wallet";
    const decision = await verifyEntitlement(
      opts.proof,
      importContext(m, gated, opts.now ?? new Date()),
      runtime.verifiersFor(m),
    );
    const nonce = nonceHandle((opts.proof as { token?: { nonce?: unknown } })?.token?.nonce);
    if (!decision.ok) {
      runtime.audit.append(
        "entitlement.verify",
        "refused",
        { verifier: decision.verifier, reason: decision.reason, slices: gated, nonce },
        m.artifact_id,
      );
      return { ok: false, error: `entitlement refused: ${decision.reason}` };
    }
    grant = decision.grant;
    runtime.audit.append(
      "entitlement.verify",
      "allowed",
      { verifier: grant.verifier, licensee: grant.licensee, slices: gated, nonce },
      m.artifact_id,
    );
  }
  const outcome = await importLearnedBundle(db, dir, {
    pinned: runtime.pinned,
    revocations: runtime.revocations,
    actor: opts.actor ?? "operator",
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.slices?.length ? { slices: opts.slices } : {}),
    ...(grant ? { entitlement: grant } : {}),
  });
  runtime.audit.append(
    "import.apply",
    outcome.ok ? "allowed" : "refused",
    outcome.ok
      ? {
          added: outcome.report.added,
          changed: outcome.report.changed,
          withheld: outcome.report.withheld.length,
          slices: requested,
        }
      : { error: outcome.error },
    m.artifact_id,
  );
  return { ok: true, outcome, grant, network_used: networkUsed };
}
