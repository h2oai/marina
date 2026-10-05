// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The entitlement gate in front of the core importer. It never writes memory,
 * roles or rooms itself (that would be a second importer): it verifies the
 * bundle, decides which slices the user may take, and hands the verified plan
 * to the core `marina.learned.v1` importer at trust `imported`.
 *
 * The always-free line, mechanically:
 *   - open slices (the `core` tier always) need NO proof and make NO network call;
 *   - only slices the user explicitly requests that are `token` trigger a check;
 *   - `private` slices (personal profile) are never importable here.
 */

import type { AuditLog } from "./audit";
import { nonceHandle } from "./audit";
import { type EntitlementVerifier, verifyEntitlement } from "./entitlements";
import { type Bundle, openBundle, type PinnedKey, sliceAccess } from "./envelope";
import { WORLD_PROFILE } from "./world";

export interface ImportPlan {
  artifact_id: string;
  name: string;
  version: string;
  generation: number;
  content_profile: string | null;
  manifest_digest: string;
  publisher: { name: string; key_id: string };
  license: string;
  terms: { url: string; sha256: string } | null;
  redistribution: string;
  commercial_use: string;
  slices: string[];
  files: string[];
  /** Imported content is never trusted until confirmed by local outcomes. */
  trust: "imported";
  /** Room source code is listed for review, never compiled or registered. */
  code_files_for_review: string[];
  entitlement: { verifier: string; licensee: string; expires_at?: string } | null;
  /** True only when a paid tier was requested with an on-chain proof. */
  network_used: boolean;
}

export interface PlanOptions {
  /** Requested slices; default `["core"]` (or every open slice when there is no core). */
  slices?: string[];
  proof?: unknown;
  now?: Date;
}

export function planImport(
  bundleDir: string,
  options: PlanOptions,
  deps: {
    pinned: readonly PinnedKey[];
    verifiers: readonly EntitlementVerifier[];
    audit: AuditLog;
  },
): Promise<ImportPlan> {
  return planVerified(openVerified(bundleDir, deps), options, deps);
}

function openVerified(
  bundleDir: string,
  deps: { pinned: readonly PinnedKey[]; audit: AuditLog },
): Bundle {
  try {
    return openBundle(bundleDir, deps.pinned);
  } catch (error) {
    deps.audit.append("bundle.verify", "refused", { error: (error as Error).message });
    throw error;
  }
}

async function planVerified(
  bundle: Bundle,
  options: PlanOptions,
  deps: { verifiers: readonly EntitlementVerifier[]; audit: AuditLog },
): Promise<ImportPlan> {
  const { manifest } = bundle;
  const defaultSlices = manifest.slices.some((s) => s.id === "core")
    ? ["core"]
    : manifest.slices.filter((s) => sliceAccess(manifest, s.id) === "open").map((s) => s.id);
  const requested = [...new Set(options.slices?.length ? options.slices : defaultSlices)];
  const refuse = (reason: string): never => {
    deps.audit.append(
      "import.plan",
      "refused",
      { reason, slices: requested },
      manifest.artifact_id,
    );
    throw new Error(reason);
  };
  const paid: string[] = [];
  for (const id of requested) {
    const access = sliceAccess(manifest, id);
    if (!access) refuse(`unknown slice ${id}`);
    if (access === "private") refuse(`slice ${id} is private and never importable`);
    if (access === "token") paid.push(id);
  }

  let entitlement: ImportPlan["entitlement"] = null;
  let networkUsed = false;
  if (paid.length) {
    if (options.proof === undefined) refuse(`slices ${paid.join(",")} need an entitlement proof`);
    networkUsed = (options.proof as { kind?: unknown })?.kind === "evm-wallet";
    const decision = await verifyEntitlement(
      options.proof,
      {
        artifactId: manifest.artifact_id,
        version: manifest.version,
        tiers: paid,
        purpose: "import",
        now: options.now ?? new Date(),
        allowedIssuers: manifest.access.entitlement_issuers,
      },
      deps.verifiers,
    );
    const handle = nonceHandle((options.proof as { token?: { nonce?: unknown } })?.token?.nonce);
    if (!decision.ok) {
      deps.audit.append(
        "entitlement.verify",
        "refused",
        { verifier: decision.verifier, reason: decision.reason, tiers: paid, nonce: handle },
        manifest.artifact_id,
      );
      refuse(`entitlement refused: ${decision.reason}`);
    } else {
      deps.audit.append(
        "entitlement.verify",
        "allowed",
        { verifier: decision.verifier, licensee: decision.licensee, tiers: paid, nonce: handle },
        manifest.artifact_id,
      );
      entitlement = {
        verifier: decision.verifier,
        licensee: decision.licensee,
        expires_at: decision.expiresAt,
      };
    }
  }

  const files = [
    ...new Set(manifest.slices.filter((s) => requested.includes(s.id)).flatMap((s) => s.files)),
  ].sort();
  const plan: ImportPlan = {
    artifact_id: manifest.artifact_id,
    name: manifest.name,
    version: manifest.version,
    generation: manifest.generation,
    content_profile: manifest.content_profile ?? null,
    manifest_digest: bundle.manifestDigest,
    publisher: { name: manifest.publisher.name, key_id: manifest.publisher.key_id },
    license: manifest.license,
    terms: manifest.terms ?? null,
    redistribution: manifest.redistribution,
    commercial_use: manifest.commercial_use,
    slices: requested,
    files,
    trust: "imported",
    code_files_for_review:
      manifest.content_profile === WORLD_PROFILE
        ? files.filter((f) => f.startsWith("world/rooms/") && f.endsWith(".ts"))
        : [],
    entitlement,
    network_used: networkUsed,
  };
  deps.audit.append(
    "import.plan",
    "allowed",
    { slices: requested, files: files.length, paid, digest: bundle.manifestDigest },
    manifest.artifact_id,
  );
  return plan;
}

/**
 * The core importer's documented entry point (Phase 1 part C, `learned import`).
 * Integration point: when part C lands, `loadCoreImporter` resolves it; until
 * then the plan is the deliverable and apply refuses rather than inventing a
 * parallel write path.
 */
export interface LearnedImporter {
  importBundle(
    bundleDir: string,
    options: { slices: string[]; trust: "imported"; files: string[] },
  ): Promise<{ applied: number }>;
}

export const CORE_IMPORTER_MODULE = "../../../src/learned/import.ts";

export async function loadCoreImporter(): Promise<LearnedImporter | undefined> {
  try {
    const mod = (await import(CORE_IMPORTER_MODULE)) as {
      importLearnedBundle?: LearnedImporter["importBundle"];
    };
    return typeof mod.importLearnedBundle === "function"
      ? { importBundle: mod.importLearnedBundle }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function applyPlan(
  bundleDir: string,
  plan: ImportPlan,
  audit: AuditLog,
  importer?: LearnedImporter,
): Promise<{ applied: boolean; detail: string }> {
  const core = importer ?? (await loadCoreImporter());
  if (!core) {
    audit.append("import.apply", "info", { reason: "core importer unavailable" }, plan.artifact_id);
    return {
      applied: false,
      detail:
        "core marina.learned.v1 importer is not available on this build (Phase 1 part C); the verified plan is ready to apply when it lands",
    };
  }
  const result = await core.importBundle(bundleDir, {
    slices: plan.slices,
    trust: "imported",
    files: plan.files,
  });
  audit.append(
    "import.apply",
    "allowed",
    { applied: result.applied, slices: plan.slices },
    plan.artifact_id,
  );
  return { applied: true, detail: `applied ${result.applied} item(s) at trust imported` };
}
