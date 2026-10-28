// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Separate OS process: SIGKILL deliberately skips finally, DB close and shutdown.
import type { DecisionAnswer, DecisionProvider } from "../../src/decisions/types";
import { lessonAdmission } from "../../src/learning/admission";
import { type Outcome, recordOutcome } from "../../src/learning/outcomes";
import { lessonSinkFor } from "../../src/learning/service";
import { outcomeLearningJournal } from "../../src/outcomes/journal";
import { MarinaDB } from "../../src/persistence/database";

const [path, fault = "", relation = "new", mode = "on", phase = "before"] = process.argv.slice(2);
if (!path) throw new Error("database path required");
const db = new MarinaDB(path);
const outcome: Outcome = {
  domain: "code",
  source: "code:verify",
  succeeded: false,
  resolvedAt: "2026-09-10T00:00:00.000Z",
  scope: "method",
  attempted: "verify a change with pytest",
  detail: "pytest collection fails when run outside the repository root",
  refs: ["trace:recovered"],
};
const { id } = db.recordOutcomeRow(
  {
    subject: "crash:lesson",
    kind: "forecast",
    source: "code:verify",
    domain: "code",
    succeeded: false,
    basis: "mechanical",
    resolvedAt: Date.parse(outcome.resolvedAt),
  },
  ["lessons"],
);
const judge: DecisionProvider = {
  kind: "test",
  model: "test/crash-mechanics",
  calibrated: true,
  async ask(request) {
    if (mode === "no-judge") throw new Error("Cached verdict must avoid provider calls");
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, q] of Object.entries(request.questions)) {
      if (q.type === "noul") answers[key] = { type: "noul", noul: 0.95 };
      else if (q.type === "choice")
        answers[key] = { type: "choice", choice: relation, probabilities: { [relation]: 0.95 } };
      else if (q.type === "score") answers[key] = { type: "score", score: q.criteria.length - 1 };
    }
    return {
      answers,
      model: "test/crash-mechanics",
      provider: "test",
      latencyMs: 0,
      calibrated: true,
    };
  },
};
const save = db.saveOutcomeLearningStep.bind(db);
db.saveOutcomeLearningStep = (outcomeId, step, value) => {
  if (fault === step && phase === "before") process.kill(process.pid, "SIGKILL");
  save(outcomeId, step, value);
  if (fault === step && phase === "after") process.kill(process.pid, "SIGKILL");
};
const result = await recordOutcome(
  {
    sink: lessonSinkFor(db),
    judge,
    meta: true,
    journal: outcomeLearningJournal(db, id),
    admit: lessonAdmission({
      judge,
      env: { MARINA_MEMORY_RANKING: mode === "observe" ? "observe" : "on" },
    }),
  },
  outcome,
);
db.setOutcomeDelivery(id, "lessons", "done", result.trust);
db.close();
process.stdout.write(JSON.stringify(result));
