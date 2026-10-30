// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EvidenceSource } from "../decisions/evidence";
import { type ArtifactValue, artifactAt, artifactPath } from "./task-artifact";
import { artifactDigest } from "./task-artifact-review";

/** An explicit schema mapping, never inferred from field names or a hidden answer key. */
export interface ArtifactEvidencePlan {
  requirements: { ref: string; path: string; key: string; bundles: string };
  context?: { source: string; target: string };
  targets: { path: string; key: string; citations: string; document: string; quote: string };
  sources: Array<{ ref: string; document: string; text: string }>;
  /** The author maps named facts to exact readable source selections. Entailment is not proven. */
  bindings: Array<{ fact: string; ref: string; path: string }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Identity of one source's authored interpretation, excluding unrelated peer mappings. */
export function evidenceReferenceBinding(plan: ArtifactEvidencePlan, ref: string) {
  return artifactDigest([
    plan.requirements.ref === ref ? [plan.requirements, plan.context?.source ?? null] : null,
    plan.sources.filter((source) => source.ref === ref),
    plan.bindings.filter((binding) => binding.ref === ref),
  ]);
}

export function validateEvidencePlan(plan: ArtifactEvidencePlan): void {
  if (
    !object(plan) ||
    !object(plan.requirements) ||
    !object(plan.targets) ||
    !Array.isArray(plan.sources) ||
    !plan.sources.length ||
    !Array.isArray(plan.bindings)
  )
    throw new Error(
      "Supply requirements, targets, sources and fact bindings for the evidence audit.",
    );
  const ref = (value: unknown) => {
    if (typeof value !== "string" || !value.trim())
      throw new Error("Evidence needs a source reference.");
  };
  ref(plan.requirements.ref);
  for (const path of [
    plan.requirements.path,
    plan.requirements.key,
    plan.requirements.bundles,
    plan.targets.path,
    plan.targets.key,
    plan.targets.citations,
    plan.targets.document,
    plan.targets.quote,
  ])
    artifactPath(path);
  if (plan.context !== undefined) {
    if (!object(plan.context)) throw new Error("Invalid evidence context mapping.");
    artifactPath(plan.context.source);
    artifactPath(plan.context.target);
  }
  const refs = new Set<string>();
  for (const source of plan.sources) {
    if (!object(source)) throw new Error("Invalid evidence source mapping.");
    ref(source.ref);
    if (refs.has(source.ref)) throw new Error("Evidence sources must have distinct references.");
    refs.add(source.ref);
    artifactPath(source.document);
    artifactPath(source.text);
  }
  for (const binding of plan.bindings) {
    if (
      !object(binding) ||
      typeof binding.fact !== "string" ||
      !binding.fact.trim() ||
      !refs.has(binding.ref)
    )
      throw new Error("Each fact binding needs a named fact and a listed source.");
    artifactPath(binding.path);
  }
}

const at = (value: ArtifactValue, path: string): ArtifactValue | undefined => {
  try {
    const selected = artifactAt(value, path);
    return selected.present ? selected.value : undefined;
  } catch {
    return undefined;
  }
};
const strings = (value: ArtifactValue | undefined): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

/** Audit all selected quotations, including extras, and every source-declared obligation. */
export function auditArtifactEvidence(
  value: ArtifactValue,
  plan: ArtifactEvidencePlan,
  resolve: (ref: string) => EvidenceSource,
  versions?: Record<string, string | null>,
) {
  validateEvidencePlan(plan);
  const refs = [...new Set([plan.requirements.ref, ...plan.sources.map((s) => s.ref)])];
  const sources = new Map(refs.map((ref) => [ref, resolve(ref)]));
  const parsed = new Map<string, ArtifactValue>();
  for (const [ref, source] of sources) {
    if (source.status !== "current" || source.text === undefined || !source.version) continue;
    if (versions && versions[ref] !== source.version) continue;
    let data: unknown;
    try {
      data = JSON.parse(source.text);
    } catch {
      data = source.text;
    }
    // Source documents can contain unrelated metadata that is not an artifact field.
    // Pointers remain validated and every selected identifier/quotation is typed below.
    parsed.set(ref, data as ArtifactValue);
  }
  const findings: Array<{ id: string; path: string; message: string }> = [];
  const add = (id: string, path: string, message: string) => findings.push({ id, path, message });
  const unavailable = refs.filter((ref) => !parsed.has(ref));
  for (const ref of unavailable)
    add(
      `source:${ref}`,
      "",
      `Source ${ref} is unavailable, not current or changed since binding. Read it and explicitly renew the plan when appropriate; no content was disclosed.`,
    );
  const docs = plan.sources.flatMap((mapping) => {
    const data = parsed.get(mapping.ref);
    if (data === undefined) return [];
    const id = at(data, mapping.document),
      text = strings(at(data, mapping.text));
    if (typeof id !== "string" || !id.trim() || !text.length) {
      add(
        `mapping:${mapping.ref}`,
        "",
        `Source ${mapping.ref} has no document identifier or readable text at the declared paths.`,
      );
      return [];
    }
    return [{ ref: mapping.ref, id, text, data }];
  });
  const ambiguous = new Set(
    docs.filter((d) => docs.filter((other) => other.id === d.id).length > 1).map((d) => d.id),
  );
  for (const id of ambiguous)
    add(
      `ambiguous:${id}`,
      "",
      `Multiple sources claim document ${id}; resolve the ambiguous mapping.`,
    );
  const requirementsData = parsed.get(plan.requirements.ref);
  const requirements =
    requirementsData === undefined ? undefined : at(requirementsData, plan.requirements.path);
  if (plan.context) {
    const sourceContext =
      requirementsData === undefined ? undefined : at(requirementsData, plan.context.source);
    const targetContext = at(value, plan.context.target);
    if (
      sourceContext === undefined ||
      targetContext === undefined ||
      artifactDigest(sourceContext) !== artifactDigest(targetContext)
    )
      add(
        "context",
        plan.context.target,
        "The requirement source and deliverable have different or missing contexts. Select the current contract and renew fact bindings; no context was coerced.",
      );
  }
  const targets = at(value, plan.targets.path);
  if (!Array.isArray(requirements) || !requirements.length)
    add(
      "requirements",
      plan.targets.path,
      "No nonempty source requirement list is available; an empty audit is unverified.",
    );
  if (!Array.isArray(targets))
    add(
      "targets",
      plan.targets.path,
      "The selected deliverable entries are missing or are not an array.",
    );
  const quoteChecks: Array<{
    path: string;
    document?: string;
    status: "authentic" | "invalid" | "unverified";
  }> = [];
  const rows = (Array.isArray(targets) ? targets : []).map((row, index) => {
    const path = `${plan.targets.path}/${index}`;
    const key = at(row, plan.targets.key);
    const citations = at(row, plan.targets.citations);
    const authentic: Array<{ ref: string; quote: string }> = [];
    if (!Array.isArray(citations))
      add(
        `citations:${index}`,
        path,
        "This entry needs its own citation array; support in a sibling entry is not inherited.",
      );
    for (const [i, citation] of (Array.isArray(citations) ? citations : []).entries()) {
      const cp = `${path}${plan.targets.citations}/${i}`;
      const id = at(citation, plan.targets.document),
        quote = at(citation, plan.targets.quote);
      const doc =
        typeof id === "string" && !ambiguous.has(id) ? docs.find((d) => d.id === id) : undefined;
      const valid =
        typeof quote === "string" &&
        !!quote.trim() &&
        !!doc?.text.some((text) => text.includes(quote));
      const status = valid
        ? "authentic"
        : typeof quote !== "string" || !quote.trim()
          ? "invalid"
          : !doc
            ? "unverified"
            : "invalid";
      quoteChecks.push({ path: cp, ...(typeof id === "string" ? { document: id } : {}), status });
      if (valid) authentic.push({ ref: doc!.ref, quote: quote as string });
      else
        add(
          `quote:${index}:${i}`,
          cp,
          status === "unverified"
            ? "Quotation cannot be verified against an unambiguous readable original in this plan. Preserve it while seeking the original or a deliberate source mapping; unavailable evidence does not prove a quotation false."
            : "Quotation does not match its selected readable original or is malformed. Re-read that original and copy an exact selection; preserve other valid evidence.",
        );
    }
    const facts = new Set<string>();
    for (const binding of plan.bindings) {
      const doc = docs.find((d) => d.ref === binding.ref);
      if (!doc || ambiguous.has(doc.id)) continue;
      const selection = at(doc.data, binding.path);
      if (
        typeof selection !== "string" ||
        !selection.trim() ||
        !doc.text.some((text) => text.includes(selection))
      )
        continue;
      if (authentic.some((c) => c.ref === binding.ref && c.quote.includes(selection)))
        facts.add(binding.fact);
    }
    return { key, path, facts };
  });
  const obligations: Array<{ id: string; path: string; missing: string[][]; complete: boolean }> =
    [];
  const seen = new Set<string>();
  for (const [index, requirement] of (Array.isArray(requirements) ? requirements : []).entries()) {
    const id = at(requirement, plan.requirements.key),
      bundles = at(requirement, plan.requirements.bundles);
    if (
      typeof id !== "string" ||
      !id.trim() ||
      seen.has(id) ||
      !Array.isArray(bundles) ||
      !bundles.length ||
      bundles.some(
        (bundle) =>
          !Array.isArray(bundle) ||
          !bundle.length ||
          bundle.some((f) => typeof f !== "string" || !f.trim()),
      )
    ) {
      add(
        `requirement:${index}`,
        plan.targets.path,
        "A source requirement needs a unique key and nonempty alternatives of named facts.",
      );
      continue;
    }
    seen.add(id);
    const matching = rows.filter((row) => row.key === id),
      row = matching.length === 1 ? matching[0] : undefined;
    const missing = (bundles as string[][]).map((bundle) =>
      bundle.filter((fact) => !row?.facts.has(fact)),
    );
    const complete = !!row && missing.some((bundle) => !bundle.length);
    obligations.push({ id, path: row?.path ?? plan.targets.path, missing, complete });
    if (!complete)
      add(
        `obligation:${id}`,
        row?.path ?? plan.targets.path,
        `${id}: ${matching.length !== 1 ? "need exactly one deliverable entry; " : ""}missing facts by allowed bundle: ${JSON.stringify(missing)}. Bind each fact to an exact source selection and cite it in THIS entry. A derived value does not inherit a sibling's policy or premises.`,
      );
  }
  for (const row of rows)
    if (typeof row.key !== "string" || !seen.has(row.key))
      add(
        `unexpected:${row.path}`,
        row.path,
        "Entry does not match a source-declared requirement.",
      );
  return {
    advisory: true as const,
    fingerprint: artifactDigest([
      plan,
      value,
      // Expected private versions stay in TaskWork's internal cache identity, never a
      // public digest that could be tested against guesses of an inaccessible source.
      [...sources].map(([ref, s]) => [ref, s.status, s.version ?? null, parsed.has(ref)]),
    ]),
    outcome: findings.length
      ? unavailable.length || quoteChecks.some((quote) => quote.status === "unverified")
        ? "unverified"
        : "discrepancies"
      : "matches-declared-evidence",
    quotations: quoteChecks,
    obligations,
    findings,
    scope:
      "All selected citations and source-declared fact bundles were checked against caller-bound exact selections. Bindings do not prove entailment, current semantic validity or completeness of the task's own contract. No edits, approvals or model calls were made.",
  };
}
