import { focusedExampleWorld } from "./focused-example";

export default focusedExampleWorld({
  slug: "deep-research",
  name: "Deep Research",
  purpose: "A broad question becomes parallel, source-grounded work and a reviewed synthesis.",
  project: {
    name: "Research Brief",
    description:
      "Answer a consequential example question with traceable sources and calibrated claims.",
    orchestration: "research",
    tasks: [
      {
        title: "Frame the question and success criteria",
        description:
          "Define scope, audience, time horizon, exclusions, and the decision this research supports.",
      },
      {
        title: "Map subquestions and source strategy",
        description:
          "Decompose the question and identify primary sources, datasets, and credible counter-sources.",
      },
      {
        title: "Run parallel investigations",
        description:
          "Assign non-overlapping workstreams and publish source-backed findings to the shared pool.",
      },
      {
        title: "Verify claims and resolve contradictions",
        description:
          "Trace important claims, cross-check sources, and preserve unresolved disagreement.",
      },
      {
        title: "Publish the synthesis",
        description:
          "Write the answer with citations, confidence, limitations, and recommended next research.",
        standing: 3,
      },
    ],
    principles: [
      "Every material claim must trace to a source or be visibly labeled as inference.",
      "Search for disconfirming evidence before synthesis; do not resolve contradictions by averaging them away.",
    ],
  },
  stages: [
    {
      id: "brief",
      name: "Question Desk",
      description:
        "The research question, audience, scope, and acceptance criteria are fixed before decomposition.",
    },
    {
      id: "sources",
      name: "Source Library",
      description:
        "Primary sources, datasets, provenance, credibility, and contradictions are indexed here.",
    },
    {
      id: "workstreams",
      name: "Investigation Hall",
      description:
        "Independent researchers pursue bounded subquestions and publish evidence-backed findings.",
    },
    {
      id: "verification",
      name: "Verification Desk",
      description:
        "Claims are traced, sources cross-checked, and contradictions either resolved or preserved.",
    },
    {
      id: "synthesis",
      name: "Synthesis Archive",
      description:
        "The cited answer, confidence, limitations, and open questions become durable shared memory.",
    },
  ],
  agents: [
    {
      name: "Research-Scout",
      role: "researcher",
      goal: "Find primary sources and publish bounded, cited findings without premature synthesis.",
    },
    {
      name: "Research-Analyst",
      role: "scholar",
      goal: "Connect findings, test competing explanations, and label inference separately from fact.",
    },
    {
      name: "Research-Editor",
      role: "general",
      goal: "Verify traceability, preserve contradictions, and synthesize a concise cited answer.",
    },
  ],
  guideNotes: [
    "Use the shared pool as the handoff boundary: findings must be understandable without access to a researcher's private context.",
    "The synthesis reports confidence per claim and ends with limitations and the next highest-value questions.",
  ],
});
