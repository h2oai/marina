// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A role and the traits it is built from, as one portable bundle — how a
 * candidate role travels to a child world for a trial (`world seed-role`) or
 * between any two Marinas (`role export` / `role import`). Lossless: trait
 * prompts and capability metadata survive, which rebuilding the role from
 * `role create` / `trait create` text would not.
 *
 * Import only ever CREATES. A role that already exists is refused, and so is
 * a trait that exists with different content — the imported role would
 * silently compose from someone else's trait. Changing existing definitions
 * stays behind `role edit` and the `role.edit` gate.
 */

import { getErrorMessage } from "../engine/errors";
import type { MarinaDB, TraitCapabilities } from "../persistence/database";

export interface RoleBundle {
  v: 1;
  role: {
    name: string;
    description: string;
    traits: string[];
    guidelines: string[];
    focus: string[];
    tone: string;
    origin: string;
  };
  traits: Array<{
    name: string;
    category: string;
    prompt: string;
    capabilities: TraitCapabilities;
  }>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_TRAITS = 32;
const MAX_TEXT = 8_000;

function list(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function caps(raw: string): TraitCapabilities {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as TraitCapabilities) : {};
  } catch {
    return {};
  }
}

export function exportRoleBundle(
  db: Pick<MarinaDB, "getRole" | "getTrait">,
  name: string,
): RoleBundle | undefined {
  const role = db.getRole(name);
  if (!role) return undefined;
  const traitNames = list(role.traits);
  return {
    v: 1,
    role: {
      name: role.name,
      description: role.description ?? "",
      traits: traitNames,
      guidelines: list(role.guidelines),
      focus: list(role.focus),
      tone: role.tone ?? "",
      origin: role.origin ?? "",
    },
    traits: traitNames
      .map((t) => db.getTrait(t))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({
        name: t.name,
        category: t.category,
        prompt: t.prompt,
        capabilities: caps(t.capabilities),
      })),
  };
}

/** Traits the role names that were not found where it was exported (it will compose without them). */
export function missingTraits(bundle: RoleBundle): string[] {
  const have = new Set(bundle.traits.map((t) => t.name));
  return bundle.role.traits.filter((t) => !have.has(t));
}

export function encodeRoleBundle(bundle: RoleBundle): string {
  return Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url");
}

export function decodeRoleBundle(text: string): RoleBundle | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text.trim(), "base64url").toString("utf8"));
  } catch (err) {
    return { error: `not a role bundle (${getErrorMessage(err)})` };
  }
  const b = raw as Partial<RoleBundle>;
  if (b?.v !== 1 || !b.role || !Array.isArray(b.traits)) return { error: "not a v1 role bundle" };
  if (!NAME.test(String(b.role.name))) return { error: "bad role name" };
  if (b.traits.length > MAX_TRAITS) return { error: `more than ${MAX_TRAITS} traits` };
  for (const t of b.traits) {
    if (!NAME.test(String(t?.name)) || typeof t.prompt !== "string" || t.prompt.length > MAX_TEXT) {
      return { error: `bad trait ${String(t?.name)}` };
    }
  }
  return b as RoleBundle;
}

export type ImportResult =
  | { ok: true; role: string; traitsCreated: string[]; traitsShared: string[] }
  | { ok: false; reason: string };

export function importRoleBundle(
  db: Pick<MarinaDB, "getRole" | "getTrait" | "saveRole" | "saveTrait">,
  bundle: RoleBundle,
  createdBy: string,
): ImportResult {
  if (db.getRole(bundle.role.name)) {
    return {
      ok: false,
      reason: `role "${bundle.role.name}" already exists here — import only creates`,
    };
  }
  const traitsCreated: string[] = [];
  const traitsShared: string[] = [];
  const toCreate: RoleBundle["traits"] = [];
  for (const t of bundle.traits) {
    const existing = db.getTrait(t.name);
    if (!existing) {
      toCreate.push(t);
      continue;
    }
    const same =
      existing.prompt === t.prompt &&
      existing.category === t.category &&
      JSON.stringify(caps(existing.capabilities)) === JSON.stringify(t.capabilities ?? {});
    if (!same) {
      return {
        ok: false,
        reason: `trait "${t.name}" exists here with different content — the role would not compose as exported`,
      };
    }
    traitsShared.push(t.name);
  }
  for (const t of toCreate) {
    db.saveTrait({ ...t, createdBy });
    traitsCreated.push(t.name);
  }
  db.saveRole({ ...bundle.role, createdBy });
  return { ok: true, role: bundle.role.name, traitsCreated, traitsShared };
}
