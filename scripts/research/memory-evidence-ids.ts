// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Citation identity, not an entailment or source-body-read check. A record's
 * explicit source_ids are returned provenance. Payload/metadata IDs are not. */
export function returnedEvidenceIds(results: unknown[]): Set<string> {
  const ids = new Set<string>();
  const inspect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string") {
      if (
        typeof object.space_id === "string" &&
        Number.isInteger(object.version) &&
        typeof object.content === "string"
      ) {
        ids.add(object.id);
        if (Array.isArray(object.source_ids))
          for (const id of object.source_ids) if (typeof id === "string") ids.add(id);
        return;
      }
      if (
        typeof object.content_hash === "string" &&
        ((Number.isInteger(object.seq) &&
          (typeof object.excerpt === "string" || Object.hasOwn(object, "body"))) ||
          (object.representation === "utf8-source-text-v1" && typeof object.text === "string"))
      ) {
        ids.add(object.id);
        return;
      }
    }
    // Traverse API result containers only, never arbitrary user-authored fields.
    for (const key of ["trace", "evidence", "results", "edges", "record"]) inspect(object[key]);
  };
  inspect(results);
  return ids;
}

export type UtilityGroundingRow = {
  correct: boolean;
  cited: boolean;
  grounded: boolean;
  functional: boolean | null;
  supported_success: boolean;
  citations: unknown[];
  trace: { result: unknown }[];
};

/** Regrade saved responses without changing exact-answer/support/functionality
 * decisions or making model calls. Preserve the prior citation scores for audit. */
export function regradeUtilityGrounding<T extends UtilityGroundingRow>(row: T) {
  const available = returnedEvidenceIds(row.trace.map((entry) => entry.result));
  const grounded = row.citations.every((id) => typeof id === "string" && available.has(id));
  return {
    ...row,
    previous_citation_grade: { grounded: row.grounded, supported_success: row.supported_success },
    grounded,
    supported_success: row.correct && row.cited && grounded && row.functional !== false,
  };
}
