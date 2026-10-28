// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalFederationJson } from "../net/federation-crypto";

export type ArtifactValue =
  | null
  | boolean
  | number
  | string
  | ArtifactValue[]
  | { [key: string]: ArtifactValue };

export type ArtifactEdit =
  | { op: "set" | "append"; path: string; value: ArtifactValue }
  | { op: "replace"; path: string; value: ArtifactValue; reason: string }
  | { op: "remove"; path: string; reason: string }
  | { op: "source"; path: string; ref: string; pick: Record<string, string> }
  | {
      op: "project";
      path: string;
      scopePath: string;
      /** Omit to render the entries already recorded for the current scope. */
      entries?: ArtifactValue[];
      reason: string;
    };

export type ResolvedArtifactEdit = Exclude<ArtifactEdit, { op: "source" }>;

export interface ArtifactRuleInput {
  id: string;
  path: string;
  op: "required" | "eq" | "oneOf" | "lte" | "gte" | "unique" | "setEquals" | "includesSource";
  expected?: ArtifactValue;
  /** A rule applies only in this authored context; older rules remain in history. */
  when?: { path: string; equals: ArtifactValue };
  /** Evidence coverage compares selected source values, not an authored expected answer. */
  selection?: { ref: string; pick: Record<string, string> };
  /** Optional evidence for the contributor's interpretation; never an oracle. */
  source?: { ref: string; quote: string };
}

export interface ArtifactRule extends Omit<ArtifactRuleInput, "source"> {
  authorId: string;
  source?: { ref: string; sourceVersion: string; start: number; end: number };
  selectionVersion?: string;
}

export interface ArtifactProjection {
  path: string;
  scopePath: string;
  batches: Array<{ scope: ArtifactValue; entries: ArtifactValue[]; revision: number }>;
}

export interface TaskArtifact {
  value: ArtifactValue;
  pathRevisions: Record<string, number>;
  rules: ArtifactRule[];
  projections?: ArtifactProjection[];
  lastEdit?: {
    authorId: string;
    operations: Array<{
      op: string;
      path: string;
      reason?: string;
      ref?: string;
      pick?: Record<string, string>;
    }>;
  };
}

export interface ArtifactCheckReport {
  contract: "declared-task-artifact-v1";
  revision: number;
  outcome: "discrepancies" | "unverified" | "matches-declared-checks";
  checks: Array<{
    id: string;
    path: string;
    op: ArtifactRuleInput["op"];
    expected?: ArtifactValue;
    actual?: ArtifactValue;
    evidence: string;
    status: "unverified" | "matches" | "discrepancy" | "inactive";
  }>;
  coverage?: { declared: number; active: number; matched: number; complete: boolean | null };
  projections?: Array<{
    path: string;
    scopePath: string;
    status: "matches" | "discrepancy" | "unverified";
  }>;
  scope: string;
}

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const same = (a: ArtifactValue, b: ArtifactValue) =>
  canonicalFederationJson(a) === canonicalFederationJson(b);

export function validateArtifactValue(value: unknown, depth = 0): asserts value is ArtifactValue {
  if (depth > 64) throw new Error("Artifact JSON is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateArtifactValue(item, depth + 1);
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error(`Unsupported artifact key: ${key}`);
      validateArtifactValue(item, depth + 1);
    }
    return;
  }
  throw new Error("Artifact values must be finite JSON values.");
}

/** JSON Pointer, with explicit root "" and strict array indices. */
export function artifactPath(path: string): string[] {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/")))
    throw new Error('Artifact paths use JSON Pointer, e.g. /items/0/value; root is "".');
  if (path === "") return [];
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?:[^01]|$)/.test(part)) throw new Error("Invalid JSON Pointer escape.");
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (forbidden.has(key)) throw new Error("Unsupported artifact path key.");
      return key;
    });
}

function keyIn(value: ArtifactValue, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key))
    throw new Error("Use an existing numeric array index, or append to the array itself.");
  return Object.hasOwn(value, key);
}

function child(value: ArtifactValue, key: string): ArtifactValue {
  return (value as Record<string, ArtifactValue>)[key]!;
}

export function artifactAt(value: ArtifactValue, path: string) {
  for (const key of artifactPath(path)) {
    if (!keyIn(value, key)) return { present: false as const };
    value = child(value, key);
  }
  return { present: true as const, value };
}

