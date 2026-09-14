// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import {
  collectMemoryEvidence,
  type MemoryEvidence,
  validateMemoryAnswer,
} from "../sdk/memory-answer";
import {
  MEMORY_ASSISTANCE_CONTRACT,
  MEMORY_HELPER_ROLES,
  type MemoryAssistanceJob,
} from "../sdk/memory-assistance";
import {
  authorizeMemorySpace,
  captureSource,
  event,
  hash,
  memoryRepository,
  mutation,
  requireActor,
} from "./db-memory-service";
import { enforceMemoryStorage, memoryStorageUsage } from "./db-memory-storage";
import type { MemoryActor } from "./db-principals";

interface Row extends Omit<MemoryAssistanceJob, "work_open"> {
  credential_id: string;
  lease_token: string | null;
  evidence: string;
}
type Pin =
  | Omit<Extract<MemoryEvidence, { kind: "record" }>, "text" | "freshness">
  | Omit<Extract<MemoryEvidence, { kind: "source" }>, "text">;

function fail(code: string, message: string, status = 409): never {
  throw new MemoryError(status, code, message);
}

/** Durable coordination metadata only. Requests are canonical sources and
 * proposals are dependency-pinned records in the existing memory service. */
export function memoryAssistanceRepository(db: Database) {
  const repo = () => memoryRepository(db);
  const row = (id: string): Row =>
    (db.query("SELECT * FROM memory_assistance_jobs WHERE id=?").get(id) as Row) ??
    fail("assistance_not_found", "Assistance request not found", 404);
  const delegator = (job: Row): MemoryActor => ({
    principalId: job.requester_id,
    credentialId: job.credential_id,
    scopes: ["memory:read", "memory:write", "memory:share"],
  });
  function authorized(actor: MemoryActor, id: string): Row {
    requireActor(db, actor, "memory:read");
    const job = row(id);
    const parent = job.parent_id ? row(job.parent_id) : undefined;
    if (![job.requester_id, job.worker_id, parent?.worker_id].includes(actor.principalId))
      fail("assistance_not_found", "Assistance request not found", 404);
    if (
      actor.principalId !== job.requester_id &&
      (job.deadline <= Date.now() || row(job.root_id).state === "cancelled")
    )
      fail("assistance_expired", "Delegated access has expired or been withdrawn");
    // Delegation never outlives the credential or the original space authority.
    authorizeMemorySpace(db, delegator(job), job.space_id, "memory:share");
    return job;
  }
  function active(job: Row) {
    const root = row(job.root_id);
    if (job.deadline <= Date.now() || root.state === "cancelled")
      fail("assistance_expired", "The assistance deadline or root request is no longer active");
    if (!["pending", "running"].includes(job.state))
      fail("assistance_finished", "The assistance request is already finished");
    // Completion of any ancestor closes its outstanding delegation.
    let parent = job.parent_id ? row(job.parent_id) : undefined;
    while (parent) {
      if (!["pending", "running"].includes(parent.state))
        fail("assistance_finished", "The parent request is already finished");
      parent = parent.parent_id ? row(parent.parent_id) : undefined;
    }
  }
  function leased(actor: MemoryActor, id: string, token: unknown) {
    const job = authorized(actor, id);
    active(job);
    if (
      job.worker_id !== actor.principalId ||
      job.state !== "running" ||
      !token ||
      token !== job.lease_token ||
      (job.lease_until ?? 0) <= Date.now()
    )
      fail("assistance_lease_required", "A current claim by the assigned worker is required");
    return job;
  }
  function action<T>(actor: MemoryActor, job: Row, key: string, input: unknown, run: () => T): T {
    textValue(key, "idempotency key", 128);
    const fingerprint = hash(input);
    const previous = db
      .query(
        "SELECT fingerprint,response FROM memory_assistance_actions WHERE job_id=? AND principal_id=? AND request_key=?",
      )
      .get(job.id, actor.principalId, key) as { fingerprint: string; response: string } | null;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail("idempotency_conflict", "This key was used for different input");
      return JSON.parse(previous.response) as T;
    }
    const count = db
      .query("SELECT count(*) AS n FROM memory_assistance_actions WHERE job_id=?")
      .get(job.id) as { n: number };
    if (count.n >= 256) fail("assistance_budget", "Assistance action limit reached");
    const before = memoryStorageUsage(db, job.requester_id).usage;
    const result = run();
    db.run("INSERT INTO memory_assistance_actions VALUES (?,?,?,?,?)", [
      job.id,
      actor.principalId,
      key,
      fingerprint,
      JSON.stringify(result),
    ]);
    enforceMemoryStorage(db, job.requester_id, before);
    return result;
  }
  function view(job: Row): MemoryAssistanceJob {
    const { credential_id: _credential, lease_token: _token, evidence: _evidence, ...value } = job;
    let workOpen = true;
    try {
      active(job);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      workOpen = false;
    }
    return {
      ...value,
      work_open: workOpen,
      remaining_operations: row(job.root_id).remaining_operations,
    };
  }
  function charge(job: Row) {
    const result = db.run(
      "UPDATE memory_assistance_jobs SET remaining_operations=remaining_operations-1 WHERE id=? AND remaining_operations>0",
      [job.root_id],
    );
    if (!result.changes) fail("assistance_budget", "The shared root operation budget is exhausted");
  }
  function insert(actor: MemoryActor, space: string, raw: unknown, parent?: Row) {
    const input = object(raw);
    const task = textValue(input.task, "task", 8192);
    const worker = textValue(input.worker_id, "worker_id", 128);
    const role = textValue(input.role, "role", 32) as Row["role"];
    if (!MEMORY_HELPER_ROLES.includes(role))
      fail("invalid_input", "Use librarian, reflector or evaluator", 400);
    if (!db.query("SELECT 1 FROM principals WHERE principal_id=? AND status='active'").get(worker))
      fail("invalid_worker", "The assigned worker must be an active principal", 400);
    if (worker === actor.principalId)
      fail("assistance_cycle", "Assign assistance to another participant");
    let ancestor = parent;
    while (ancestor) {
      if (ancestor.worker_id === worker)
        fail("assistance_cycle", "Delegation would revisit an ancestor worker");
      ancestor = ancestor.parent_id ? row(ancestor.parent_id) : undefined;
    }
    if (parent && parent.depth >= 3)
      fail("assistance_depth", "The delegation depth limit is three");
    const total = db
      .query("SELECT count(*) AS n FROM memory_assistance_jobs WHERE requester_id=?")
      .get(actor.principalId) as { n: number };
    if (total.n >= 1024)
      fail(
        "assistance_budget",
        "Forget completed request sources before creating more than 1024 requests",
      );
    if (parent) {
      const children = db
        .query("SELECT count(*) AS n FROM memory_assistance_jobs WHERE root_id=?")
        .get(parent.root_id) as { n: number };
      if (children.n >= 8)
        fail("assistance_budget", "The root request supports at most eight workers");
      charge(parent);
    }
    const id = crypto.randomUUID();
    const source = captureSource(
      db,
      actor,
      space,
      { format: "marina.memory.assistance.request.v1", task, role, worker_id: worker },
      `assistance:${id}`,
      `assist-input:${id}`,
    );
    const timeout = integer(input.timeout_ms ?? 600000, "timeout_ms", 1000, 3600000);
    const budget = integer(input.max_operations ?? 32, "max_operations", 1, 128);
    db.run(
      `INSERT INTO memory_assistance_jobs
      (id,space_id,requester_id,credential_id,worker_id,role,parent_id,root_id,depth,deadline,remaining_operations,input_source_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        space,
        actor.principalId,
        actor.credentialId,
        worker,
        role,
        parent?.id ?? null,
        parent?.root_id ?? id,
        (parent?.depth ?? -1) + 1,
        parent?.deadline ?? Date.now() + timeout,
        budget,
        source.id,
        Date.now(),
      ],
    );
    event(db, actor, space, "assistance.created", id);
    return { id };
  }
  return {
    create(actor: MemoryActor, space: string, input: unknown, key: string) {
      authorizeMemorySpace(db, actor, space, "memory:share");
      return mutation(db, actor, space, key, "assistance.create", input, () =>
        insert(actor, space, input),
      );
    },
    list(actor: MemoryActor, raw: unknown = {}) {
      return db.transaction(() => {
        requireActor(db, actor, "memory:read");
        const input = object(raw);
        if (input.open !== undefined && typeof input.open !== "boolean")
          fail("invalid_input", "open must be boolean", 400);
        const open = input.open === true;
        const limit = integer(input.limit ?? 100, "limit", 1, 100);
        let beforeTime = Number.MAX_SAFE_INTEGER,
          beforeId = "";
        if (input.cursor !== undefined) {
          try {
            const cursor = object(
              JSON.parse(
                Buffer.from(textValue(input.cursor, "cursor", 1024), "base64url").toString(),
              ),
            );
            if (cursor.actor !== actor.principalId || cursor.open !== open)
              fail("invalid_cursor", "Cursor belongs to a different actor or filter", 400);
            beforeTime = integer(cursor.time, "cursor time", 0, Number.MAX_SAFE_INTEGER);
            beforeId = textValue(cursor.id, "cursor id", 128);
          } catch {
            fail(
              "invalid_cursor",
              "Use the returned cursor with the same actor and open filter",
              400,
            );
          }
        }
        // Filter work before LIMIT: completed history must not hide assignments.
        // Keyset pages scan bounded metadata, then check live authorization.
        const candidates = db
          .query(`SELECT id,created_at FROM memory_assistance_jobs
          WHERE (worker_id=? OR requester_id=?)
          AND (?=0 OR (state IN ('pending','running') AND deadline>?))
          AND (created_at<? OR (created_at=? AND id>?))
          ORDER BY created_at DESC,id LIMIT ?`)
          .all(
            actor.principalId,
            actor.principalId,
            open ? 1 : 0,
            Date.now(),
            beforeTime,
            beforeTime,
            beforeId,
            limit + 1,
          ) as { id: string; created_at: number }[];
        const page = candidates.slice(0, limit);
        const last = page.at(-1);
        return {
          jobs: page.flatMap((candidate) => {
            try {
              const job = view(authorized(actor, candidate.id));
              return open && !job.work_open ? [] : [job];
            } catch (error) {
              if (
                !(error instanceof MemoryError) ||
                ![401, 403, 404, 409, 410].includes(error.status)
              )
                throw error;
              return [];
            }
          }),
          next_cursor:
            candidates.length > limit && last
              ? Buffer.from(
                  JSON.stringify({
                    actor: actor.principalId,
                    open,
                    time: last.created_at,
                    id: last.id,
                  }),
                ).toString("base64url")
              : null,
        };
      })();
    },
    summary(actor: MemoryActor, id: string) {
      return view(authorized(actor, id));
    },
    get(actor: MemoryActor, id: string) {
      const job = authorized(actor, id);
      const source = db
        .query("SELECT body FROM memory_sources WHERE id=? AND space_id=?")
        .get(job.input_source_id, job.space_id) as { body: string } | null;
      if (!source) fail("assistance_not_found", "Request source was forgotten", 404);
      const value = view(job);
      value.task = JSON.parse(source.body).task;
      if (job.result_record_id) {
        const result = repo().read(delegator(job), job.space_id, job.result_record_id);
        if (result.freshness !== "current" || result.version !== 1)
          fail(
            "assistance_stale",
            "The proposal or its evidence changed; inspect the record directly or request a new review",
          );
        value.result = JSON.parse(result.content);
      }
      return value;
    },
    claim(actor: MemoryActor, id: string, key: string) {
      return db.transaction(() => {
        const job = authorized(actor, id);
        if (actor.principalId !== job.worker_id)
          fail(
            "assistance_worker_required",
            "Only the assigned worker may claim this request",
            403,
          );
        active(job);
        return action(actor, job, key, { operation: "claim" }, () => {
          if (job.state === "running" && (job.lease_until ?? 0) > Date.now())
            fail("assistance_claimed", "This request already has a live claim");
          const token = crypto.randomUUID();
          const until = Math.min(Date.now() + 120000, job.deadline);
          db.run(
            "UPDATE memory_assistance_jobs SET state='running',lease_token=?,lease_until=?,version=version+1,evidence='[]' WHERE id=?",
            [token, until, id],
          );
          event(db, actor, job.space_id, "assistance.claimed", id);
          return { id, lease_token: token, lease_until: until };
        });
      })();
    },
    heartbeat(actor: MemoryActor, id: string, token: unknown, key: string) {
      return db.transaction(() => {
        const job = leased(actor, id, token);
        return action(actor, job, key, { operation: "heartbeat", token }, () => {
          const until = Math.min(Date.now() + 120000, job.deadline);
          db.run("UPDATE memory_assistance_jobs SET lease_until=? WHERE id=?", [until, id]);
          return { id, lease_until: until };
        });
      })();
    },
    cancel(actor: MemoryActor, id: string) {
      return db.transaction(() => {
        const job = authorized(actor, id);
        if (actor.principalId !== job.requester_id)
          fail("assistance_owner_required", "Only the requester may cancel assistance", 403);
        if (["pending", "running"].includes(job.state)) {
          db.run(
            "UPDATE memory_assistance_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,evidence='[]',version=version+1 WHERE id=?",
            [id],
          );
          event(db, actor, job.space_id, "assistance.cancelled", id);
        }
        return { id, state: row(id).state };
      })();
    },
    delegate(actor: MemoryActor, id: string, raw: unknown, key: string) {
      return db.transaction(() => {
        const input = object(raw);
        const job = leased(actor, id, input.lease_token);
        return action(actor, job, key, { operation: "delegate", input }, () =>
          insert(delegator(job), job.space_id, input, job),
        );
      })();
    },
    beginRead(actor: MemoryActor, id: string, raw: unknown, key: string) {
      return db.transaction(() => {
        const input = object(raw);
        const job = leased(actor, id, input.lease_token);
        action(actor, job, key, { operation: "read", input }, () => {
          charge(job);
          return { id };
        });
        return { actor: delegator(job), space: job.space_id };
      })();
    },
    witness(actor: MemoryActor, id: string, token: unknown, response: unknown) {
      return db.transaction(() => {
        const job = leased(actor, id, token);
        const before = memoryStorageUsage(db, job.requester_id).usage;
        const evidence = new Map<string, Pin>();
        const add = (pin: Pin) => {
          const key =
            pin.kind === "record"
              ? JSON.stringify([pin.kind, pin.id])
              : JSON.stringify([pin.kind, pin.id, pin.start, pin.end, pin.text_hash]);
          evidence.set(key, pin);
        };
        for (const pin of JSON.parse(job.evidence) as Pin[]) add(pin);
        for (const item of collectMemoryEvidence(response, job.space_id)) {
          const { text: _text, ...pin } = item;
          add(pin);
        }
        if (evidence.size > 256) fail("assistance_budget", "The evidence limit is 256 reads");
        db.run("UPDATE memory_assistance_jobs SET evidence=? WHERE id=?", [
          JSON.stringify([...evidence.values()]),
          id,
        ]);
        enforceMemoryStorage(db, job.requester_id, before);
      })();
    },
    isInputSource(space: string, id: string): boolean {
      return Boolean(
        db
          .query(
            "SELECT 1 FROM memory_sources WHERE id=? AND space_id=? AND json_extract(body,'$.format')='marina.memory.assistance.request.v1'",
          )
          .get(id, space),
      );
    },
    finish(actor: MemoryActor, id: string, raw: unknown, key: string) {
      return db.transaction(() => {
        const input = object(raw);
        const job = authorized(actor, id);
        if (actor.principalId !== job.worker_id || input.lease_token !== job.lease_token)
          fail("assistance_worker_required", "The claimed worker must submit the result", 403);
        return action(actor, job, key, { operation: "finish", input }, () => {
          leased(actor, id, input.lease_token);
          textValue(JSON.stringify(input.completion), "completion", 32768);
          const evidence: MemoryEvidence[] = [];
          const owner = delegator(job);
          const memory = repo();
          for (const pin of JSON.parse(job.evidence) as Pin[]) {
            try {
              if (pin.kind === "record") {
                const current = memory.read(owner, job.space_id, pin.id);
                if (current.version === pin.version && current.freshness === "current")
                  evidence.push(...collectMemoryEvidence(current, job.space_id));
              } else {
                const current = memory.sourceRange(
                  owner,
                  job.space_id,
                  pin.id,
                  pin.start,
                  pin.end,
                  pin.text_hash,
                );
                evidence.push(...collectMemoryEvidence(current, job.space_id));
              }
            } catch (error) {
              if (!(error instanceof MemoryError) || ![404, 409, 410].includes(error.status))
                throw error;
            }
          }
          const checked = validateMemoryAnswer(
            MEMORY_ASSISTANCE_CONTRACT,
            input.completion,
            evidence,
          );
          if (!checked.ok) fail("assistance_evidence_required", checked.errors.join("; "), 400);
          const result = checked.value;
          // Conservatively pin every witnessed read, not merely the citations
          // a model chooses to declare: uncited copied evidence can also affect
          // its output. Changed/forgotten observations require a fresh attempt.
          const witnessed = JSON.parse(job.evidence) as Pin[];
          if (result.status === "answered" && evidence.length !== witnessed.length)
            fail(
              "assistance_stale",
              "Evidence changed during the attempt; reread or start a fresh claim",
            );
          const pins = Object.fromEntries(
            evidence.filter((c) => c.kind === "record").map((c) => [c.id, c.version]),
          );
          const saved = memory.remember(
            owner,
            job.space_id,
            {
              content: JSON.stringify(result),
              type: "inference",
              tier: "reflection",
              metadata: {
                format: "marina.memory.assistance.result.v1",
                job_id: id,
                author_id: actor.principalId,
                role: job.role,
                authority: "proposal",
                citation_validation: "exact-read-and-current-version",
              },
              depends_on: Object.keys(pins),
              dependency_versions: pins,
              source_ids: [
                ...new Set([
                  job.input_source_id,
                  ...evidence.filter((c) => c.kind === "source").map((c) => c.id),
                ]),
              ],
            },
            `assist-result:${id}`,
          );
          db.run(
            "UPDATE memory_assistance_jobs SET state=?,result_record_id=?,version=version+1 WHERE id=?",
            [result.status, saved.id, id],
          );
          event(db, actor, job.space_id, "assistance.completed", id);
          return { id, state: result.status, result_record_id: saved.id };
        });
      })();
    },
  };
}
