// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaMemoryClient } from "./memory-client";
import type { MemoryOperationRequest } from "./memory-operations";
import type { MemoryRecipe, MemoryRetrievalObservation } from "./memory-recipes";
import type {
  MemoryCheckpoint,
  MemoryReceipt,
  MemoryRecord,
  MemoryRetrievalInput,
  MemoryRetrievalResult,
} from "./memory-types";

export const MEMORY_WORKFLOW_ACTIONS = [
  "help",
  "start",
  "tasks",
  "run",
  "finish",
  "feedback",
  "resume",
  "export_episode",
  "import_episode",
  "save_recipe",
  "recipes",
  "use_recipe",
  "changes",
  "watch",
  "poll",
  "ack",
  "unwatch",
] as const;
export interface MemoryEvidenceReference {
  kind: "record" | "source";
  space_id: string;
  id: string;
  version?: number;
  content_hash?: string;
  text_hash?: string;
  start?: number;
  end?: number;
}
export interface MemoryEpisode {
  schema: "marina.experience.episode.v1";
  task_id: string;
  corpus: string;
  goal: string;
  next_action: string;
  status: "open" | "running" | "ready" | "completed" | "interrupted" | "failed";
  actor: string;
  executed_by?: string;
  started_at: number;
  updated_at: number;
  input?: MemoryRetrievalInput;
  attempt?: string;
  recipe?: { space_id: string; id: string; version: number };
  elapsed_ms?: number;
  references: MemoryEvidenceReference[];
  observation?: Omit<MemoryRetrievalResult, "evidence" | "observed_candidates"> & {
    evidence: MemoryEvidenceReference[];
    observed_candidates?: MemoryEvidenceReference[];
  };
  error?: { code: string; message: string };
}
export interface MemoryTaskHandle {
  goal: string;
  journal_space_id: string;
  episode_id: string;
  version: number;
  task_id: string;
  status: MemoryEpisode["status"];
  next_actions: string[];
  next_calls?: MemoryOperationRequest[];
}
export interface MemoryResumeResult extends MemoryTaskHandle {
  episode: Omit<MemoryEpisode, "observation">;
  checkpoint: MemoryCheckpoint;
  resident_checkpoint: MemoryCheckpoint | null;
  premises: {
    reference: MemoryEvidenceReference;
    current_version?: number;
    read_current?: MemoryOperationRequest;
    state: "current" | "changed" | "stale" | "unavailable" | "out_of_time";
  }[];
  retrieval?: MemoryRetrievalResult;
}
export interface MemoryChange {
  seq: number;
  operation: string;
  reference_id: string | null;
  version: number | null;
  created_at: number;
}
export interface MemoryChanges {
  space_id: string;
  events: MemoryChange[];
  cursor: number;
  high_watermark: number;
  has_more: boolean;
}
export interface MemoryWatchResult {
  name: string;
  version: number;
  changes: MemoryChanges;
  acknowledgement: { cursor: number; expected_version: number; observed_at: number };
  temporal_due: boolean;
  next_validity_boundary: number | null;
}
export interface MemoryOutcomeInput {
  task_id: string;
  rubric: string;
  result: "helpful" | "unhelpful" | "pass" | "fail" | "unknown";
  explanation: string;
  evidence?: MemoryEvidenceReference[];
  metrics?: {
    model_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    elapsed_ms?: number;
  };
}

