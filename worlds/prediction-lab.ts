// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../src/persistence/database";
import type { WorldDefinition } from "../src/world/world-definition";
import marketsWorld from "./markets";
import { seedBoard, seedChannel, seedProject, seedSystemAgent } from "./seed";

function seed(db: MarinaDB): void {
  marketsWorld.seed?.(db);
  seedChannel(db, "forecast-room");
  seedBoard(db, "forecast-review", {
    title: "Forecast review protocol",
    body:
      "Every forecast states a base rate, dated evidence, probability, strongest counterargument, " +
      "and update trigger. Resolution closes the loop with a Brier score and postmortem.",
  });
  seedProject(db, {
    name: "Calibration Sprint",
    description: "Take one forecast from question definition through resolution-ready review.",
    orchestration: "debate",
    tasks: [
      {
        title: "Define a resolvable question",
        description: "Specify deadline, source of truth, edge cases, and resolution criteria.",
      },
      {
        title: "Establish the base rate",
        description: "Find the closest reference class and document its limits.",
      },
      {
        title: "Build independent evidence cases",
        description: "Produce separate yes and no cases before sharing estimates.",
      },
      {
        title: "Publish and challenge a forecast",
        description: "State probability, reasoning, counterargument, and update triggers.",
      },
      {
        title: "Prepare resolution and postmortem",
        description:
          "Record the resolution source, scoring plan, and questions for calibration review.",
        standing: 3,
      },
    ],
    poolNotes: [
      {
        content:
          "Start from a reference-class base rate, then update on evidence rather than narrative confidence.",
        importance: 9,
      },
      {
        content:
          "A forecast is incomplete without explicit resolution criteria and a dated source of truth.",
        importance: 9,
      },
      {
        content: "Preserve pre-discussion estimates so the lab can detect anchoring and herding.",
        importance: 8,
      },
    ],
  });
  const model = process.env.MARINA_CREW_MODEL ?? "marina/default";
  seedSystemAgent(db, {
    name: "Forecast-Researcher",
    model,
    role: "researcher",
    goal: "Gather dated evidence, source it, and maintain separate evidence-for and evidence-against cases.",
  });
  seedSystemAgent(db, {
    name: "Forecast-Skeptic",
    model,
    role: "scholar",
    goal: "Challenge base rates, resolution ambiguity, correlated evidence, and unjustified probability updates.",
  });
  seedSystemAgent(db, {
    name: "Forecast-Resolver",
    model,
    role: "general",
    goal: "Protect resolution criteria, score forecasts, and publish calibration postmortems.",
  });
}

const predictionLab: WorldDefinition = {
  ...marketsWorld,
  name: "Prediction Lab",
  gridPositions: {
    "markets/floor": { row: 1, col: 1 },
    "markets/kalshi": { row: 1, col: 2 },
    "markets/polymarket": { row: 1, col: 0 },
    "markets/research": { row: 0, col: 1 },
    "markets/geo": { row: 2, col: 0 },
    "markets/tech": { row: 2, col: 1 },
    "markets/econ": { row: 2, col: 2 },
    "markets/meta": { row: 3, col: 1 },
  },
  guideNotes: [
    {
      content:
        "Prediction Lab golden path: 'project Calibration Sprint join', complete its five tasks, " +
        "publish one probability with 'predict', and preserve its resolution plan.",
      importance: 10,
      type: "skill",
    },
    ...marketsWorld.guideNotes,
  ],
  autoBootstrap: ["channel join forecast-room"],
  seed,
};

export default predictionLab;
