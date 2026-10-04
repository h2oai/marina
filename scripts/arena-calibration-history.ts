// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { mergeCalibrationHistory } from "../src/arena/calibration-history";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { "as-of": { type: "string" }, output: { type: "string" } },
});
if (!values["as-of"] || !values.output || !positionals.length)
  throw new Error(
    "usage: bun run scripts/arena-calibration-history.ts --as-of <ISO time> --output <new.json> <scores-or-history.json>...",
  );
const sources = await Promise.all(
  positionals.map(async (path) => {
    const file = Bun.file(path);
    if (file.size > 32_000_000) throw new Error(`calibration source exceeds 32MB: ${path}`);
    const input: unknown = await file.json();
    if (Array.isArray(input)) return input;
    if (input && typeof input === "object") {
      if ("calibrationObservations" in input) return input.calibrationObservations;
      if (
        "schema" in input &&
        input.schema === "marina.arena.calibration-history.v1" &&
        "observations" in input
      )
        return input.observations;
    }
    throw new Error(`not a calibration scorer export or history: ${path}`);
  }),
);
const report = mergeCalibrationHistory(sources, values["as-of"]);
// Refuse to overwrite an earlier report or one of the input evidence files.
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    output: values.output,
    observations: report.observations.length,
    groups: report.groups.length,
    promotion: report.promotion,
  }),
);
