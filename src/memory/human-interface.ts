// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest, MemoryOperationResult } from "../sdk/memory-operations";

export const MEMORY_SERVICE_HELP = `Portable memory service (private to your durable world account):
  memory guide                         practical quickstart and interface examples
  memory start <goal>                   preserve a task before doing work
  memory tasks [CURSOR]                 find saved tasks by goal; follow pagination
  memory run <TASK_ID> <VERSION>         retrieve and capture an inspectable episode
  memory resume <TASK_ID>                next action, changed premises and checkpoint
  memory finish <TASK_ID> <VERSION> <completed|interrupted|failed> <next action>
  memory feedback <TASK_ID> <helpful|unhelpful|pass|fail|unknown> <explanation>
  memory recipes                        list explicitly selectable retrieval procedures
  memory recipe <ID> <VERSION> <task>    use one recipe for one retrieval
  memory recipe-save <JSON recipe>      store a portable procedure; never auto-activate
  memory watch <NAME> [RECORD_ID ...]    watch selected premises (omit IDs for all changes)
  memory changes [CURSOR]               poll the authorized durable change feed
  memory poll <NAME>                    read changes; repeat safely before acknowledging
  memory ack <NAME> <VERSION> <CURSOR> [OBSERVED_AT]   acknowledge processed notifications
  memory unwatch <NAME> <VERSION>       cancel a watch
  memory retrieve <task>                find and read citable evidence within a byte budget
  memory assist <role> <helper> <task>    delegate reading; roles: librarian, reflector, evaluator
  memory jobs [JSON filters]             list assistance; open:true selects unfinished live work
  memory assistance <ID>                 inspect a request and its cited proposal
  memory assist-cancel <ID>              withdraw a request and its delegated access
  memory adopt <ID> [space <SPACE_ID>] [JSON]
                                         adopt an answered proposal as your own record
                                         (into an institutional space = ratification;
                                         JSON: {"rationale":"..."}); credits the helper
  memory adopt <ID> confirm-abstention   credit an honest abstention (requester only)
  memory service                         show service capabilities
  memory usage                           show your storage usage and limits
  memory transfers [JSON filters]         discover your staged imports
  memory transfer <ID>                    inspect an import
  memory transfer-abort <ID>              explicitly discard unpublished staging
  memory review [JSON filters]            review stale/competing/pending assertions
  memory reaffirm <ID> <version> <JSON pins>
                                         reaffirm after explicitly reviewing premises
  memory resolve <ID> <policy> <JSON>     settle competing assertions; policies:
                                         last_writer_wins, evidence_weighted,
                                         await_confirmation, keep_both;
                                         JSON: {"competing":[IDs],"rationale":"..."}
  memory remember <text>                 store a plain memory
  memory claim <subject> <predicate> <JSON scalar>
  memory relate <subject> <predicate> <entity ID>
  memory query <JSON filters>            exact symbolic query; {} lists records
  memory join <JSON patterns>            typed joins with supporting record versions
  memory rule-save <JSON request>        author or revise a bounded symbolic rule
  memory rule-run <JSON request>         inspect conclusions without saving them
  memory rule-materialize <JSON request> explicitly save dependency-pinned conclusions
  memory graph <subject>                 follow asserted relationships
  memory show <record ID>                inspect a full record and provenance
  memory sources <query>                 search original source text
  memory source <source ID> [start end]  read a stable UTF-8 byte range
  memory federation                     list explicitly mounted peers
  memory across <JSON query>            search explicitly selected peers
  memory plan <task>                     inspect a bounded retrieval plan
  memory vocabulary                      inspect the current vocabulary
  memory api <JSON request>              full service operations
Symbols are exact and case-sensitive. Claims are assertions, not verified truth.
Example: memory claim project:marina status "active"
Example: memory query {"subject":"project:marina","predicate":"status"}`;

