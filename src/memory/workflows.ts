// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { hash, mutation } from "../persistence/db-memory-service";
import { memoryChanges } from "../persistence/db-memory-workflows";
import type { MemoryActor } from "../persistence/db-principals";
import type { MemoryRecipe, MemoryRetrievalObservation } from "../sdk/memory-recipes";
import type {
  MemoryReceipt,
  MemoryRecord,
  MemoryRetrievalInput,
  MemoryRetrievedEvidence,
} from "../sdk/memory-types";
import {
  MEMORY_WORKFLOW_ACTIONS,
  type MemoryEpisode,
  type MemoryEvidenceReference,
  type MemoryTaskHandle,
} from "../sdk/memory-workflows";
import { createMemoryPlan } from "./planning";
import type { MemoryService } from "./service";
import { integer, MemoryError, object, recordInput, textValue } from "./service-types";
import { retrieveMemory, validateRetrievalOptions } from "./task-retrieval";

const EPISODE = "marina.experience.episode.v1";
const POLICY = "marina.memory.policy.v1";
const keyFor = (key: string, part: string) => `workflow:${hash([key, part])}`;
const finite = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new MemoryError(400, "invalid_input", `${name} must be a nonnegative finite number`);
  return value;
};
function reference(item: MemoryRetrievedEvidence): MemoryEvidenceReference {
  return item.kind === "record"
    ? { kind: "record", space_id: item.space_id, id: item.id, version: item.version }
    : {
        kind: "source",
        space_id: item.space_id,
        id: item.id,
        content_hash: item.content_hash,
        text_hash: item.text_hash,
        start: item.start,
        end: item.end,
      };
}
function episodeData(record: MemoryRecord): MemoryEpisode {
  let data: unknown;
  try {
    data = JSON.parse(record.content);
  } catch {
    throw new MemoryError(409, "invalid_episode", "Task manifest is not valid JSON");
  }
  if (object(data).schema !== EPISODE)
    throw new MemoryError(409, "invalid_episode", "Unsupported task manifest");
  return data as MemoryEpisode;
}
function taskHandle(journal: string, record: MemoryRecord): MemoryTaskHandle {
  const data = episodeData(record);
  return {
    goal: data.goal,
    journal_space_id: journal,
    episode_id: record.id,
    version: record.version,
    task_id: data.task_id,
    status: data.status,
    next_calls: [
      {
        operation: "workflow" as const,
        input: { action: "resume", task_id: data.task_id, journal_space_id: journal },
      },
      ...(data.status === "open" || data.status === "failed" || data.status === "interrupted"
        ? [
            {
              operation: "workflow" as const,
              input: {
                action: "run",
                task_id: data.task_id,
                expected_version: record.version,
                journal_space_id: journal,
              },
            },
          ]
        : []),
      {
        operation: "workflow" as const,
        input: {
          action: "finish",
          task_id: data.task_id,
          journal_space_id: journal,
          expected_version: record.version,
          status: "completed",
          next_action: "REPLACE_WITH_ACTUAL_RESULT_OR_NEXT_STEP",
        },
      },
    ],
    next_actions: [
      data.next_action || "Inspect the evidence and choose your next action.",
      `memory resume ${data.task_id}`,
    ],
  };
}
function optionalCheckpoint(
  service: MemoryService,
  actor: MemoryActor,
  space: string,
  name: string,
) {
  try {
    return service.repository.getCheckpoint(actor, space, name);
  } catch (error) {
    if (error instanceof MemoryError && error.code === "checkpoint_not_found") return null;
    throw error;
  }
}
function journalSpace(
  service: MemoryService,
  actor: MemoryActor,
  corpus: string,
  create: boolean,
  selected?: unknown,
) {
  const repo = service.repository;
  if (selected !== undefined) {
    const chosen = textValue(selected, "journal_space_id", 128);
    if (chosen === corpus)
      throw new MemoryError(
        400,
        "invalid_journal",
        "The task journal must be separate from the retrieval corpus",
      );
    repo.authorize(actor, chosen);
    return chosen;
  }
  const name = `marina.tasks:${corpus}`;
  const found = repo
    .spaces(actor)
    .find((space) => space.owner_id === actor.principalId && space.name === name);
  if (found) return found.id;
  if (!create)
    throw new MemoryError(
      404,
      "journal_not_found",
      "No tasks yet. Use memory start <goal> or workflows.start(goal).",
    );
  return repo.createSpace(actor, name, `workflow-journal:${corpus}`).id;
}
function readReference(
  service: MemoryService,
  actor: MemoryActor,
  ref: MemoryEvidenceReference,
): MemoryRetrievedEvidence {
  if (ref.kind === "record") {
    const record = service.repository.read(
      actor,
      ref.space_id,
      ref.id,
      integer(ref.version, "version", 1, Number.MAX_SAFE_INTEGER),
    );
    return { ...record, kind: "record" };
  }
  if (ref.kind !== "source")
    throw new MemoryError(400, "invalid_input", "Unknown evidence reference kind");
  const range = service.repository.sourceRange(
    actor,
    ref.space_id,
    ref.id,
    integer(ref.start, "start", 0, Number.MAX_SAFE_INTEGER),
    integer(ref.end, "end", Number(ref.start), Number(ref.start) + 8192),
    textValue(ref.text_hash, "text_hash", 128),
  );
  if (range.content_hash !== ref.content_hash)
    throw new MemoryError(409, "source_changed", "Source content changed");
  return { ...range, kind: "source", space_id: ref.space_id };
}
function hydrateObservation(
  service: MemoryService,
  actor: MemoryActor,
  episode: MemoryEpisode,
): MemoryRetrievalObservation {
  if (!episode.observation || !episode.input)
    throw new MemoryError(
      409,
      "episode_incomplete",
      "This task has no completed retrieval; run it first",
    );
  return {
    schema: "marina.memory.observation.v1",
    input: episode.input,
    attribution: episode.executed_by ?? episode.actor,
    result: {
      ...episode.observation,
      evidence: episode.observation.evidence.map((pin) => readReference(service, actor, pin)),
      observed_candidates: episode.observation.observed_candidates?.map((pin) =>
        readReference(service, actor, pin),
      ),
    },
  };
}

