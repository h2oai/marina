#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";
import {
  type ChallengerOptions,
  recordChallengers,
  scoreChallengers,
} from "../src/arena/challenger-shadow";
import { arenaData } from "../src/arena/service";
import { sharedTabPredict } from "../src/arena/tabh2o-forecaster";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { MarinaDB } from "../src/persistence/database";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    kind: { type: "string", default: "attention" },
    input: { type: "string" },
    tabh2o: { type: "boolean" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help || !positionals[0]) {
  console.log(
    "bun run scripts/arena-challengers.ts <round|score> --db <shadow.db> [--kind attention|numeric|uncertainty|population] [--input scenario.json] [--tabh2o] [--out report.json]. Never submits or promotes.",
  );
} else {
  if (!values.db) throw new Error("--db requires an explicit ledger");
  if (!["attention", "numeric", "uncertainty", "population"].includes(values.kind))
    throw new Error("invalid challenger kind");
  if (values.tabh2o) attachCliSpendLedger("arena challengers");
  const db = new MarinaDB(values.db);
  try {
    const input = values.input ? await Bun.file(values.input).json() : {};
    const report =
      positionals[0] === "score"
        ? await scoreChallengers(
            arenaData(),
            db.listArenaShadow({ forecaster: "challenger-v1", limit: 2000 }),
          )
        : await recordChallengers(db, arenaData(), positionals[0]!, {
            kind: values.kind as ChallengerOptions["kind"],
            entrant: process.env.MARINA_ARENA_ENTRANT,
            events: input.events,
            covariates: input.covariates,
            population: input.population,
            ...(values.tabh2o ? { predict: sharedTabPredict() } : {}),
          });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) await Bun.write(values.out, text);
    console.log(text);
  } finally {
    db.close();
  }
}