export function artifactPathsOverlap(a: string, b: string): boolean {
  return a === b || a === "" || b === "" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Leaf edits preserve every untouched member, including citation arrays. */
export function editTaskArtifact(
  artifact: TaskArtifact,
  edits: ResolvedArtifactEdit[],
  baseRevision: number,
  nextRevision: number,
): { artifact: TaskArtifact; changedPaths: string[] } {
  if (!Array.isArray(edits) || !edits.length) throw new Error("Supply a nonempty edits array.");
  const result = structuredClone(artifact);
  const changed = new Set<string>();
  for (const input of edits) {
    let edit: Exclude<ResolvedArtifactEdit, { op: "project" }>;
    if (input?.op === "project") {
      artifactPath(input.scopePath);
      if (artifactPathsOverlap(input.path, input.scopePath))
        throw new Error("Projection output and scope paths must not overlap.");
      if (
        Object.entries(artifact.pathRevisions).some(
          ([path, rev]) => rev > baseRevision && artifactPathsOverlap(path, input.scopePath),
        )
      )
        throw new Error("Projection scope changed; read it before retrying.");
      const scope = artifactAt(result.value, input.scopePath);
      if (!scope.present) throw new Error("Projection scope is missing.");
      let projection = result.projections?.find((entry) => entry.path === input.path);
      if (projection && projection.scopePath !== input.scopePath)
        throw new Error("A projection's scope path cannot change; use a different output path.");
      if (!projection) {
        projection = { path: input.path, scopePath: input.scopePath, batches: [] };
        (result.projections ??= []).push(projection);
      }
      const batch = projection.batches.find((entry) => same(entry.scope, scope.value));
      if (input.entries !== undefined) {
        if (!Array.isArray(input.entries)) throw new Error("Projection entries must be an array.");
        validateArtifactValue(input.entries);
        const entries = [
          ...new Map(
            input.entries.map((entry) => [canonicalFederationJson(entry), entry]),
          ).values(),
        ];
        if (!batch || !same(batch.entries, entries)) {
          projection.batches = projection.batches.filter(
            (entry) => !same(entry.scope, scope.value),
          );
          projection.batches.push({
            scope: structuredClone(scope.value),
            entries: structuredClone(entries),
            revision: nextRevision,
          });
          changed.add(input.path);
        }
      }
      const selected = projection.batches.find((entry) => same(entry.scope, scope.value));
      if (!selected)
        throw new Error(
          "No entries recorded for this scope; supply entries explicitly (including an empty array).",
        );
      edit = { op: "replace", path: input.path, value: selected.entries, reason: input.reason };
    } else edit = input;
    if (!edit || !["set", "append", "replace", "remove"].includes(edit.op))
      throw new Error("Artifact operations are set, append, replace and remove.");
    const parts = artifactPath(edit.path);
    if (edit.op === "replace" || edit.op === "remove") {
      if (typeof edit.reason !== "string" || !edit.reason.trim())
        throw new Error("Replacing a container or removing content requires an explicit reason.");
    }
    if (edit.op !== "remove") validateArtifactValue(edit.value);
    // Check against the original history, not earlier edits in this same atomic batch.
    const conflict = Object.entries(artifact.pathRevisions).find(
      ([path, revision]) => revision > baseRevision && artifactPathsOverlap(path, edit.path),
    );
    if (conflict)
      throw new Error(
        `Artifact changed at ${conflict[0] || "root"}; read it before retrying this edit.`,
      );
    let parent = result.value;
    for (const key of parts.slice(0, -1)) {
      if (!keyIn(parent, key)) throw new Error(`Artifact parent does not exist: ${edit.path}`);
      parent = child(parent, key);
    }
    const key = parts.at(-1);
    const prior = artifactAt(result.value, edit.path);
    if (edit.op === "append") {
      if (!prior.present || !Array.isArray(prior.value))
        throw new Error("Append requires an existing array.");
      if (!prior.value.some((value) => same(value, edit.value))) {
        prior.value.push(structuredClone(edit.value));
        changed.add(edit.path);
      }
    } else if (edit.op === "remove") {
      if (key === undefined || !prior.present)
        throw new Error("Remove requires an existing non-root path.");
      if (Array.isArray(parent)) {
        parent.splice(Number(key), 1);
        // Removing an array row changes the meaning of every subsequent numeric index.
        changed.add(edit.path.slice(0, edit.path.lastIndexOf("/")));
      } else {
        delete (parent as Record<string, ArtifactValue>)[key];
        changed.add(edit.path);
      }
    } else {
      if (prior.present && same(prior.value, edit.value)) continue;
      if (
        edit.op === "set" &&
        prior.present &&
        prior.value !== null &&
        typeof prior.value === "object"
      )
        throw new Error(
          "Set edits a value or adds a member. Edit child paths to preserve existing content, or use replace with a reason.",
        );
      if (key === undefined) result.value = structuredClone(edit.value);
      else {
        if (!parent || typeof parent !== "object")
          throw new Error("Artifact parent is not a container.");
        if (Array.isArray(parent) && !keyIn(parent, key))
          throw new Error("Use append to add an array row; sparse arrays are not supported.");
        (parent as Record<string, ArtifactValue>)[key] = structuredClone(edit.value);
      }
      changed.add(edit.path);
    }
  }
  validateArtifactValue(result.value);
  for (const path of changed) result.pathRevisions[path] = nextRevision;
  return { artifact: result, changedPaths: [...changed] };
}

export function validateArtifactRule(rule: ArtifactRuleInput): void {
  if (!rule || typeof rule.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(rule.id))
    throw new Error("A check needs a stable name, starting with a letter.");
  artifactPath(rule.path);
  if (
    !["required", "eq", "oneOf", "lte", "gte", "unique", "setEquals", "includesSource"].includes(
      rule.op,
    )
  )
    throw new Error("Unknown artifact check operator.");
  if (rule.when) {
    artifactPath(rule.when.path);
    validateArtifactValue(rule.when.equals);
  }
  if (rule.op === "includesSource") {
    if (!rule.selection || rule.expected !== undefined || rule.source !== undefined)
      throw new Error(
        "includesSource requires a selection, without an expected answer or source quotation.",
      );
    validateArtifactSelection(rule.selection);
  } else {
    if (rule.selection !== undefined) throw new Error("Selections require includesSource.");
    if (rule.op !== "required" && rule.op !== "unique") validateArtifactValue(rule.expected);
  }
  if (["oneOf", "setEquals"].includes(rule.op) && !Array.isArray(rule.expected))
    throw new Error("oneOf and setEquals require an expected array.");
  if (["lte", "gte"].includes(rule.op) && typeof rule.expected !== "number")
    throw new Error("Numeric checks require a finite expected number.");
}

export function validateArtifactSelection(selection: {
  ref: string;
  pick: Record<string, string>;
}): void {
  if (
    !selection ||
    typeof selection.ref !== "string" ||
    !selection.ref.trim() ||
    !selection.pick ||
    typeof selection.pick !== "object" ||
    Array.isArray(selection.pick) ||
    !Object.keys(selection.pick).length
  )
    throw new Error(
      "Supply a source reference and nonempty pick map of output names to source JSON Pointers.",
    );
  for (const [key, path] of Object.entries(selection.pick)) {
    if (forbidden.has(key)) throw new Error("Unsupported selection key.");
    artifactPath(path);
  }
}

export function artifactRuleMatches(
  value: ArtifactValue,
  rule: Omit<ArtifactRuleInput, "source">,
): boolean {
  // Source coverage needs the access-checked resolver in TaskWork.
  if (rule.op === "includesSource") return false;
  // A valid declared path can become incompatible after a container changes shape.
  // Mutation paths remain strict; advisory checks report a mismatch rather than abort.
  let actual: ReturnType<typeof artifactAt>;
  try {
    actual = artifactAt(value, rule.path);
  } catch {
    return false;
  }
  if (!actual.present) return false;
  if (rule.op === "required") return actual.value !== null && actual.value !== "";
  if (rule.op === "eq") return same(actual.value, rule.expected!);
  if (rule.op === "oneOf")
    return (rule.expected as ArtifactValue[]).some((v) => same(v, actual.value));
  if (rule.op === "lte" || rule.op === "gte")
    return (
      typeof actual.value === "number" &&
      (rule.op === "lte"
        ? actual.value <= (rule.expected as number)
        : actual.value >= (rule.expected as number))
    );
  if (!Array.isArray(actual.value)) return false;
  const items = actual.value.map((v) => canonicalFederationJson(v));
  const actualSet = new Set(items);
  if (items.length !== actualSet.size) return false;
  if (rule.op === "unique") return true;
  const expected = new Set(
    (rule.expected as ArtifactValue[]).map((v) => canonicalFederationJson(v)),
  );
  return expected.size === actualSet.size && [...expected].every((v) => actualSet.has(v));
}
