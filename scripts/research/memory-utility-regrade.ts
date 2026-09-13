// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Correct citation-availability scoring in a saved v1 utility report.
 * The original file is preserved; output must be a new file. No model calls. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { regradeUtilityGrounding, type UtilityGroundingRow } from "./memory-evidence-ids";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { input: { type: "string" }, output: { type: "string" } },
});
if (!values.input || !values.output) throw new Error("Use --input ORIGINAL --output NEW_FILE");
const original = readFileSync(values.input);
const report = JSON.parse(original.toString());
if (report.schema !== "marina.memory.utility.v1" || !Array.isArray(report.results))
  throw new Error("Expected a v1 utility report");
for (const row of report.results) {
  if (
    !Array.isArray(row.trace) ||
    row.trace.some(
      (entry: unknown) => !entry || typeof entry !== "object" || !("result" in entry),
    ) ||
    !Array.isArray(row.citations) ||
    [row.correct, row.cited, row.grounded, row.supported_success].some(
      (value) => typeof value !== "boolean",
    ) ||
    (row.functional !== null && typeof row.functional !== "boolean")
  )
    throw new Error("Invalid result: cannot safely retain its original grading decisions");
}
const results = (report.results as UtilityGroundingRow[]).map(regradeUtilityGrounding);
const regrade = {
  contract: "returned-evidence-ids-v2",
  performed_at: new Date().toISOString(),
  original_sha256: createHash("sha256").update(original).digest("hex"),
  scorer_sha256: createHash("sha256")
    .update(readFileSync(new URL("./memory-evidence-ids.ts", import.meta.url)))
    .digest("hex"),
  changed_results: results.filter(
    (row) => row.previous_citation_grade.supported_success !== row.supported_success,
  ).length,
  scope:
    "Only citation availability and its derived supported_success changed. Explicit record source_ids count as returned provenance; payload IDs do not. This does not assert source bodies were read. Original exact-answer, supporting-evidence and functionality decisions are retained.",
};
writeFileSync(values.output, `${JSON.stringify({ ...report, regrade, results }, null, 2)}\n`, {
  flag: "wx",
});
console.log(JSON.stringify(regrade));