/** Explicit opt-in orchestration over canonical records, sources and CAS checkpoints. */
export async function memoryWorkflow(
  service: MemoryService,
  actor: MemoryActor,
  corpus: string,
  input: Record<string, unknown>,
  key: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const repo = service.repository;
  signal?.throwIfAborted();
  repo.authorize(actor, corpus);
  const action = textValue(input.action, "action", 64);
  if (!MEMORY_WORKFLOW_ACTIONS.includes(action as never))
    throw new MemoryError(400, "invalid_action", "Use workflow help to discover supported actions");
  const fields: Record<string, string[]> = {
    help: [],
    start: ["goal", "task_id", "next_action"],
    tasks: ["cursor"],
    run: ["task_id", "expected_version", "retrieval", "recipe"],
    finish: ["task_id", "expected_version", "status", "next_action"],
    feedback: ["task_id", "rubric", "result", "explanation", "evidence", "metrics"],
    resume: ["task_id", "retrieve"],
    export_episode: ["task_id"],
    import_episode: ["observation", "task_id", "next_action"],
    save_recipe: ["recipe"],
    recipes: ["cursor"],
    use_recipe: ["id", "version", "task"],
    changes: ["cursor", "ids", "limit"],
    watch: ["name", "ids"],
    poll: ["name", "limit"],
    ack: ["name", "expected_version", "cursor", "observed_at"],
    unwatch: ["name", "expected_version"],
  };
  const unsupported = Object.keys(input).filter(
    (field) =>
      field !== "action" && field !== "journal_space_id" && !fields[action]!.includes(field),
  );
  if (unsupported.length)
    throw new MemoryError(
      400,
      "invalid_input",
      `workflow ${action} accepts only ${fields[action]!.join(", ")}. Unsupported: ${unsupported.join(", ")}. Use workflow input {"action":"help"} for examples. Completion is a separate finish action.`,
    );
  if (action === "help")
    return {
      schema: "marina.memory.workflow-guide.v1",
      purpose: "Find evidence, preserve work, and resume with changed premises made visible.",
      quickstart: [
        "memory remember Zephyr deploys on port 8123",
        "memory retrieve Zephyr deployment port",
        "memory start Deploy Zephyr safely",
        "memory run TASK_ID VERSION",
        "memory resume TASK_ID",
        "memory finish TASK_ID VERSION completed Deployment checked",
      ],
      actions: MEMORY_WORKFLOW_ACTIONS,
      examples: [
        { action: "start", goal: "Find Zephyr deployment port", task_id: "deploy-17" },
        {
          action: "run",
          task_id: "deploy-17",
          expected_version: 1,
          retrieval: { selection: "balanced" },
        },
        { action: "resume", task_id: "deploy-17", retrieve: true },
        {
          action: "finish",
          task_id: "deploy-17",
          expected_version: "VERSION_FROM_RUN_OR_RESUME",
          status: "interrupted",
          next_action: "Check health endpoint before deployment",
        },
        {
          action: "feedback",
          task_id: "deploy-17",
          rubric: "Found documented port",
          result: "helpful",
          explanation: "Read the original runbook",
        },
        { action: "use_recipe", id: "RECIPE_ID", version: 1, task: "Zephyr deployment" },
        { action: "watch", name: "deployment", ids: ["PREMISE_RECORD_ID"] },
        { action: "poll", name: "deployment" },
        {
          action: "ack",
          name: "deployment",
          expected_version: "VERSION_FROM_POLL",
          cursor: "CURSOR_FROM_POLL",
          observed_at: "OBSERVED_AT_FROM_POLL",
        },
      ],
      interfaces: {
        typescript: "client.workflows(space)",
        mcp: "memory_workflow",
        resident: "marina_memory_service operation=workflow",
        http: "POST /v1/memory/spaces/:space/workflow",
      },
      guide: "docs/guides/memory-workflows.md",
      boundaries: [
        "Task capture is explicit and writes a separate private journal.",
        "Feedback is attributed, not truth certification.",
        "Recipes run only when selected; importing never activates them.",
        "Watches notify; they do not execute work.",
      ],
    };
  if (action === "changes")
    return memoryChanges(repo.raw, actor, corpus, input.cursor, input.ids, input.limit);
  if (action === "recipes")
    return repo.query(actor, corpus, {
      type: "skill",
      subject: "marina:retrieval-policy",
      limit: 20,
      cursor: input.cursor as string | undefined,
    });
  if (action === "save_recipe") {
    const raw = object(input.recipe);
    if (
      Object.keys(raw).some(
        (field) =>
          ![
            "schema",
            "name",
            "description",
            "retrieval",
            "prerequisites",
            "exceptions",
            "compatibility",
            "evidence",
          ].includes(field),
      )
    )
      throw new MemoryError(
        400,
        "invalid_recipe",
        "Unknown recipe field; recipes are declarative data",
      );
    if (raw.schema !== POLICY || raw.compatibility !== "marina.memory.retrieval.v1")
      throw new MemoryError(400, "invalid_recipe", "Unsupported recipe schema or compatibility");
    for (const field of ["prerequisites", "exceptions"] as const) {
      if (!Array.isArray(raw[field]) || raw[field].length > 16)
        throw new MemoryError(400, "invalid_recipe", `Use at most 16 ${field}`);
      for (const entry of raw[field]) textValue(entry, field, 2048);
    }
    textValue(raw.name, "name", 128);
    textValue(raw.description, "description", 4096);
    const retrieval = object(raw.retrieval);
    if (retrieval.use_model || retrieval.observe !== undefined || retrieval.task !== undefined)
      throw new MemoryError(
        400,
        "invalid_recipe",
        "Recipes contain deterministic read parameters, not tasks or model execution",
      );
    validateRetrievalOptions({ ...retrieval, task: "recipe validation" });
    // Validate with the same live interpreter; no reads or model calls at save time.
    const validatedPlan = await createMemoryPlan(service, actor, corpus, {
      task: "recipe validation",
      steps: retrieval.steps,
      use_model: false,
    });
    if (
      validatedPlan.steps.some(
        (step) => step.operation === "search" && step.input.mode !== "lexical",
      )
    )
      throw new MemoryError(400, "invalid_recipe", "Task retrieval recipes use lexical search");
    const allowed = [
      "selection",
      "expansion",
      "requirements",
      "steps",
      "broaden",
      "valid_at",
      "max_results",
      "max_bytes",
      "source_bytes",
    ];
    if (Object.keys(retrieval).some((name) => !allowed.includes(name)))
      throw new MemoryError(400, "invalid_recipe", "Unknown recipe parameter");
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 32)
      throw new MemoryError(400, "invalid_recipe", "Use at most 32 evidence references");
    for (const pin of raw.evidence) {
      const ref = object(pin);
      repo.read(
        actor,
        textValue(ref.space_id, "space_id", 128),
        textValue(ref.id, "id", 128),
        integer(ref.version, "version", 1, Number.MAX_SAFE_INTEGER),
      );
    }
    return repo.remember(
      actor,
      corpus,
      recordInput({
        content: JSON.stringify(raw),
        type: "skill",
        tier: "skill",
        subject: "marina:retrieval-policy",
        metadata: { format: POLICY, authored_by: actor.principalId },
      }),
      key,
    );
  }
  if (action === "use_recipe") {
    const record = repo.read(
      actor,
      corpus,
      textValue(input.id, "id", 128),
      integer(input.version, "version", 1, Number.MAX_SAFE_INTEGER),
    );
    if (record.freshness !== "current")
      throw new MemoryError(409, "recipe_changed", "Select a current recipe version explicitly");
    const recipe = object(JSON.parse(record.content)) as unknown as MemoryRecipe;
    if (recipe.schema !== POLICY || recipe.compatibility !== "marina.memory.retrieval.v1")
      throw new MemoryError(400, "invalid_recipe", "Not a compatible recipe");
    const result = await retrieveMemory(
      service,
      actor,
      corpus,
      { ...recipe.retrieval, task: textValue(input.task, "task", 8192), use_model: false },
      signal,
    );
    return {
      ...result,
      selected_recipe: { space_id: corpus, id: record.id, version: record.version },
    };
  }
  const writing = [
    "start",
    "import_episode",
    "run",
    "finish",
    "feedback",
    "watch",
    "ack",
    "unwatch",
  ].includes(action);
  if (writing && (!key || key.length > 128))
    throw new MemoryError(
      400,
      "idempotency_required",
      "Mutations require an Idempotency-Key of 1–128 characters",
    );
  if (action === "import_episode") repo.authorize(actor, corpus, "memory:write");
  let journal: string;
  try {
    journal = journalSpace(
      service,
      actor,
      corpus,
      action === "start" || action === "watch" || action === "import_episode",
      input.journal_space_id,
    );
  } catch (error) {
    if (action === "tasks" && error instanceof MemoryError && error.code === "journal_not_found")
      return { tasks: [], next_cursor: null };
    throw error;
  }
  const mutate = <T extends MemoryReceipt>(part: string, raw: unknown, run: () => T) =>
    mutation(repo.raw, actor, journal, keyFor(key, part), `workflow.${part}`, raw, run);
  const taskName = (id: string) => `task:${id}`;
  const load = (task: string) => {
    const checkpoint = optionalCheckpoint(service, actor, journal, taskName(task));
    if (!checkpoint)
      throw new MemoryError(
        404,
        "task_not_found",
        `Task ${task} was not found. Use workflow input {"action":"tasks"} (human: memory tasks), copy its exact task_id, then {"action":"resume","task_id":"EXACT_ID"}.`,
      );
    const record = repo.read(
      actor,
      journal,
      textValue(checkpoint.data.episode_id, "episode_id", 128),
    );
    const episode = episodeData(record);
    if (episode.corpus !== corpus || episode.task_id !== task)
      throw new MemoryError(409, "invalid_episode", "Task scope does not match");
    return { record, episode, checkpoint };
  };
  const save = (loaded: ReturnType<typeof load>, episode: MemoryEpisode, part: string) => {
    const saved = repo.revise(
      actor,
      journal,
      loaded.record.id,
      loaded.record.version,
      recordInput({
        content: JSON.stringify(episode),
        type: "episode",
        subject: "marina:task",
        metadata: { format: EPISODE },
      }),
      keyFor(key, `${part}:record`),
    );
    repo.checkpoint(
      actor,
      journal,
      taskName(episode.task_id),
      loaded.checkpoint.version,
      { episode_id: saved.id, corpus, task_id: episode.task_id },
      0,
      keyFor(key, `${part}:checkpoint`),
    );
    return saved;
  };
  if (action === "import_episode") {
    const observation = object(input.observation);
    if (observation.schema !== "marina.memory.observation.v1")
      throw new MemoryError(400, "invalid_input", "Unsupported observation schema");
    const originalInput = object(observation.input),
      result = object(observation.result);
    const goal = textValue(originalInput.task, "task", 8192);
    if (
      result.schema !== "marina.memory.retrieval.v1" ||
      !Array.isArray(result.evidence) ||
      result.evidence.length > 20
    )
      throw new MemoryError(400, "invalid_input", "Import at most 20 selected evidence items");
    const task =
      input.task_id === undefined
        ? `import-${hash([actor.principalId, key]).slice(0, 16)}`
        : textValue(input.task_id, "task_id", 100);
    const receipt = mutate("import_episode", input, () => {
      if (optionalCheckpoint(service, actor, journal, taskName(task)))
        throw new MemoryError(409, "task_exists", "Choose a new task_id");
      const references: MemoryEvidenceReference[] = [];
      for (const [index, raw] of (result.evidence as unknown[]).entries()) {
        const item = object(raw);
        const origin = {
          space_id: textValue(item.space_id, "space_id", 128),
          id: textValue(item.id, "id", 128),
          attribution: textValue(observation.attribution, "attribution", 256),
        };
        if (item.kind === "source") {
          const text = textValue(item.text, "text", 8192);
          const start = integer(item.start, "start", 0, Number.MAX_SAFE_INTEGER),
            end = integer(item.end, "end", start, start + 8192);
          if (Buffer.byteLength(text) !== end - start)
            throw new MemoryError(
              400,
              "invalid_input",
              "Imported range does not match its UTF-8 byte length",
            );
          const saved = repo.capture(
            actor,
            corpus,
            {
              text,
              imported_range: {
                ...origin,
                start,
                end,
                text_hash: textValue(item.text_hash, "text_hash", 128),
              },
            },
            `import:${task}`,
            keyFor(key, `import-source:${index}`),
          );
          const range = repo.sourceWindow(actor, corpus, saved.id, text.slice(0, 80), 8192);
          references.push(reference({ ...range, space_id: corpus, kind: "source" }));
        } else if (item.kind === "record") {
          const saved = repo.remember(
            actor,
            corpus,
            recordInput({
              content: item.content,
              type: "observation",
              claim: item.claim,
              valid_time: item.valid_time,
              metadata: {
                imported_from: {
                  ...origin,
                  version: integer(item.version, "version", 1, Number.MAX_SAFE_INTEGER),
                },
                verification: "not_assessed",
              },
            }),
            keyFor(key, `import-record:${index}`),
          );
          references.push({
            kind: "record",
            space_id: corpus,
            id: saved.id,
            version: saved.version,
          });
        } else
          throw new MemoryError(
            400,
            "invalid_input",
            "Import selected record or source evidence only",
          );
      }
      const now = Date.now();
      const episode: MemoryEpisode = {
        schema: EPISODE,
        task_id: task,
        corpus,
        goal,
        actor: actor.principalId,
        status: "interrupted",
        started_at: now,
        updated_at: now,
        references,
        next_action:
          input.next_action === undefined
            ? "Review the imported observations and retrieve against this corpus before continuing."
            : textValue(input.next_action, "next_action", 4096),
      };
      const saved = repo.remember(
        actor,
        journal,
        recordInput({
          content: JSON.stringify(episode),
          type: "episode",
          subject: "marina:task",
          metadata: {
            format: EPISODE,
            imported_attribution: observation.attribution,
            verification: "not_assessed",
          },
        }),
        keyFor(key, "import-manifest"),
      );
      repo.checkpoint(
        actor,
        journal,
        taskName(task),
        0,
        { episode_id: saved.id, corpus, task_id: task },
        0,
        keyFor(key, "import-checkpoint"),
      );
      return saved;
    });
    return taskHandle(journal, repo.read(actor, journal, receipt.id));
  }
  if (action === "start") {
    const goal = textValue(input.goal, "goal", 8192);
    const task =
      input.task_id === undefined
        ? `task-${hash([actor.principalId, key]).slice(0, 16)}`
        : textValue(input.task_id, "task_id", 100);
    const receipt = mutate("start", input, () => {
      if (optionalCheckpoint(service, actor, journal, taskName(task)))
        throw new MemoryError(
          409,
          "task_exists",
          "Choose a new task_id or resume the existing task",
        );
      const now = Date.now();
      const episode: MemoryEpisode = {
        schema: EPISODE,
        task_id: task,
        corpus,
        goal,
        next_action:
          input.next_action === undefined
            ? "Retrieve evidence for this task."
            : textValue(input.next_action, "next_action", 4096),
        status: "open",
        actor: actor.principalId,
        started_at: now,
        updated_at: now,
        references: [],
      };
      const intent = repo.capture(
        actor,
        journal,
        { schema: "marina.experience.intent.v1", goal, corpus, task_id: task },
        task,
        keyFor(key, "intent"),
      );
      const saved = repo.remember(
        actor,
        journal,
        recordInput({
          content: JSON.stringify(episode),
          type: "episode",
          subject: "marina:task",
          source_ids: [intent.id],
          metadata: { format: EPISODE },
        }),
        keyFor(key, "episode"),
      );
      repo.checkpoint(
        actor,
        journal,
        taskName(task),
        0,
        { episode_id: saved.id, corpus, task_id: task },
        intent.seq!,
        keyFor(key, "checkpoint"),
        [intent.id],
      );
      return { ...saved, task_id: task };
    });
    return taskHandle(journal, repo.read(actor, journal, receipt.id));
  }
  if (action === "tasks") {
    const page = repo.query(actor, journal, {
      type: "episode",
      subject: "marina:task",
      limit: 20,
      cursor: input.cursor as string | undefined,
    });
    return {
      tasks: page.results
        .filter((record) => episodeData(record).corpus === corpus)
        .map((record) => taskHandle(journal, record)),
      next_cursor: page.next_cursor,
    };
  }
  if (["watch", "poll", "ack", "unwatch"].includes(action)) {
    const name = textValue(input.name, "name", 100),
      checkpointName = `watch:${name}`;
    if (action === "watch")
      return mutate("watch", input, () => {
        const ids = input.ids ?? [];
        const head = memoryChanges(repo.raw, actor, corpus, 0, ids, 1).high_watermark;
        const previous = optionalCheckpoint(service, actor, journal, checkpointName);
        if (previous?.data.active)
          throw new MemoryError(
            409,
            "watch_exists",
            "This watch exists; poll it or unwatch before replacing it",
          );
        return repo.checkpoint(
          actor,
          journal,
          checkpointName,
          previous?.version ?? 0,
          { corpus, ids, cursor: head, active: true, checked_at: Date.now() },
          0,
          keyFor(key, "watch:checkpoint"),
        );
      });
    const watched = repo.getCheckpoint(actor, journal, checkpointName);
    if (watched.data.corpus !== corpus || !watched.data.active)
      throw new MemoryError(404, "watch_inactive", "Watch is not active");
    if (action === "poll") {
      const changes = memoryChanges(
        repo.raw,
        actor,
        corpus,
        watched.data.cursor,
        watched.data.ids,
        input.limit,
      );
      const boundaries: number[] = [];
      for (const id of watched.data.ids as string[]) {
        try {
          const record = repo.read(actor, corpus, id);
          for (const time of [record.valid_time?.from, record.valid_time?.until])
            if (time != null) boundaries.push(time);
        } catch (error) {
          if (!(error instanceof MemoryError && error.status === 404)) throw error;
        }
      }
      const now = Date.now(),
        checked = Number(watched.data.checked_at);
      return {
        name,
        version: watched.version,
        changes,
        acknowledgement: {
          cursor: changes.cursor,
          expected_version: watched.version,
          observed_at: now,
        },
        temporal_due: boundaries.some((time) => time > checked && time <= now),
        next_validity_boundary:
          boundaries.filter((time) => time > now).sort((a, b) => a - b)[0] ?? null,
      };
    }
    return mutate(action, input, () => {
      const current = repo.getCheckpoint(actor, journal, checkpointName);
      const expected = integer(
        input.expected_version,
        "expected_version",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (expected !== current.version)
        throw new MemoryError(409, "version_conflict", "Watch changed; poll again");
      const head = memoryChanges(
        repo.raw,
        actor,
        corpus,
        current.data.cursor,
        current.data.ids,
        1,
      ).high_watermark;
      const cursor =
        action === "ack"
          ? integer(input.cursor, "cursor", Number(current.data.cursor), head)
          : Number(current.data.cursor);
      return repo.checkpoint(
        actor,
        journal,
        checkpointName,
        expected,
        {
          ...current.data,
          cursor,
          active: action !== "unwatch",
          checked_at:
            input.observed_at === undefined
              ? current.data.checked_at
              : integer(
                  input.observed_at,
                  "observed_at",
                  Number(current.data.checked_at),
                  Date.now(),
                ),
        },
        0,
        keyFor(key, `${action}:checkpoint`),
      );
    });
  }
  if (typeof input.task_id !== "string" || !input.task_id)
    throw new MemoryError(
      400,
      "invalid_input",
      `workflow ${action} needs input.task_id. Use {"action":"tasks"} to discover IDs, then {"action":"${action}","task_id":"EXACT_ID"}. Use {"action":"help"} for other required fields.`,
    );
  const task = textValue(input.task_id, "task_id", 100);
  if (action === "run") {
    const intent = mutate("run", input, () => {
      const loaded = load(task);
      if (
        loaded.record.version !==
        integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER)
      )
        throw new MemoryError(
          409,
          "version_conflict",
          "Task changed; resume to get its current version",
        );
      if (loaded.episode.status === "running")
        throw new MemoryError(
          409,
          "task_running",
          "Retry the same key, or explicitly finish this interrupted attempt before a new run",
        );
      let selectedRecipe: MemoryEpisode["recipe"];
      let defaults: Record<string, unknown> = {};
      if (input.recipe !== undefined) {
        const selected = object(input.recipe);
        const record = repo.read(
          actor,
          corpus,
          textValue(selected.id, "id", 128),
          integer(selected.version, "version", 1, Number.MAX_SAFE_INTEGER),
        );
        const policy = object(JSON.parse(record.content));
        if (
          policy.schema !== POLICY ||
          policy.compatibility !== "marina.memory.retrieval.v1" ||
          record.freshness !== "current"
        )
          throw new MemoryError(
            409,
            "recipe_changed",
            "Select a current compatible recipe explicitly",
          );
        defaults = object(policy.retrieval);
        if (defaults.use_model || object(input.retrieval ?? {}).use_model)
          throw new MemoryError(
            400,
            "invalid_recipe",
            "Selected recipes cannot enable model planning; use an explicit ordinary run for model planning",
          );
        selectedRecipe = { space_id: corpus, id: record.id, version: record.version };
      }
      const retrieval = {
        ...defaults,
        ...object(input.retrieval ?? {}),
        task: loaded.episode.goal,
        observe: true,
        valid_at: object(input.retrieval ?? {}).valid_at ?? defaults.valid_at ?? Date.now(),
      } as MemoryRetrievalInput;
      return save(
        loaded,
        {
          ...loaded.episode,
          input: retrieval,
          executed_by: actor.principalId,
          recipe: selectedRecipe,
          attempt: keyFor(key, "attempt"),
          status: "running",
          observation: undefined,
          updated_at: Date.now(),
          next_action: "Retrieval is in progress. Retry with the same key after interruption.",
        },
        "run",
      );
    });
    const loaded = load(task);
    if (loaded.episode.attempt !== keyFor(key, "attempt"))
      throw new MemoryError(409, "task_changed", "Another attempt replaced this run");
    if (loaded.record.version !== intent.version)
      return {
        ...taskHandle(journal, loaded.record),
        retrieval: hydrateObservation(service, actor, loaded.episode).result,
      };
    const started = Date.now();
    try {
      const retrieval = await retrieveMemory(
        service,
        actor,
        corpus,
        loaded.episode.input! as unknown as Record<string, unknown>,
        signal,
      );
      if (loaded.episode.recipe) retrieval.selected_recipe = loaded.episode.recipe;
      repo.authorize(actor, corpus);
      signal?.throwIfAborted();
      mutate("run-complete", { task, attempt: loaded.episode.attempt }, () => {
        const current = load(task);
        if (current.record.version !== intent.version)
          throw new MemoryError(409, "version_conflict", "Task changed during retrieval");
        const pins = retrieval.evidence.map(reference);
        const observation = {
          ...retrieval,
          evidence: pins,
          observed_candidates: retrieval.observed_candidates?.map(reference),
        };
        return save(
          current,
          {
            ...current.episode,
            observation,
            references: pins,
            status: "ready",
            updated_at: Date.now(),
            elapsed_ms: Date.now() - started,
            next_action:
              "Inspect the cited evidence, perform the task, then finish and report the outcome.",
          },
          "run-complete",
        );
      });
      return { ...taskHandle(journal, load(task).record), retrieval };
    } catch (error) {
      // Preserve the committed intent on cancellation/crash. Never erase another writer's work.
      if (!signal?.aborted) {
        const current = load(task);
        if (current.record.version === intent.version)
          mutate("run-failed", { task, attempt: loaded.episode.attempt }, () =>
            save(
              current,
              {
                ...current.episode,
                status: "failed",
                updated_at: Date.now(),
                elapsed_ms: Date.now() - started,
                error: {
                  code: error instanceof MemoryError ? error.code : "retrieval_failed",
                  message: getErrorMessage(error).slice(0, 1024),
                },
                next_action: "Inspect the error, then run with a new key and current version.",
              },
              "run-failed",
            ),
          );
      }
      throw error;
    }
  }
  if (action === "finish") {
    if (!["completed", "interrupted", "failed"].includes(String(input.status)))
      throw new MemoryError(400, "invalid_input", "Use completed, interrupted or failed");
    const receipt = mutate("finish", input, () => {
      const current = load(task);
      if (
        current.record.version !==
        integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER)
      )
        throw new MemoryError(409, "version_conflict", "Task changed; resume first");
      return save(
        current,
        {
          ...current.episode,
          status: input.status as MemoryEpisode["status"],
          updated_at: Date.now(),
          next_action: textValue(input.next_action, "next_action", 4096),
        },
        "finish",
      );
    });
    return taskHandle(journal, repo.read(actor, journal, receipt.id));
  }
  const loaded = load(task);
  if (action === "feedback") {
    const rubric = textValue(input.rubric, "rubric", 4096),
      explanation = textValue(input.explanation, "explanation", 8192);
    if (!["helpful", "unhelpful", "pass", "fail", "unknown"].includes(String(input.result)))
      throw new MemoryError(400, "invalid_input", "Unknown outcome result");
    const evidence = input.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 32)
      throw new MemoryError(400, "invalid_input", "Use at most 32 evidence references");
    for (const pin of evidence)
      readReference(service, actor, object(pin) as unknown as MemoryEvidenceReference);
    const metrics = object(input.metrics ?? {});
    for (const [name, value] of Object.entries(metrics)) {
      if (
        !["model_calls", "input_tokens", "output_tokens", "cost_usd", "elapsed_ms"].includes(name)
      )
        throw new MemoryError(400, "invalid_input", "Unknown outcome metric");
      finite(value, name);
    }
    return repo.remember(
      actor,
      journal,
      recordInput({
        type: "observation",
        subject: `outcome:${task}`,
        content: JSON.stringify({
          schema: "marina.experience.outcome.v1",
          episode_id: loaded.record.id,
          episode_version: loaded.record.version,
          evaluator: actor.principalId,
          rubric,
          result: input.result,
          explanation,
          evidence,
          metrics,
          metrics_attribution: "caller_reported",
        }),
        depends_on: [loaded.record.id],
        dependency_versions: { [loaded.record.id]: loaded.record.version },
      }),
      key,
    );
  }
  if (action === "export_episode") {
    repo.authorize(actor, corpus, "memory:export");
    repo.authorize(actor, journal, "memory:export");
    return hydrateObservation(service, actor, loaded.episode);
  }
  if (action === "resume") {
    const premises = loaded.episode.references.map((ref) => {
      let currentVersion: number | undefined;
      let state: "current" | "changed" | "stale" | "unavailable" | "out_of_time" = "current";
      try {
        const item =
          ref.kind === "record"
            ? repo.read(actor, ref.space_id, ref.id)
            : readReference(service, actor, ref);
        if ("version" in item) currentVersion = item.version;
        if ("version" in item && item.version !== ref.version) state = "changed";
        else if ("freshness" in item && item.freshness !== "current") state = "stale";
        else if (
          "valid_time" in item &&
          ((item.valid_time?.from != null && item.valid_time.from > Date.now()) ||
            (item.valid_time?.until != null && item.valid_time.until <= Date.now()))
        )
          state = "out_of_time";
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
        state = "unavailable";
      }
      return {
        reference: ref,
        state,
        ...(currentVersion === undefined
          ? {}
          : {
              current_version: currentVersion,
              read_current: { operation: "get" as const, id: ref.id },
            }),
      };
    });
    const retrieval =
      input.retrieve === true
        ? await retrieveMemory(
            service,
            actor,
            corpus,
            { task: loaded.episode.goal, selection: "balanced" },
            signal,
          )
        : undefined;
    repo.authorize(actor, corpus);
    const { observation: _historicalObservation, ...episode } = loaded.episode;
    return {
      ...taskHandle(journal, loaded.record),
      episode,
      checkpoint: loaded.checkpoint,
      resident_checkpoint: optionalCheckpoint(service, actor, corpus, "resident"),
      premises,
      ...(retrieval ? { retrieval } : {}),
      next_actions: [
        loaded.episode.next_action,
        ...(premises.some((pin) => pin.state !== "current")
          ? [
              "Historical references describe previous reads. Re-read changed premises using read_current (get without version); use current_version for current citations.",
            ]
          : []),
        ...(loaded.episode.status === "running"
          ? [
              "The previous attempt may have been interrupted; retry its idempotency key or explicitly mark it interrupted.",
            ]
          : []),
      ],
    };
  }
  throw new MemoryError(400, "invalid_action", "Unsupported workflow action");
}
