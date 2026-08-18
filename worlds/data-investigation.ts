// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { focusedExampleWorld } from "./focused-example";

export default focusedExampleWorld({
  slug: "data-investigation",
  name: "Data Investigation Lab",
  purpose:
    "A dataset moves from profiling through competing hypotheses to a reproducible findings report.",
  project: {
    name: "Anomaly Investigation",
    description:
      "Explain an example metric anomaly without overstating what the available data supports.",
    orchestration: "research",
    tasks: [
      {
        title: "Profile the dataset",
        description:
          "Document schema, lineage, missingness, ranges, distributions, and suspicious changes.",
      },
      {
        title: "Generate competing hypotheses",
        description:
          "List data-quality, product, operational, and external explanations with predictions.",
      },
      {
        title: "Run discriminating analyses",
        description: "Test the predictions that best separate competing explanations.",
      },
      {
        title: "Reproduce and challenge results",
        description:
          "Independently rerun key checks and search for leakage, confounding, and selection bias.",
      },
      {
        title: "Publish findings and next instrumentation",
        description: "Report supported conclusions, uncertainty, and the next data needed.",
        standing: 3,
      },
    ],
    principles: [
      "Profile before modeling. Preserve queries, parameters, exclusions, and failed analyses as part of the evidence.",
      "Correlation, prediction, and causation are different claims and must remain visibly distinct.",
    ],
  },
  stages: [
    {
      id: "intake",
      name: "Dataset Intake",
      description:
        "The question, dataset contract, lineage, grain, and access constraints are fixed here.",
    },
    {
      id: "profiling",
      name: "Profiling Bay",
      description:
        "Schema, quality, distributions, cohorts, and anomalies become visible before inference.",
    },
    {
      id: "analysis",
      name: "Analysis Workbench",
      description:
        "Competing hypotheses are tested with reproducible queries and explicit exclusions.",
    },
    {
      id: "validation",
      name: "Validation Chamber",
      description:
        "Independent reruns challenge leakage, confounding, selection effects, and brittle results.",
    },
    {
      id: "report",
      name: "Findings Archive",
      description:
        "Supported findings, uncertainty, rejected hypotheses, and instrumentation requests persist.",
    },
  ],
  agents: [
    {
      name: "Data-Profiler",
      role: "researcher",
      goal: "Profile lineage, schema, missingness, distributions, cohorts, and data-quality risks.",
    },
    {
      name: "Data-Analyst",
      role: "scholar",
      goal: "Develop competing hypotheses and run discriminating, reproducible analyses.",
    },
    {
      name: "Data-Validator",
      role: "general",
      goal: "Independently reproduce results and challenge leakage, bias, and causal overclaims.",
    },
  ],
  guideNotes: [
    "A useful investigation can conclude that the data is insufficient. Specify the instrumentation that would resolve uncertainty.",
    "Publish rejected hypotheses and failed checks; they prevent successors from repeating work and expose analytical fragility.",
  ],
});