/** Typed conveniences over the identical HTTP, MCP and resident operation vocabulary. */
export class MarinaMemoryWorkflows {
  constructor(
    readonly space: string,
    private call: (request: MemoryOperationRequest) => Promise<unknown>,
    readonly journalSpace?: string,
  ) {}
  static http(client: MarinaMemoryClient, space: string, journalSpace?: string) {
    return new MarinaMemoryWorkflows(
      space,
      (request) =>
        client.request(
          `/spaces/${encodeURIComponent(space)}/workflow`,
          "POST",
          request.input,
          request.key,
        ),
      journalSpace,
    );
  }
  private action<T>(
    action: (typeof MEMORY_WORKFLOW_ACTIONS)[number],
    input: object = {},
    key?: string,
  ): Promise<T> {
    return this.call({
      operation: "workflow",
      space_id: this.space,
      input: {
        action,
        ...input,
        ...(this.journalSpace ? { journal_space_id: this.journalSpace } : {}),
      },
      key,
    }) as Promise<T>;
  }
  help() {
    return this.action<Record<string, unknown>>("help");
  }
  start(goal: string, options: { task_id?: string; next_action?: string } = {}, key?: string) {
    return this.action<MemoryTaskHandle>("start", { goal, ...options }, key);
  }
  tasks(cursor?: string) {
    return this.action<{ tasks: MemoryTaskHandle[]; next_cursor: string | null }>("tasks", {
      cursor,
    });
  }
  run(
    task_id: string,
    expected_version: number,
    input: Omit<MemoryRetrievalInput, "task"> = {},
    key?: string,
  ) {
    return this.action<MemoryTaskHandle & { retrieval: MemoryRetrievalResult }>(
      "run",
      { task_id, expected_version, retrieval: input },
      key,
    );
  }
  runRecipe(task_id: string, expected_version: number, id: string, version: number, key?: string) {
    return this.action<MemoryTaskHandle & { retrieval: MemoryRetrievalResult }>(
      "run",
      { task_id, expected_version, recipe: { id, version } },
      key,
    );
  }
  finish(
    task_id: string,
    expected_version: number,
    status: "completed" | "interrupted" | "failed",
    next_action: string,
    key?: string,
  ) {
    return this.action<MemoryTaskHandle>(
      "finish",
      { task_id, expected_version, status, next_action },
      key,
    );
  }
  feedback(input: MemoryOutcomeInput, key?: string) {
    return this.action<MemoryReceipt>("feedback", input, key);
  }
  resume(task_id: string, retrieve = false) {
    return this.action<MemoryResumeResult>("resume", { task_id, retrieve });
  }
  exportEpisode(task_id: string) {
    return this.action<MemoryRetrievalObservation>("export_episode", { task_id });
  }
  importEpisode(
    observation: MemoryRetrievalObservation,
    options: { task_id?: string; next_action?: string } = {},
    key?: string,
  ) {
    return this.action<MemoryTaskHandle>("import_episode", { observation, ...options }, key);
  }
  saveRecipe(recipe: MemoryRecipe, key?: string) {
    return this.action<MemoryReceipt>("save_recipe", { recipe }, key);
  }
  recipes(cursor?: string) {
    return this.action<{ results: MemoryRecord[]; next_cursor: string | null }>("recipes", {
      cursor,
    });
  }
  useRecipe(id: string, version: number, task: string) {
    return this.action<MemoryRetrievalResult>("use_recipe", { id, version, task });
  }
  changes(cursor = 0, ids?: string[], limit = 50) {
    return this.action<MemoryChanges>("changes", { cursor, ids, limit });
  }
  watch(name: string, ids: string[] = [], key?: string) {
    return this.action<MemoryReceipt>("watch", { name, ids }, key);
  }
  poll(name: string, limit = 50) {
    return this.action<MemoryWatchResult>("poll", { name, limit });
  }
  ack(
    name: string,
    acknowledgement: number | MemoryWatchResult["acknowledgement"],
    cursor?: number,
    key?: string,
  ) {
    const input =
      typeof acknowledgement === "number"
        ? { expected_version: acknowledgement, cursor }
        : acknowledgement;
    return this.action<MemoryReceipt>("ack", { name, ...input }, key);
  }
  unwatch(name: string, expected_version: number, key?: string) {
    return this.action<MemoryReceipt>("unwatch", { name, expected_version }, key);
  }
}
