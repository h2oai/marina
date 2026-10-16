// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MarinaDB } from "../../src/persistence/database";
import { binaryInvestigation, investigationFixtures } from "../../test/fixtures/investigations";

/** Explicitly simulated answers, confined to the temporary browser-test database. */
export function seedInvestigationBrowserFixture(path: string) {
  const db = new MarinaDB(path);
  try {
    const owner = { key: "prediction-browser-owner", name: "PredictionBrowser" };
    db.createUser({ id: owner.key, name: owner.name });
    for (const kind of ["prediction", "research"] as const) {
      const question =
        kind === "prediction"
          ? "Simulated: Will the release ship?"
          : "Simulated: What blocks the release?";
      const attempt = db.createInvestigation(owner, { kind, question }, `browser-${kind}`).attempt;
      const generation = db.claimInvestigation(attempt.id)!;
      const inputId = db.storeInvestigationContent(attempt.id, generation, "model:input", {
        question,
        system: "Simulated provider fixture",
        user: "Review the release checklist.",
      });
      const outputId = db.storeInvestigationContent(attempt.id, generation, "model:output", {
        text: "Simulated fixture: integration remains uncertain.",
      });
      db.appendInvestigationEvent(attempt.id, generation, {
        kind: "stage_started",
        stageId: "fixture-stage",
        actor: "simulated-analyst",
        message: "model",
        inputId,
      });
      db.appendInvestigationEvent(attempt.id, generation, {
        kind: "stage_completed",
        stageId: "fixture-stage",
        actor: "simulated-analyst",
        message: "model",
        inputId,
        outputId,
      });
      const result = kind === "prediction" ? binaryInvestigation : investigationFixtures.research!;
      db.finishInvestigation(attempt.id, generation, {
        state: "completed",
        result: { ...result, summary: `Simulated fixture: ${result.summary}`, outputId },
      });
      db.settleInvestigation(attempt.id, generation, result.accounting);
    }
  } finally {
    db.close();
  }
}
