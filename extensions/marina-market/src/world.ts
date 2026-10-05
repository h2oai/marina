// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * World publishing for the marketplace: turn a payload directory into a signed
 * `marina.learned.v1` bundle with content profile `marina.world.v1`. Every
 * format rule (item kinds, hashes, slices, signature, world validation) is the
 * core's (`src/learned/*`); this module only maps payload files to items, runs
 * the publish-side scans, and adds the one world-only marketplace rule: every
 * world has an OPEN `tier:core` slice that carries the world document.
 *
 * Payload layout (relative to the payload directory):
 *   world/world.json        the data-only world document          → `world` item
 *   world/rooms/<id>.ts     optional room source (inert text)      → `room_source` items
 *   roles/<name>.json       RoleBundle v1                          → `role` items
 *   conventions.jsonl       {id, text, pool}                       → `convention` items
 *   lessons.jsonl           {id, text, domain, lesson_kind, resolved_at, category?}
 *                                                                  → `lesson` items
 *   contributions.jsonl     pseudonymous contribution vectors      → spec sheet only
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  decodeRoleBundle,
  encodeRoleBundle,
  type RoleBundle,
} from "../../../src/agent/role-bundle";
import {
  type AssembleSlice,
  assembleBundle,
  type UnhashedItem,
} from "../../../src/learned/assemble";
import {
  type Access,
  itemKey,
  type LicenceChain,
  type Manifest,
  manifestDigest,
  type ParentRef,
  type Tier,
  WORLD_PROFILE,
  type WorldDocument,
} from "../../../src/learned/format";
import { publicKeyOfSigningKey } from "../../../src/net/federation-crypto";

export { WORLD_PROFILE };
export const CORE_SLICE = "tier:core";

export interface WorldPublishSpec {
  name: string;
  description: string;
  version: string;
  generation: number;
  parent?: ParentRef | null;
  /** Default: proprietary (`LicenseRef-<publisher>-proprietary`). */
  license?: string;
  terms?: { url: string | null; sha256: string | null };
  redistribution?: Manifest["redistribution"];
  commercial_use?: Manifest["commercial_use"];
  publisher: { name: string; url?: string };
  entitlement_issuers?: string[];
  chains?: LicenceChain[];
  /** Slices, e.g. `tier:core` (must be open) and `tier:standard` (token). `include` = payload paths or directory prefixes ending in `/`. */
  tiers: Array<{ id: string; access: Access["model"]; include: string[] }>;
  min_marina_version?: string;
}

/**
 * Publish-side scans over every text payload file. A hit refuses publication
 * (drop, never redact in place). The core scanner runs again on import.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["provider api key", /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["env assignment of a secret", /\b[A-Z][A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD)\s*=\s*\S{8,}/],
  ["home path", /\/(home|Users)\/[A-Za-z0-9._-]+\//],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];

export function scanText(file: string, body: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(
    ([label]) => `${file}: ${label}`,
  );
}

const ALLOWED_PAYLOAD =
  /^(world\/world\.json|world\/rooms\/[a-z0-9_-]+\.ts|roles\/[A-Za-z0-9_.-]+\.json|lessons\.jsonl|conventions\.jsonl|contributions\.jsonl)$/;

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error(`symlinks are not allowed in a payload: ${entry.name}`);
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Validate a contribution line: pseudonymous participants, bounded weights, no content. */
export function validateContribution(line: unknown): string | null {
  const c = line as {
    item_id?: unknown;
    participants?: Array<{ id?: unknown; kind?: unknown; weight?: unknown; method?: unknown }>;
  };
  if (!c || typeof c.item_id !== "string" || !Array.isArray(c.participants))
    return "contribution needs item_id and participants[]";
  for (const p of c.participants) {
    if (typeof p.id !== "string" || !/^(anon|pseud):[A-Za-z0-9_.:-]{1,80}$/.test(p.id))
      return "participant ids must be pseudonymous (anon:… or pseud:…)";
    if (!["agent", "model", "human", "federated", "publisher"].includes(String(p.kind)))
      return "participant kind invalid";
    if (typeof p.weight !== "number" || p.weight < 0 || p.weight > 1)
      return "participant weight must be in [0,1]";
    if (!["provenance", "leave-one-out", "shapley-sampled", "declared"].includes(String(p.method)))
      return "attribution method invalid";
  }
  return null;
}

function jsonl(body: string, file: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        throw new Error(`${file}:${i + 1} is not JSON`);
      }
    });
}

const PROVENANCE = [{ producer: "curator" as const, origin: "publisher" }];

