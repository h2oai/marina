// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time import of learned bundles: a world is the code seed plus the
 * bundles the operator names. `MARINA_BOOTSTRAP_BUNDLES=<path>[,<path>]` lists
 * bundle directories (a directory without a `manifest.json` stands for every
 * bundle directly inside it, in name order). The server imports them right
 * after the world seed and before any agent wakes (`src/main.ts`).
 *
 * Naming a bundle here is the operator's explicit opt-in for that bundle, so
 * it imports whatever `MARINA_UPSTREAM` says; everything else about an import
 * is unchanged (`import.ts`): pinned signatures, revocations, no downgrade,
 * trust `imported` in `upstream:*` spaces, seeds only for empty slots.
 * `MARINA_BOOTSTRAP_ACCEPT` widens what is accepted: `own` asserts the
 * bundles' `private` slices are the operator's own pack (never a paid `token`
 * slice), `unsigned` accepts a bundle written with no publisher key (labelled
 * `unsigned`). A bundle whose generation and digest were already imported is
 * skipped without a write, so a second boot is a no-op.
 *
 * Unset (the default), nothing here runs and boot is unchanged.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MarinaDB } from "../persistence/database";
import { MANIFEST_FILE, verifyBundle } from "./bundle";
import { ownBundleGrant } from "./entitlement";
import { importLearnedBundle } from "./import";
import { pinnedPublisherKeys } from "./sign";

export const BOOTSTRAP_ACCEPT_VALUES = ["own", "unsigned"] as const;
export type BootstrapAccept = (typeof BOOTSTRAP_ACCEPT_VALUES)[number];

export interface BootstrapOutcome {
  path: string;
  outcome: "imported" | "unchanged" | "refused";
  /** `artifact@version` when known. */
  artifact?: string;
  detail: string;
}

/** The bundle directories `MARINA_BOOTSTRAP_BUNDLES` names, expanded and de-duplicated. */
export function bootstrapBundlePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const raw of (env.MARINA_BOOTSTRAP_BUNDLES ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const path = resolve(entry);
    if (
      existsSync(path) &&
      statSync(path).isDirectory() &&
      !existsSync(join(path, MANIFEST_FILE))
    ) {
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        if (statSync(child).isDirectory() && existsSync(join(child, MANIFEST_FILE)))
          out.push(child);
      }
    } else out.push(path);
  }
  return [...new Set(out)];
}

/** `MARINA_BOOTSTRAP_ACCEPT`: comma-separated `own`, `unsigned`. Unknown values throw. */
export function bootstrapAccept(env: NodeJS.ProcessEnv = process.env): Set<BootstrapAccept> {
  const out = new Set<BootstrapAccept>();
  for (const raw of (env.MARINA_BOOTSTRAP_ACCEPT ?? "").split(",")) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!(BOOTSTRAP_ACCEPT_VALUES as readonly string[]).includes(v))
      throw new Error(
        `MARINA_BOOTSTRAP_ACCEPT: unknown value "${v}" (${BOOTSTRAP_ACCEPT_VALUES.join(", ")})`,
      );
    out.add(v as BootstrapAccept);
  }
  return out;
}

/**
 * Import every bundle `MARINA_BOOTSTRAP_BUNDLES` names into `db`. Returns one
 * outcome per bundle (empty when the variable is unset). Never throws for a
 * refused bundle: a refusal is audited by the importer and reported here.
 */
export async function importBootstrapBundles(
  db: MarinaDB,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapOutcome[]> {
  const paths = bootstrapBundlePaths(env);
  if (paths.length === 0) return [];
  const accept = bootstrapAccept(env);
  const pinned = pinnedPublisherKeys(env);
  const allowUnsigned = accept.has("unsigned");
  const out: BootstrapOutcome[] = [];
  for (const path of paths) {
    const verified = verifyBundle(path, pinned, { allowUnsigned });
    if (verified.ok) {
      const m = verified.bundle.manifest;
      const latest = db.latestLearnedArtifact(m.artifact_id);
      if (
        latest?.generation === m.generation &&
        latest.manifest_digest === verified.bundle.digest
      ) {
        out.push({
          path,
          outcome: "unchanged",
          artifact: `${m.artifact_id}@${m.version}`,
          detail: `generation ${m.generation} already imported`,
        });
        continue;
      }
    }
    // A failed verification still goes through the importer, so the refusal is audited.
    const result = await importLearnedBundle(db, path, {
      pinned,
      env: { ...env, MARINA_UPSTREAM: "on" },
      actor: "bootstrap",
      allowUnsigned,
      ...(accept.has("own") ? { entitlement: ownBundleGrant("bootstrap") } : {}),
    });
    if (!result.ok) {
      out.push({ path, outcome: "refused", detail: result.error });
      continue;
    }
    const r = result.report;
    out.push({
      path,
      outcome: "imported",
      artifact: `${r.artifactId}@${r.version}`,
      detail: `${r.added} added, ${r.changed} changed, ${r.unchanged} unchanged, ${r.retired} retired, ${r.withheld.length} withheld, ${r.seeded.length} slot(s) seeded`,
    });
  }
  return out;
}