export function parseMemoryServiceCommand(args: string): MemoryOperationRequest | undefined {
  const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const sub = match?.[1]?.toLowerCase(),
    rest = match?.[2] ?? "";
  const json = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      throw new MemoryClientError(
        400,
        "invalid_json",
        "Expected valid JSON; quote string literals with double quotes",
      );
    }
  };
  switch (sub) {
    case "guide":
      return { operation: "workflow", input: { action: "help" } };
    case "start":
      return { operation: "workflow", input: { action: "start", goal: rest } };
    case "tasks":
    case "recipes":
      return { operation: "workflow", input: { action: sub, ...(rest ? { cursor: rest } : {}) } };
    case "resume":
      return { operation: "workflow", input: { action: "resume", task_id: rest } };
    case "run": {
      const fields = rest.match(/^(\S+)\s+(\d+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use memory run TASK_ID VERSION (both returned by start or resume)",
        );
      return {
        operation: "workflow",
        input: { action: "run", task_id: fields[1], expected_version: Number(fields[2]) },
      };
    }
    case "finish": {
      const fields = rest.match(/^(\S+)\s+(\d+)\s+(completed|interrupted|failed)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use memory finish TASK_ID VERSION completed|interrupted|failed NEXT_ACTION",
        );
      return {
        operation: "workflow",
        input: {
          action: "finish",
          task_id: fields[1],
          expected_version: Number(fields[2]),
          status: fields[3],
          next_action: fields[4],
        },
      };
    }
    case "feedback": {
      const fields = rest.match(/^(\S+)\s+(helpful|unhelpful|pass|fail|unknown)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use memory feedback TASK_ID helpful|unhelpful|pass|fail|unknown EXPLANATION",
        );
      return {
        operation: "workflow",
        input: {
          action: "feedback",
          task_id: fields[1],
          result: fields[2],
          explanation: fields[3],
          rubric: "Participant-reported task outcome",
        },
      };
    }
    case "recipe-save":
      return { operation: "workflow", input: { action: "save_recipe", recipe: json(rest) } };
    case "recipe": {
      const fields = rest.match(/^(\S+)\s+(\d+)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(400, "invalid_input", "Use memory recipe ID VERSION TASK");
      return {
        operation: "workflow",
        input: { action: "use_recipe", id: fields[1], version: Number(fields[2]), task: fields[3] },
      };
    }
    case "watch": {
      const [name, ...ids] = rest.split(/\s+/);
      return { operation: "workflow", input: { action: "watch", name, ids } };
    }
    case "poll":
      return { operation: "workflow", input: { action: "poll", name: rest } };
    case "changes":
      return {
        operation: "workflow",
        input: { action: "changes", cursor: rest ? Number(rest) : 0 },
      };
    case "ack":
    case "unwatch": {
      const fields = rest.match(/^(\S+)\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?$/);
      if (!fields || (sub === "ack" && !fields[3]))
        throw new MemoryClientError(
          400,
          "invalid_input",
          `Use memory ${sub} NAME VERSION${sub === "ack" ? " CURSOR" : ""}`,
        );
      return {
        operation: "workflow",
        input: {
          action: sub,
          name: fields[1],
          expected_version: Number(fields[2]),
          ...(fields[3] ? { cursor: Number(fields[3]) } : {}),
          ...(fields[4] ? { observed_at: Number(fields[4]) } : {}),
        },
      };
    }
    case "assist": {
      const fields = rest.match(/^(librarian|reflector|evaluator)\s+(\S+)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use: memory assist librarian|reflector|evaluator HELPER TASK",
        );
      return {
        operation: "assist_create",
        input: { role: fields[1], worker_name: fields[2], task: fields[3] },
      };
    }
    case "jobs":
      return { operation: "assist_jobs", input: json(rest || "{}") };
    case "assistance":
      return { operation: "assist_get", id: rest };
    case "assist-cancel":
      return { operation: "assist_cancel", id: rest };
    case "adopt": {
      const fields = rest.match(
        /^(\S+)(?:\s+space\s+(\S+))?(?:\s+(confirm-abstention))?(?:\s+(\{[\s\S]*\}))?\s*$/,
      );
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use: memory adopt JOB [space SPACE_ID] [confirm-abstention] [JSON options]",
        );
      const options = fields[4] ? json(fields[4]) : {};
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new MemoryClientError(400, "invalid_input", "Adopt options must be a JSON object");
      return {
        operation: "adopt",
        id: fields[1],
        ...(fields[2] ? { space_id: fields[2] } : {}),
        input: { ...options, ...(fields[3] ? { confirm_abstention: true } : {}) },
      };
    }
    case "transfers":
      return { operation: "transfers", input: json(rest || "{}") };
    case "transfer":
      return { operation: "transfer_status", id: rest };
    case "transfer-abort":
      return { operation: "transfer_abort", id: rest };
    case "federation":
      return { operation: "federation_mounts" };
    case "across":
      return { operation: "federated_search", input: json(rest) };
    case "review":
      return { operation: "review", input: json(rest || "{}") };
    case "reaffirm": {
      const fields = rest.match(/^(\S+)\s+(\d+)\s+([\s\S]+)$/);
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          "Use: memory reaffirm ID VERSION JSON_DEPENDENCY_VERSIONS",
        );
      return {
        operation: "reaffirm",
        id: fields[1],
        input: { expected_version: Number(fields[2]), dependency_versions: json(fields[3]!) },
      };
    }
    case "resolve": {
      const fields = rest.match(
        /^(\S+)\s+(last_writer_wins|evidence_weighted|await_confirmation|keep_both)\s+([\s\S]+)$/,
      );
      if (!fields)
        throw new MemoryClientError(
          400,
          "invalid_input",
          'Use: memory resolve ID last_writer_wins|evidence_weighted|await_confirmation|keep_both {"competing":[IDs],"rationale":"..."}',
        );
      const options = json(fields[3]!);
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new MemoryClientError(400, "invalid_input", "Resolve options must be a JSON object");
      return { operation: "resolve", id: fields[1], input: { ...options, policy: fields[2] } };
    }
    case "usage":
      return { operation: "usage" };
    case "service":
      return { operation: "capabilities" };
    case "api":
      return json(rest);
    case "remember":
      return { operation: "remember", input: { content: rest } };
    case "query":
      return { operation: "query", input: json(rest || "{}") };
    case "join":
      return { operation: "join", input: json(rest) };
    case "rule-save":
      return { operation: "save_rule", input: json(rest) };
    case "rule-run":
      return { operation: "run_rule", input: json(rest) };
    case "rule-materialize":
      return { operation: "materialize_rule", input: json(rest) };
    case "sources":
      return { operation: "source_search", input: { query: rest } };
    case "source": {
      const fields = rest.match(/^(\S+)(?:\s+(\d+)(?:\s+(\d+))?)?$/);
      if (!fields)
        throw new MemoryClientError(400, "invalid_input", "Use: memory source ID [START [END]]");
      return {
        operation: "source_range",
        id: fields[1],
        input: {
          ...(fields[2] ? { start: Number(fields[2]) } : {}),
          ...(fields[3] ? { end: Number(fields[3]) } : {}),
        },
      };
    }
    case "plan":
      return { operation: "plan", input: { task: rest } };
    case "retrieve":
      return { operation: "retrieve", input: { task: rest } };
    case "vocabulary":
      return { operation: "vocabulary" };
    case "graph":
      return { operation: "graph", input: { subject: rest } };
    case "show":
      return { operation: "get", id: rest };
    case "claim":
    case "relate": {
      const claim = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!claim)
        throw new MemoryClientError(
          400,
          "invalid_input",
          `Usage: memory ${sub} <subject> <predicate> <object>`,
        );
      return {
        operation: "remember",
        input: {
          content: rest,
          claim: {
            subject: claim[1],
            predicate: claim[2],
            object:
              sub === "relate"
                ? { kind: "entity", id: claim[3] }
                : { kind: "literal", value: json(claim[3]!) },
          },
        },
      };
    }
    default:
      return undefined;
  }
}

