// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Named reference MCP memory tool contract; native history/grants remain Marina's. */
export const MEMORY_GRAPH_ACTIONS = [
  "create_entities",
  "create_relations",
  "add_observations",
  "delete_entities",
  "delete_observations",
  "delete_relations",
  "read_graph",
  "search_nodes",
  "open_nodes",
] as const;
export type MemoryGraphAction = (typeof MEMORY_GRAPH_ACTIONS)[number];
export interface MemoryGraphEntity {
  name: string;
  entityType: string;
  observations: string[];
}
export interface MemoryGraphRelation {
  from: string;
  to: string;
  relationType: string;
}
export interface MemoryKnowledgeGraph {
  entities: MemoryGraphEntity[];
  relations: MemoryGraphRelation[];
}
export interface MemoryGraphInputs {
  create_entities: { entities: MemoryGraphEntity[] };
  create_relations: { relations: MemoryGraphRelation[] };
  add_observations: { observations: { entityName: string; contents: string[] }[] };
  delete_entities: { entityNames: string[] };
  delete_observations: { deletions: { entityName: string; observations: string[] }[] };
  delete_relations: { relations: MemoryGraphRelation[] };
  read_graph: Record<string, never>;
  search_nodes: { query: string };
  open_nodes: { names: string[] };
}
export interface MemoryGraphResults {
  create_entities: { entities: MemoryGraphEntity[] };
  create_relations: { relations: MemoryGraphRelation[] };
  add_observations: { results: { entityName: string; addedObservations: string[] }[] };
  delete_entities: { deleted: string[]; notFound: string[] };
  delete_observations: { deletedCount: number; missingEntities: string[] };
  delete_relations: { deletedCount: number };
  read_graph: MemoryKnowledgeGraph;
  search_nodes: MemoryKnowledgeGraph;
  open_nodes: MemoryKnowledgeGraph;
}
