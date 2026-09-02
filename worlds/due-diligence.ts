// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { focusedExampleWorld } from "./focused-example";

export default focusedExampleWorld({
  slug: "due-diligence",
  name: "Due Diligence Room",
  purpose:
    "Parallel workstreams turn an investment thesis into a sourced decision memo and risk register.",
  project: {
    name: "Example Company Diligence",
    description:
      "Evaluate an example company without confusing missing evidence for positive evidence.",
    orchestration: "mapreduce",
    tasks: [
      {
        title: "Write the initial thesis",
        description: "State the opportunity, key assumptions, and explicit decision criteria.",
      },
      {
        title: "Evaluate market and customers",
        description: "Assess demand, competition, concentration, and reference evidence.",
      },
      {
        title: "Evaluate product and technology",
        description:
          "Assess differentiation, architecture, security, dependencies, and delivery risk.",
      },
      {
        title: "Evaluate business quality",
        description:
          "Assess economics, financing, governance, legal exposure, and operating signals.",
      },
      {
        title: "Publish decision memo and risk register",
        description: "Recommend proceed, pause, or decline with confidence and conditions.",
        standing: 3,
      },
    ],
    principles: [
      "Separate verified facts, management claims, analyst inferences, and unresolved requests.",
      "Every material risk has likelihood, impact, evidence, owner, and a proposed closing condition.",
    ],
  },
  stages: [
    {
      id: "deal-desk",
      name: "Deal Desk",
      description:
        "The thesis, mandate, constraints, and decision criteria are recorded before research begins.",
    },
    {
      id: "data-room",
      name: "Data Room",
      description:
        "Sources, requests, provenance, access limitations, and contradictions are indexed here.",
    },
    {
      id: "workstreams",
      name: "Workstream Hall",
      description:
        "Market, product, technical, financial, legal, and team analyses run in parallel.",
    },
    {
      id: "committee",
      name: "Investment Committee",
      description:
        "The thesis faces disconfirming evidence, scenario analysis, and explicit conditions.",
    },
    {
      id: "memo-vault",
      name: "Memo Vault",
      description:
        "The decision memo, risk register, dissent, and follow-up obligations persist here.",
    },
  ],
  agents: [
    {
      name: "Diligence-Market",
      role: "researcher",
      goal: "Investigate market, customers, competitors, and source quality.",
    },
    {
      name: "Diligence-Technical",
      role: "scholar",
      goal: "Evaluate product, architecture, security, defensibility, and technical risk.",
    },
    {
      name: "Diligence-Lead",
      role: "general",
      goal: "Maintain the thesis, request missing evidence, synthesize risks, and draft the decision memo.",
    },
  ],
  guideNotes: [
    "This example is an analytical workflow, not investment advice. Preserve uncertainty and identify evidence gaps.",
    "Do not average incompatible conclusions. Resolve the underlying assumption or carry the disagreement into the committee record.",
  ],
});
