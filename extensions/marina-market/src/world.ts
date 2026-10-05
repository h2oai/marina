// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina.world.v1`: the content profile for a whole world carried inside a
 * `marina.learned.v1` envelope. Payload layout (all paths relative to the bundle):
 *
 *   world/world.json      DATA ONLY: name, description, start room, rooms (text +
 *                         exits + grid), guide notes, quest descriptions
 *   world/rooms/<id>.ts   OPTIONAL room source code — inert text. Never compiled
 *                         or registered by this extension; installing it is the
 *                         existing `world.code`-gated path, by a person who read it
 *   roles/*.json          RoleBundle v1 (create-only on import, `upstream.` prefix)
 *   lessons.jsonl, conventions.jsonl, defaults.json, skills/*.md
 *                         the curated memory slice, in the learned layout
 *   contributions.jsonl   OPTIONAL itemised contribution vectors, pseudonymous
 *   spec.json             generated spec sheet
 *
 * Security: a world module in Marina is code (`WorldDefinition.seed`, room
 * handlers). This profile deliberately carries NO executable seed, no
 * `afterAgentsReady`, and no `autoBootstrap` commands; `world.json` rejects
 * unknown keys so a future field cannot smuggle behaviour in.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  decodeRoleBundle,
  encodeRoleBundle,
  type RoleBundle,
} from "../../../src/agent/role-bundle";
import { canonicalFederationJson } from "../../../src/net/federation-crypto";
import {
  type AccessModel,
  type CommercialUse,
  keyIdOf,
  LEARNED_SCHEMA,
  type LearnedManifest,
  manifestDigest,
  type Redistribution,
  type Slice,
  sha256Hex,
  signWithKey,
  validateManifest,
} from "./envelope";

export const WORLD_PROFILE = "marina.world.v1";

export interface WorldRoom {
  id: string;
  short: string;
  long?: string;
  exits?: Record<string, string>;
  grid?: { row: number; col: number };
}

export interface WorldDocument {
  name: string;
  description: string;
  start_room: string;
  rooms: WorldRoom[];
  guide_notes?: Array<{ content: string; importance: number; type: string }>;
  quests?: Array<{ id: string; name: string; description: string }>;
}

/** Publisher-side description of an artifact to assemble from a payload directory. */
export interface WorldPublishSpec {
  name: string;
  description: string;
  version: string;
  generation: number;
  parent?: { version: string; manifest_digest: string } | null;
  /** Default: proprietary (`LicenseRef-<publisher>-proprietary`), per Jeff's decision. */
  license?: string;
  terms?: { url: string; sha256: string };
  attribution_required?: boolean;
  redistribution?: Redistribution;
  commercial_use?: CommercialUse;
  profile?: "internal" | "public";
  min_marina_version?: string;
  publisher: { name: string; url?: string };
  entitlement_issuers?: string[];
  chains?: Array<{ family: string; chain_id: number | string; license_contract: string }>;
  /** Tiers: `core` (must be open) plus any paid tiers. Files are payload-relative globs-free paths or directory prefixes ending in `/`. */
  tiers: Array<{ id: string; access: AccessModel; include: string[] }>;
}

const ROOM_ID = /^[a-z0-9][a-z0-9_/-]{0,79}$/;
const WORLD_KEYS = new Set(["name", "description", "start_room", "rooms", "guide_notes", "quests"]);
const ROOM_KEYS = new Set(["id", "short", "long", "exits", "grid"]);
const MAX_TEXT = 8_000;

function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Validate `world/world.json` strictly. Returns problems (empty = valid). */
export function validateWorldDocument(doc: WorldDocument): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== "object") return ["world.json must be an object"];
  for (const key of Object.keys(doc))
    if (!WORLD_KEYS.has(key)) problems.push(`world.json: unsupported key "${key}" (data only)`);
  if (!text(doc.name, 64)) problems.push("world.json: name required");
  if (typeof doc.description !== "string" || doc.description.length > MAX_TEXT)
    problems.push("world.json: description invalid");
  if (!Array.isArray(doc.rooms) || doc.rooms.length === 0 || doc.rooms.length > 500)
    return [...problems, "world.json: rooms must be a non-empty array (≤ 500)"];
  const ids = new Set<string>();
  for (const room of doc.rooms) {
    for (const key of Object.keys(room))
      if (!ROOM_KEYS.has(key)) problems.push(`room ${room.id}: unsupported key "${key}"`);
    if (!ROOM_ID.test(room.id ?? "") || ids.has(room.id))
      problems.push(`room id invalid or duplicate: ${room.id}`);
    ids.add(room.id);
    if (!text(room.short, 200)) problems.push(`room ${room.id}: short required`);
    if (room.long !== undefined && !text(room.long)) problems.push(`room ${room.id}: long invalid`);
  }
  for (const room of doc.rooms)
    for (const [dir, target] of Object.entries(room.exits ?? {}))
      if (!/^[a-z]{1,16}$/.test(dir) || !ids.has(target))
        problems.push(`room ${room.id}: exit ${dir} → unknown room ${target}`);
  if (!ids.has(doc.start_room)) problems.push("world.json: start_room must be one of rooms");
  for (const note of doc.guide_notes ?? [])
    if (!text(note.content) || typeof note.importance !== "number" || !text(note.type, 32))
      problems.push("world.json: guide note invalid");
  for (const quest of doc.quests ?? [])
    if (!text(quest.id, 64) || !text(quest.name, 200) || !text(quest.description))
      problems.push("world.json: quest description invalid");
  return problems;
}

