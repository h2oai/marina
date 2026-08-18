// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TemplateNote } from "./orchestration";

export const TIERED_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses tiered memory. Use core memory (memory set/get) for " +
      "active beliefs, current goals, and working state. Update it frequently as your " +
      "understanding changes. Use notes for archival observations that should persist.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Tiered memory pattern: before starting work, 'memory list' to load your current state. " +
      "As you learn things, 'memory set <key> <value>' to update beliefs. When something " +
      "is no longer relevant, 'memory delete <key>'. Use 'memory history <key>' to see " +
      "how your understanding evolved.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Tiered retrieval: when you need past context, use 'recall <query>' to search " +
      "archival notes. Core memory is always available (memory list), notes require " +
      "recall to surface. Keep core memory small and current, notes can be extensive.",
    importance: 8,
    type: "skill",
  },
];

export const GENERATIVE_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses generative memory. Note everything you observe with " +
      "importance scores. Recall frequently to let importance and recency drive what " +
      "surfaces. Reflect periodically to consolidate observations into higher-order " +
      "understanding.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Generative memory pattern: after every significant interaction, create a note " +
      "with an honest importance score (1-10). Mundane observations get 1-3, meaningful " +
      "events get 4-6, critical discoveries get 7-10. The system uses these scores " +
      "to prioritize what you remember.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Generative memory reflection: run 'reflect' after accumulating several notes. " +
      "This creates an episode note linking to your sources. Reflect on specific topics " +
      "with 'reflect <topic>'. Reflections become high-importance notes that shape " +
      "future recall results.",
    importance: 8,
    type: "skill",
  },
];

export const GRAPH_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Graph memory. Create typed notes (type fact, type decision, type inference) " +
      "and link them with relationships. Build structured knowledge that can be traversed. " +
      "Use 'note trace <id>' to walk reasoning chains.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Graph memory pattern: every note should have a type. Facts are verified truths. " +
      "Decisions are choices made. Inferences are conclusions drawn. Create typed notes: " +
      "'note <text> type fact'. Link notes: 'note link <id1> <id2> supports' or " +
      "'contradicts' or 'caused_by'. Build a web of connected knowledge.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Graph memory correction: when you discover something is wrong, use " +
      "'note correct <id> <new text>' to create a superseding note. This preserves " +
      "the history — the old note stays, linked by a 'supersedes' relationship. " +
      "Use 'note graph' to see your knowledge structure overview.",
    importance: 8,
    type: "skill",
  },
];

export const SHARED_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Shared Pool memory. The project pool is the primary knowledge " +
      "base — everyone adds, everyone recalls. Use the pool for shared facts, decisions, " +
      "and observations. Use personal notes for private working memory.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Shared memory pattern: when you discover something relevant to the project, " +
      "add it to the pool: 'pool <name> add <observation> importance <N>'. " +
      "Before starting work, recall from the pool: 'pool <name> recall <topic>'. " +
      "The pool is the team's shared brain.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Shared memory coordination: the pool accumulates everyone's contributions. " +
      "Use high importance (8-10) for critical shared knowledge, medium (5-7) for " +
      "useful context, low (1-4) for minor observations. This helps recall surface " +
      "the most valuable shared knowledge first.",
    importance: 8,
    type: "skill",
  },
];