/** Map payload files to core items. Throws with every problem found. */
export function payloadItems(
  dir: string,
  salt: string,
): { items: Map<string, UnhashedItem[]>; contributions: unknown[]; codeFiles: string[] } {
  const files = listFiles(dir);
  const problems: string[] = [];
  const items = new Map<string, UnhashedItem[]>();
  const contributions: unknown[] = [];
  const push = (file: string, item: UnhashedItem) =>
    items.set(file, [...(items.get(file) ?? []), item]);
  for (const file of files)
    if (!ALLOWED_PAYLOAD.test(file)) problems.push(`file not allowed in a world payload: ${file}`);
  if (!files.includes("world/world.json")) problems.push("world/world.json is required");
  for (const file of files.filter((f) => ALLOWED_PAYLOAD.test(f))) {
    const body = readFileSync(join(dir, file), "utf8");
    problems.push(...scanText(file, body));
    try {
      if (file === "world/world.json") {
        const world = JSON.parse(body) as WorldDocument;
        push(file, {
          kind: "world",
          item_key: itemKey("world", salt, "world"),
          domain: "worlds",
          tier: "core",
          provenance: PROVENANCE,
          world,
        });
      } else if (file.startsWith("world/rooms/")) {
        const roomId = file.slice("world/rooms/".length, -".ts".length);
        push(file, {
          kind: "room_source",
          item_key: itemKey("room_source", salt, roomId),
          domain: "worlds",
          tier: "standard",
          provenance: PROVENANCE,
          room_id: roomId,
          language: "typescript",
          source: body,
          requires_gate: "world.code",
        });
      } else if (file.startsWith("roles/")) {
        // Same validation as `role import`, on the JSON form.
        const decoded = decodeRoleBundle(encodeRoleBundle(JSON.parse(body) as RoleBundle));
        if ("error" in decoded) throw new Error(decoded.error);
        push(file, {
          kind: "role",
          item_key: itemKey("role", salt, decoded.role.name),
          domain: "roles",
          tier: "full" as Tier,
          provenance: PROVENANCE,
          role: decoded,
        });
      } else if (file === "conventions.jsonl") {
        for (const c of jsonl(body, file))
          push(file, {
            kind: "convention",
            item_key: itemKey("convention", salt, String(c.id)),
            domain: "conventions",
            tier: "standard",
            provenance: PROVENANCE,
            pool: String(c.pool ?? "guide"),
            text: String(c.text),
            ratified: { basis: "publisher-curated", by: "ratifier" },
          });
      } else if (file === "lessons.jsonl") {
        for (const l of jsonl(body, file))
          push(file, {
            kind: "lesson",
            item_key: itemKey("lesson", salt, String(l.id)),
            domain: String(l.domain ?? "general"),
            tier: "standard",
            provenance: PROVENANCE,
            text: String(l.text),
            lesson_kind: l.lesson_kind === "success" ? "success" : "failure",
            ...(typeof l.category === "string" ? { category: l.category } : {}),
            trust_at_source: "trusted",
            resolved_at: String(l.resolved_at),
          });
      } else if (file === "contributions.jsonl") {
        for (const c of jsonl(body, file)) {
          const err = validateContribution(c);
          if (err) problems.push(`${file}: ${err}`);
          contributions.push(c);
        }
      }
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  if (problems.length) throw new Error(`world payload refused:\n- ${problems.join("\n- ")}`);
  const codeFiles = files.filter((f) => f.startsWith("world/rooms/"));
  return { items, contributions, codeFiles };
}

/**
 * Assemble and sign a world bundle into `outDir`. The signing key is the
 * publisher's learned-bundle key (base64 PKCS#8 DER), used once and never stored.
 */
export function publishWorld(
  payloadDir: string,
  outDir: string,
  spec: WorldPublishSpec,
  signingKey: string,
  now = Date.now(),
): { manifest: Manifest; manifestDigest: string } {
  const { keyId } = publicKeyOfSigningKey(signingKey);
  const { items, contributions, codeFiles } = payloadItems(payloadDir, keyId);
  const all = [...items.values()].flat();
  const keysFor = (include: string[]) => [
    ...new Set(
      [...items.entries()]
        .filter(([file]) =>
          include.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p)),
        )
        .flatMap(([, list]) => list.map((i) => i.item_key)),
    ),
  ];
  const slices: AssembleSlice[] = spec.tiers.map((t) => ({
    id: t.id,
    access: t.access,
    item_keys: keysFor(t.include),
  }));
  // The always-free line for worlds, enforced mechanically.
  const core = slices.find((s) => s.id === CORE_SLICE);
  if (core?.access !== "open")
    throw new Error("a world artifact must have an open `tier:core` slice (the free core)");
  const worldKey = items.get("world/world.json")?.[0]?.item_key;
  if (!worldKey || !core.item_keys.includes(worldKey))
    throw new Error("the open core slice must include world/world.json");
  const manifest = assembleBundle({
    outDir,
    signingKey,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    generation: spec.generation,
    parent: spec.parent ?? null,
    publisher: spec.publisher,
    profile: "public",
    contentProfile: WORLD_PROFILE,
    ...(spec.license ? { license: spec.license } : {}),
    ...(spec.terms ? { terms: spec.terms } : {}),
    redistribution: spec.redistribution ?? "licensee-only",
    commercial_use: spec.commercial_use ?? "licensed",
    access: {
      model: slices.some((s) => s.access === "token") ? "token" : "open",
      entitlement_issuers: spec.entitlement_issuers ?? [],
      ...(spec.chains?.length ? { chains: spec.chains } : {}),
    },
    items: all,
    slices,
    spec: {
      content_profile: WORLD_PROFILE,
      security: {
        // Flag, never hide: installing room code is a world.code act by a reader.
        code_files: codeFiles,
        code_auto_installed: false,
        code_requires_gate: codeFiles.length ? "world.code" : null,
        executable_seed: false,
      },
      tiers: slices.map((s) => ({ id: s.id, access: s.access, items: s.item_keys.length })),
      contributions,
      scans: { publish_secret_and_identifier_scan: "passed" },
    },
    minMarinaVersion: spec.min_marina_version ?? "0.7.0",
    now,
  });
  return { manifest, manifestDigest: manifestDigest(manifest) };
}
