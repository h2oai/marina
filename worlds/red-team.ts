// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { focusedExampleWorld } from "./focused-example";

export default focusedExampleWorld({
  slug: "red-team",
  name: "Red Team Arena",
  purpose: "Proposals survive structured attack, rebuttal, adjudication, and remediation.",
  project: {
    name: "Launch Plan Challenge",
    description: "Stress-test a launch plan and ship a remediated version with a dissent record.",
    orchestration: "debate",
    tasks: [
      {
        title: "State the proposal and threat model",
        description: "Define claims, assets, actors, constraints, and failure criteria.",
      },
      {
        title: "Produce independent attacks",
        description: "Find concrete failure modes without coordinating attack narratives.",
      },
      {
        title: "Rebut with evidence",
        description:
          "Answer each material attack with evidence, mitigation, or explicit acceptance.",
      },
      {
        title: "Adjudicate disputed claims",
        description: "Score attacks and rebuttals; preserve minority dissent.",
      },
      {
        title: "Publish the remediated proposal",
        description: "Ship changes, residual risks, owners, and verification steps.",
        standing: 3,
      },
    ],
    principles: [
      "Attack the claim, never the participant. Every attack names the assumption and plausible consequence.",
      "A rebuttal without evidence is an opinion. A mitigation without an owner and check is unfinished.",
    ],
  },
  stages: [
    {
      id: "briefing",
      name: "Briefing Chamber",
      description: "The proposal, scope, protected assets, and rules of engagement are fixed here.",
    },
    {
      id: "attack",
      name: "Attack Floor",
      description:
        "Independent red-teamers develop falsifiable attacks and failure demonstrations.",
    },
    {
      id: "rebuttal",
      name: "Rebuttal Bench",
      description:
        "Defenders answer attacks with evidence, mitigations, or explicit risk acceptance.",
    },
    {
      id: "tribunal",
      name: "Adjudication Tribunal",
      description: "A judge scores both sides and preserves material dissent.",
    },
    {
      id: "remediation",
      name: "Remediation Vault",
      description:
        "The revised proposal, residual risks, and verification plan become durable artifacts.",
    },
  ],
  agents: [
    {
      name: "RedTeam-Attacker",
      role: "researcher",
      goal: "Independently find concrete, falsifiable failure modes and document evidence.",
    },
    {
      name: "RedTeam-Defender",
      role: "scholar",
      goal: "Rebut attacks with evidence and convert valid findings into owned mitigations.",
    },
    {
      name: "RedTeam-Judge",
      role: "general",
      goal: "Adjudicate claims fairly, score evidence, and preserve unresolved dissent.",
    },
  ],
  guideNotes: [
    "Use separate attack and rebuttal tasks to prevent premature consensus. The tribunal evaluates evidence, not confidence.",
    "The finished artifact must list residual risks. A red-team exercise that reports zero residual risk has probably failed.",
  ],
});