/**
 * Mechanical scans over every text payload file. A hit REFUSES publication
 * (drop, never redact in place). Conservative by design: it catches key-shaped
 * secrets and host identifiers, not every possible leak — publishers still own
 * their allow-list (design §H.3).
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["provider api key", /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["env assignment of a secret", /\b[A-Z][A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD)\s*=\s*\S{8,}/],
  ["home path", /\/(home|Users)\/[A-Za-z0-9._-]+\//],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];

export function scanText(file: string, body: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(
    ([label]) => `${file}: ${label}`,
  );
}

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

/** Describe what a payload contains, for the spec sheet and the security flags. */
export function describePayload(files: string[]): {
  code_files: string[];
  roles: string[];
  memory_files: string[];
} {
  return {
    code_files: files.filter((f) => f.startsWith("world/rooms/") && f.endsWith(".ts")),
    roles: files.filter((f) => f.startsWith("roles/") && f.endsWith(".json")),
    memory_files: files.filter(
      (f) =>
        ["lessons.jsonl", "conventions.jsonl", "defaults.json"].includes(f) ||
        f.startsWith("skills/"),
    ),
  };
}

const GENERATED = new Set(["manifest.json", "signature.json", "spec.json"]);
const ALLOWED_PAYLOAD =
  /^(world\/world\.json|world\/rooms\/[a-z0-9_-]+\.ts|roles\/[A-Za-z0-9_.-]+\.json|lessons\.jsonl|conventions\.jsonl|defaults\.json|contributions\.jsonl|skills\/[A-Za-z0-9_.-]+\.md)$/;