export function formatMemoryOperation(result: MemoryOperationResult): string {
  if (!result.ok) return `Memory error (${result.error.code}): ${result.error.message}`;
  const value = result.result as Record<string, unknown> | null;
  if (value?.schema === "marina.memory.workflow-guide.v1") return MEMORY_SERVICE_HELP;
  const lines: string[] = [];
  if (value && Array.isArray(value.tasks)) {
    const tasks = value.tasks as {
      task_id: string;
      version: number;
      status: string;
      goal: string;
    }[];
    if (!tasks.length)
      lines.push("No saved tasks on this page. Start one with memory start <goal>.");
    for (const task of tasks)
      lines.push(`${task.task_id} — ${task.status}, v${task.version}: ${task.goal.slice(0, 240)}`);
    if (value.next_cursor) lines.push(`Next page: memory tasks ${value.next_cursor}`);
    if (tasks.length) lines.push("Continue with memory resume <TASK_ID>.");
  }
  if (value && typeof value.task_id === "string") {
    lines.push(`Task ${value.task_id} — ${value.status}, version ${value.version}`);
    if (typeof value.goal === "string") lines.push(value.goal);
    if (Array.isArray(value.next_actions)) lines.push(...value.next_actions.map(String));
    if (["open", "failed", "interrupted"].includes(String(value.status)))
      lines.push(`Next: memory run ${value.task_id} ${value.version}`);
    if (value.status === "ready")
      lines.push(
        `After working: memory finish ${value.task_id} ${value.version} completed <result or next action>`,
      );
    if (Array.isArray(value.premises))
      for (const pin of value.premises as { reference: { id: string }; state: string }[])
        lines.push(`Premise ${pin.reference.id}: ${pin.state}`);
  }
  const retrieval =
    value?.schema === "marina.memory.retrieval.v1"
      ? value
      : (value?.retrieval as Record<string, unknown> | undefined);
  if (retrieval && Array.isArray(retrieval.evidence)) {
    lines.push(
      `Evidence: ${retrieval.evidence.length} items. Sufficiency remains for you to assess.`,
    );
    for (const item of retrieval.evidence as Record<string, unknown>[])
      lines.push(
        item.kind === "source"
          ? `[source ${item.id} bytes ${item.start}–${item.end}] ${item.text}`
          : `[record ${item.id} v${item.version}] ${item.content}`,
      );
    const diagnostic = retrieval.diagnostics as { next_actions?: string[] } | undefined;
    lines.push(...(diagnostic?.next_actions ?? []));
  }
  if (value && typeof value.name === "string" && value.acknowledgement) {
    const ack = value.acknowledgement as {
      expected_version: number;
      cursor: number;
      observed_at: number;
    };
    lines.push(
      `Watch ${value.name}: ${JSON.stringify(value.changes)}`,
      `After processing: memory ack ${value.name} ${ack.expected_version} ${ack.cursor} ${ack.observed_at}`,
    );
    if (value.temporal_due)
      lines.push("A watched validity boundary has passed; re-read the premise.");
  }
  if (lines.length) return lines.join("\n");
  // Structured perception data remains lossless even when human output is compact.
  return `Memory service${result.space_id ? ` — space ${result.space_id}` : ""}\n${JSON.stringify(result.result, null, 2)}`;
}