/** Validate a contribution line: pseudonymous participants, bounded, no content. */
export function validateContribution(line: unknown): string | null {
  const c = line as {
    item_key?: unknown;
    participants?: Array<{
      id?: unknown;
      kind?: unknown;
      role?: unknown;
      weight?: unknown;
      method?: unknown;
    }>;
  };
  if (!c || typeof c.item_key !== "string" || !Array.isArray(c.participants))
    return "contribution needs item_key and participants[]";
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

/**
 * Validate a payload directory as `marina.world.v1`. Returns the file list and
 * flags, or throws with every problem found.
 */
export function validateWorldPayload(dir: string): {
  files: string[];
  world: WorldDocument;
  flags: ReturnType<typeof describePayload>;
} {
  // Generated files from an earlier publish run are rebuilt, never re-validated as payload.
  const files = listFiles(dir).filter((f) => !GENERATED.has(f));
  const problems: string[] = [];
  for (const file of files)
    if (!ALLOWED_PAYLOAD.test(file)) problems.push(`file not allowed in a world payload: ${file}`);
  if (!files.includes("world/world.json")) problems.push("world/world.json is required");
  let world = {} as WorldDocument;
  for (const file of files) {
    const body = readFileSync(join(dir, file), "utf8");
    problems.push(...scanText(file, body));
    try {
      if (file === "world/world.json") {
        world = JSON.parse(body) as WorldDocument;
        problems.push(...validateWorldDocument(world));
      } else if (file.startsWith("roles/")) {
        // Same validation as `role import` (create-only, bounded), on the JSON form.
        const decoded = decodeRoleBundle(encodeRoleBundle(JSON.parse(body) as RoleBundle));
        if ("error" in decoded) problems.push(`${file}: ${decoded.error}`);
      } else if (file.endsWith(".jsonl")) {
        for (const line of body.split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line) as unknown;
          if (file === "contributions.jsonl") {
            const err = validateContribution(parsed);
            if (err) problems.push(`${file}: ${err}`);
          }
        }
      } else if (file.endsWith(".json")) JSON.parse(body);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  if (problems.length) throw new Error(`world payload refused:\n- ${problems.join("\n- ")}`);
  return { files, world, flags: describePayload(files) };
}

function tierFiles(files: string[], include: string[]): string[] {
  return files.filter((file) =>
    include.some((pattern) =>
      pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern,
    ),
  );
}

/**
 * Assemble and sign a world artifact: validate the payload, generate
 * `spec.json`, build the manifest and write `manifest.json` + `signature.json`
 * into `payloadDir`. The private key is the publisher's (read from a file the
 * operator controls); it is used once and never stored.
 */
export function publishWorld(
  payloadDir: string,
  spec: WorldPublishSpec,
  publisherKeyPem: string,
  now = new Date(),
): { manifest: LearnedManifest; manifestDigest: string } {
  const { files, world, flags } = validateWorldPayload(payloadDir);
  const tiers = spec.tiers ?? [];
  const core = tiers.find((tier) => tier.id === "core");
  // The always-free line, enforced mechanically: every world artifact has a
  // `core` tier that is OPEN and carries the world document.
  if (core?.access !== "open")
    throw new Error("a world artifact must have an open `core` tier (the free core)");
  const slices: Slice[] = tiers.map((tier) => ({
    id: tier.id,
    access: tier.access,
    selector: { tier: tier.id },
    files: tierFiles(files, tier.include),
  }));
  if (!slices.find((slice) => slice.id === "core")?.files.includes("world/world.json"))
    throw new Error("the core tier must include world/world.json");

  const key = createPrivateKey(publisherKeyPem);
  const publicKey = Buffer.from(
    createPublicKey(key).export({ format: "der", type: "spki" }),
  ).toString("base64");
  const keyId = keyIdOf(publicKey);
  const slug = spec.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const digests: Record<string, string> = {};
  for (const file of files) digests[file] = sha256Hex(readFileSync(join(payloadDir, file)));

  const specSheet = {
    content_profile: WORLD_PROFILE,
    rooms: world.rooms.length,
    guide_notes: world.guide_notes?.length ?? 0,
    tiers: slices.map((slice) => ({
      id: slice.id,
      access: slice.access,
      files: slice.files.length,
      bytes: slice.files.reduce((sum, f) => sum + statSync(join(payloadDir, f)).size, 0),
    })),
    security: {
      // Flag, never hide: code present means installing it is a world.code act.
      code_files: flags.code_files,
      code_auto_installed: false,
      code_requires_gate: flags.code_files.length ? "world.code" : null,
      executable_seed: false,
    },
    roles: flags.roles.length,
    memory_files: flags.memory_files,
    contributions: files.includes("contributions.jsonl")
      ? readFileSync(join(payloadDir, "contributions.jsonl"), "utf8").split("\n").filter(Boolean)
          .length
      : 0,
    scans: { secret_and_identifier_scan: "passed" },
  };
  const specBytes = `${JSON.stringify(specSheet, null, 2)}\n`;
  writeFileSync(join(payloadDir, "spec.json"), specBytes);
  digests["spec.json"] = sha256Hex(specBytes);
  for (const slice of slices) slice.files.push("spec.json");

  const manifest: LearnedManifest = {
    schema: LEARNED_SCHEMA,
    content_profile: WORLD_PROFILE,
    artifact_id: `marina-world:${keyId}/${slug}`,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    generation: spec.generation,
    parent: spec.parent ?? null,
    lineage: spec.parent ? [spec.parent] : [],
    created_at: now.toISOString(),
    min_marina_version: spec.min_marina_version ?? "0.7.0",
    profile: spec.profile ?? "public",
    publisher: {
      name: spec.publisher.name,
      key_id: keyId,
      public_key: publicKey,
      url: spec.publisher.url,
    },
    license:
      spec.license ??
      `LicenseRef-${spec.publisher.name.replace(/[^A-Za-z0-9.-]+/g, "-")}-proprietary`,
    terms: spec.terms,
    attribution_required: spec.attribution_required ?? true,
    redistribution: spec.redistribution ?? "licensee-only",
    commercial_use: spec.commercial_use ?? "licensed",
    access: {
      model: slices.some((slice) => slice.access === "token") ? "token" : "open",
      entitlement_issuers: spec.entitlement_issuers,
      chains: spec.chains,
    },
    slices,
    files: digests,
    counts: { rooms: world.rooms.length, files: files.length + 1, roles: flags.roles.length },
  };
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`invalid manifest: ${problems.join("; ")}`);
  const signature = signWithKey(manifest as unknown as Record<string, unknown>, publisherKeyPem);
  mkdirSync(payloadDir, { recursive: true });
  // Canonical bytes on disk too, so `sha256(manifest.json)` equals the digest anchored on chain.
  writeFileSync(join(payloadDir, "manifest.json"), canonicalFederationJson(manifest));
  writeFileSync(join(payloadDir, "signature.json"), `${JSON.stringify(signature, null, 2)}\n`);
  return { manifest, manifestDigest: manifestDigest(manifest) };
}
