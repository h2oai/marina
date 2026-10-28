// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { EvidenceSource } from "../decisions/evidence";
import { canonicalFederationJson } from "../net/federation-crypto";
import type { MarinaDB } from "../persistence/database";
import type { TaskRow } from "../persistence/db-tasks";
import {
  type ArtifactCheckReport,
  type ArtifactEdit,
  type ArtifactRule,
  type ArtifactRuleInput,
  artifactAt,
  artifactPathsOverlap,
  artifactRuleMatches,
  editTaskArtifact,
  type ResolvedArtifactEdit,
  validateArtifactRule,
  validateArtifactValue,
} from "./task-artifact";
import {
  type ArtifactReviewAnswer,
  type ArtifactReviewQuestion,
  artifactReviewPacket,
  compareArtifactReview,
  includesSourceSelection,
  ruleApplies,
  selectArtifactSource,
} from "./task-artifact-review";
import type {
  CitationStatus,
  TaskWorkDocument,
  WorkAction,
  WorkCheckReport,
  WorkCitation,
  WorkConstraint,
  WorkEntry,
  WorkPatch,
  WorkValue,
} from "./task-work-types";

export type WorkActor = { id: string; name: string };
export type WorkSourceResolver = (actor: WorkActor, ref: string) => EvidenceSource;

/** Receipts are advisory and local: no judge calls, automatic approval or loop effects. */
export const WORK_CHECK_TTL_MS = 60 * 60_000;
const CHECK_SCOPE =
  "Only registered fields and declared constraints were checked. Source quotations are verified, but interpretation and completeness are not. This is not task approval.";
const empty = (): TaskWorkDocument => ({
  format: 1,
  fields: {},
  fieldRevisions: {},
  citations: [],
  constraints: [],
  proposals: [],
});
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalFederationJson(value)).digest("hex");
const has = (object: object, key: string) => Object.hasOwn(object, key);

function requireField(field: string): void {
  if (
    typeof field !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field) ||
    ["__proto__", "constructor", "prototype"].includes(field)
  )
    throw new Error(
      "Field names must start with a letter and contain only letters, digits, dots, underscores or hyphens (up to 128 characters).",
    );
}

export function isWorkValue(value: unknown): value is WorkValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function validateWorkPatch(patch: unknown): asserts patch is WorkPatch {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).length === 0
  )
    throw new Error("Supply a nonempty JSON object of field values.");
  for (const [field, value] of Object.entries(patch)) {
    requireField(field);
    if (!isWorkValue(value))
      throw new Error(`Field ${field} must be a string, finite number, boolean or null.`);
  }
}

function citationStatus(citation: WorkCitation, source: EvidenceSource): CitationStatus {
  if (citation.retired) return "retired";
  if (source.status !== "current") return source.status;
  return source.version === citation.sourceVersion ? "current" : "changed";
}

function matches(actual: WorkValue, constraint: WorkConstraint): boolean {
  if (constraint.op === "eq") return actual === constraint.expected;
  if (constraint.op === "oneOf") return (constraint.expected as WorkValue[]).includes(actual);
  if (typeof actual !== "number" || typeof constraint.expected !== "number") return false;
  return constraint.op === "lte" ? actual <= constraint.expected : actual >= constraint.expected;
}

/**
 * Opt-in shared task state. Nothing here intercepts ordinary task submissions,
 * changes an agent's prompts, wakes a peer, suppresses a message or grants standing.
 */
export class TaskWork {
  constructor(
    private readonly db: MarinaDB,
    private readonly resolveSource: WorkSourceResolver,
  ) {}

  private task(taskId: number, actor: WorkActor): TaskRow {
    const task = this.db.getTask(taskId);
    if (!task || (task.group_id && !this.db.getGroupMember(task.group_id, actor.id)))
      throw new Error("Task not found or not accessible.");
    return task;
  }

  private canEdit(task: TaskRow, actor: WorkActor): boolean {
    if (task.creator_id === actor.id) return true;
    const claim = this.db.getTaskClaim(task.id, actor.id);
    return (
      !!claim &&
      (claim.status === "submitted" ||
        (claim.status === "claimed" &&
          (claim.lease_expires_at === null || claim.lease_expires_at > Date.now())))
    );
  }

  private load(taskId: number, revision?: number) {
    const row = this.db.getTaskWorkRevision(taskId, revision);
    if (revision !== undefined && revision !== 0 && !row)
      throw new Error("Work revision not found.");
    return {
      revision: row?.revision ?? 0,
      document: row ? (JSON.parse(row.document) as TaskWorkDocument) : empty(),
    };
  }

  private sources(
    document: TaskWorkDocument,
    actor: WorkActor,
    includeRetired = true,
  ): Map<string, EvidenceSource> {
    const sources = new Map<string, EvidenceSource>();
    for (const citation of document.citations) {
      if (!includeRetired && citation.retired) continue;
      if (!sources.has(citation.ref))
        sources.set(citation.ref, this.resolveSource(actor, citation.ref));
    }
    return sources;
  }

  /** Historical views use today's ACL; old private source contents are never replayed. */
  show(taskId: number, actor: WorkActor, revision?: number) {
    const task = this.task(taskId, actor);
    const state = this.load(taskId, revision);
    const sources = this.sources(state.document, actor);
    const citations = state.document.citations.map((citation) => {
      const source = sources.get(citation.ref)!;
      return {
        // A private-source digest can reveal low-entropy facts by guessing.
        // Offsets also disclose private source shape; neither belongs in a view.
        id: citation.id,
        field: citation.field,
        ref: citation.ref,
        authorId: citation.authorId,
        ...(citation.retired ? { retired: citation.retired } : {}),
        status: citationStatus(citation, source),
        ...(source.text !== undefined && source.version === citation.sourceVersion
          ? { quote: source.text.slice(citation.start, citation.end) }
          : {}),
      };
    });
    const { artifact, ...scalarWork } = state.document;
    return {
      taskId,
      revision: state.revision,
      reviewer: task.creator_name,
      owners: this.db
        .getTaskClaims(taskId)
        .filter(
          (claim) =>
            claim.status === "submitted" ||
            (claim.status === "claimed" &&
              (claim.lease_expires_at === null || claim.lease_expires_at > Date.now())),
        )
        .map((claim) => claim.entity_name),
      ...scalarWork,
      ...(artifact
        ? {
            artifact: {
              value: artifact.value,
              rules: artifact.rules.map((rule) => this.artifactRuleView(rule, actor)),
            },
          }
        : {}),
      citations,
      guidance:
        "Optional shared work. Owners edit fields; collaborators can propose changes and attach sources. Checks are advisory; ordinary submit/approve remains available.",
    };
  }

  private artifactRuleView(rule: ArtifactRule, actor: WorkActor) {
    const { source, selectionVersion, ...declared } = rule;
    if (rule.selection) {
      const resolved = this.resolveSource(actor, rule.selection.ref);
      return {
        ...declared,
        source: undefined,
        evidence:
          resolved.status !== "current"
            ? resolved.status
            : resolved.version === selectionVersion
              ? "current"
              : "changed",
      };
    }
    if (!source) return { ...declared, source: undefined };
    const resolved = this.resolveSource(actor, source.ref);
    return {
      ...declared,
      source: {
        ref: source.ref,
        status:
          resolved.status !== "current"
            ? resolved.status
            : resolved.version === source.sourceVersion
              ? "current"
              : "changed",
        ...(resolved.text !== undefined && resolved.version === source.sourceVersion
          ? { quote: resolved.text.slice(source.start, source.end) }
          : {}),
      },
    };
  }

  /** The returned content is the deliverable itself, ready for a client to save verbatim. */
  renderArtifact(taskId: number, actor: WorkActor, revision?: number) {
    this.task(taskId, actor);
    const state = this.load(taskId, revision);
    if (!state.document.artifact)
      throw new Error("No JSON artifact yet. Use artifact-edit to create it.");
    const content = `${JSON.stringify(state.document.artifact.value, null, 2)}\n`;
    return {
      taskId,
      revision: state.revision,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      rules: state.document.artifact.rules.map((rule) => this.artifactRuleView(rule, actor)),
      projections: state.document.artifact.projections ?? [],
      scope:
        "This is the authored JSON deliverable. Its contents are shared with task readers. Rendering does not certify its interpretation or completeness.",
    };
  }

  /** Explicit publication: selected readable source values become shared artifact content. */
  publishArtifactSource(
    taskId: number,
    actor: WorkActor,
    revision: number,
    input: { path: string; ref: string; pick: Record<string, string> },
  ) {
    return this.editArtifact(taskId, actor, revision, [{ ...input, op: "source" }]);
  }

  private resolveArtifactEdit(actor: WorkActor, input: ArtifactEdit): ResolvedArtifactEdit {
    if (input?.op !== "source") return input as ResolvedArtifactEdit;
    if (
      typeof input.ref !== "string" ||
      !input.pick ||
      typeof input.pick !== "object" ||
      Array.isArray(input.pick) ||
      !Object.keys(input.pick).length
    )
      throw new Error(
        "Supply a source reference and a nonempty pick map of output names to source JSON Pointers.",
      );
    const source = this.resolveSource(actor, input.ref);
    if (source.text === undefined)
      throw new Error("Source unavailable to this reader; nothing was published.");
    let value: unknown;
    try {
      value = JSON.parse(source.text);
    } catch {
      value = source.text;
    }
    validateArtifactValue(value);
    const selected = Object.fromEntries(
      Object.entries(input.pick).map(([key, path]) => {
        const found = artifactAt(value, path);
        if (!found.present) throw new Error(`Source path not found: ${path}`);
        return [key, found.value];
      }),
    );
    return { op: "append", path: input.path, value: selected };
  }

  editArtifact(taskId: number, actor: WorkActor, baseRevision: number, edits: ArtifactEdit[]) {
    return this.db.transaction(() => {
      const task = this.task(taskId, actor);
      if (!this.canEdit(task, actor))
        throw new Error(
          "Only the task creator or current claimant edits the artifact. Claim the task to collaborate.",
        );
      const state = this.load(taskId);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision > state.revision)
        throw new Error("Invalid artifact base revision.");
      this.load(taskId, baseRevision);
      if (!Array.isArray(edits) || !edits.length) throw new Error("Supply a nonempty edits array.");
      const edited = editTaskArtifact(
        state.document.artifact ?? { value: null, pathRevisions: {}, rules: [] },
        edits.map((edit) => this.resolveArtifactEdit(actor, edit)),
        baseRevision,
        state.revision + 1,
      );
      if (!state.document.artifact && !edited.changedPaths.length) {
        edited.changedPaths.push("");
        edited.artifact.pathRevisions[""] = state.revision + 1;
      }
      if (edited.changedPaths.length) {
        edited.artifact.lastEdit = {
          authorId: this.db.durableEntityKey(actor.id),
          operations: edits.map((edit) => ({
            op: edit.op,
            path: edit.path,
            ...("reason" in edit ? { reason: edit.reason } : {}),
            ...(edit.op === "source" ? { ref: edit.ref, pick: edit.pick } : {}),
            ...(edit.op === "project" ? { scopePath: edit.scopePath } : {}),
          })),
        };
        state.document.artifact = edited.artifact;
        if (
          !this.db.appendTaskWorkRevision({
            taskId,
            expectedRevision: state.revision,
            authorId: actor.id,
            authorName: actor.name,
            action: "artifact-edit",
            document: JSON.stringify(state.document),
          })
        )
          throw new Error(
            "Artifact changed while saving; read the current artifact before retrying.",
          );
      }
      return {
        ...this.renderArtifact(taskId, actor),
        changedPaths: edited.changedPaths,
        rebased: baseRevision !== state.revision,
      };
    });
  }

  declareArtifactRule(
    taskId: number,
    actor: WorkActor,
    expectedRevision: number,
    input: ArtifactRuleInput,
  ) {
    this.task(taskId, actor);
    validateArtifactRule(input);
    const state = this.load(taskId);
    if (state.revision !== expectedRevision)
      throw new Error("Work changed; read the current artifact before declaring a check.");
    const artifact = state.document.artifact;
    if (!artifact) throw new Error("Create the artifact before declaring a check.");
    const authorId = this.db.durableEntityKey(actor.id);
    const existing = artifact.rules.find((rule) => rule.id === input.id);
    if (
      existing &&
      existing.authorId !== authorId &&
      !this.canEdit(this.task(taskId, actor), actor)
    )
      throw new Error("Only a check's author or task owner can update it.");
    const rule: ArtifactRule = {
      id: input.id,
      path: input.path,
      op: input.op,
      authorId,
      ...(input.expected !== undefined ? { expected: input.expected } : {}),
      ...(input.when ? { when: input.when } : {}),
    };
    if (input.selection) {
      const source = this.resolveSource(actor, input.selection.ref);
      selectArtifactSource(source, input.selection);
      rule.selection = structuredClone(input.selection);
      rule.selectionVersion = source.version;
    }
    if (input.source) {
      if (
        typeof input.source.ref !== "string" ||
        typeof input.source.quote !== "string" ||
        !input.source.quote.trim()
      )
        throw new Error("A source check needs a reference and nonempty verbatim quotation.");
      const source = this.resolveSource(actor, input.source.ref);
      if (source.status !== "current" || source.text === undefined || !source.version)
        throw new Error("Declare a check from current evidence you can read.");
      const start = source.text.indexOf(input.source.quote);
      if (start < 0) throw new Error("Quotation is not present in the accessible source.");
      rule.source = {
        ref: input.source.ref,
        sourceVersion: source.version,
        start,
        end: start + input.source.quote.length,
      };
    }
    if (existing && digest(existing) === digest(rule))
      return { revision: state.revision, changed: false };
    artifact.rules = [...artifact.rules.filter((entry) => entry.id !== rule.id), rule];
    const row = this.db.appendTaskWorkRevision({
      taskId,
      expectedRevision,
      authorId: actor.id,
      authorName: actor.name,
      action: "artifact-rule",
      document: JSON.stringify(state.document),
    });
    if (!row) throw new Error("Artifact changed while saving its check.");
    return { revision: row.revision, changed: true };
  }

  /** One atomic declaration avoids each tool in a model's batch invalidating the next. */
  declareArtifactRules(
    taskId: number,
    actor: WorkActor,
    revision: number,
    rules: ArtifactRuleInput[],
  ) {
    return this.db.transaction(() => {
      if (!Array.isArray(rules) || !rules.length) throw new Error("Supply a nonempty rules array.");
      if (new Set(rules.map((rule) => rule?.id)).size !== rules.length)
        throw new Error("A rule batch must have distinct IDs.");
      let current = revision;
      for (const rule of rules)
        current = this.declareArtifactRule(taskId, actor, current, rule).revision;
      return { revision: current, changed: current !== revision };
    });
  }

  removeArtifactRule(
    taskId: number,
    actor: WorkActor,
    expectedRevision: number,
    id: string,
    reason: string,
  ) {
    const task = this.task(taskId, actor);
    const state = this.load(taskId);
    if (state.revision !== expectedRevision)
      throw new Error("Work changed; read the current artifact before removing a check.");
    const artifact = state.document.artifact;
    const rule = artifact?.rules.find((entry) => entry.id === id);
    if (!rule || !artifact) throw new Error("Artifact check not found.");
    if (!this.canEdit(task, actor) && rule.authorId !== this.db.durableEntityKey(actor.id))
      throw new Error("Only a check's author or task owner can remove it.");
    if (typeof reason !== "string" || !reason.trim())
      throw new Error("Removing a check requires a reason.");
    artifact.rules = artifact.rules.filter((entry) => entry.id !== id);
    artifact.lastEdit = {
      authorId: this.db.durableEntityKey(actor.id),
      operations: [{ op: "remove-rule", path: id, reason }],
    };
    const row = this.db.appendTaskWorkRevision({
      taskId,
      expectedRevision,
      authorId: actor.id,
      authorName: actor.name,
      action: "artifact-unrule",
      document: JSON.stringify(state.document),
    });
    if (!row) throw new Error("Artifact changed while removing its check.");
    return { revision: row.revision, changed: true };
  }

  reviewArtifact(taskId: number, actor: WorkActor, questions: ArtifactReviewQuestion[]) {
    const task = this.task(taskId, actor);
    const state = this.load(taskId);
    if (!state.document.artifact) throw new Error("Create an artifact before requesting a review.");
    return artifactReviewPacket({
      taskId,
      revision: state.revision,
      value: state.document.artifact.value,
      requirements: {
        title: task.title,
        description: task.description,
        prerequisites: task.prerequisites,
        deliverables: task.deliverables,
      },
      reader: this.db.durableEntityKey(actor.id),
      questions,
      resolve: (ref) => this.resolveSource(actor, ref),
    });
  }

  assessArtifact(
    taskId: number,
    actor: WorkActor,
    input: {
      fingerprint: string;
      questions: ArtifactReviewQuestion[];
      answers: ArtifactReviewAnswer[];
    },
    now = Date.now(),
  ) {
    return this.db.transaction(() => {
      const packet = this.reviewArtifact(taskId, actor, input.questions);
      if (packet.fingerprint !== input.fingerprint)
        throw new Error("Review context changed. Obtain a new packet; no assessment was recorded.");
      const state = this.load(taskId);
      const artifact = state.document.artifact!;
      const authorId = this.db.durableEntityKey(actor.id);
      const checks = compareArtifactReview(artifact.value, packet, input.answers, (path) => {
        const revisions = Object.entries(artifact.pathRevisions)
          .filter(([changed]) => artifactPathsOverlap(changed, path))
          .map(([, revision]) => revision);
        return revisions.some(
          (revision) => this.db.getTaskWorkRevision(taskId, revision)?.author_id === authorId,
        );
      });
      const report = {
        contract: "artifact-evidence-assessment-v1",
        revision: state.revision,
        reviewer: actor.name,
        checks,
        outcome: checks.some((check) => check.status === "disagrees")
          ? "disagreements"
          : checks.some((check) => check.status === "unverified")
            ? "unverified"
            : "agrees-with-assessment",
        scope:
          "Compared the draft with supplied source-cited answers. Quotations are checked, not their entailment or coverage. Different authors and an answer-free packet do not prove independent reasoning. This is advisory and does not approve the task.",
      };
      const fingerprint = digest([packet.fingerprint, input.answers]);
      const cached = this.db.getTaskWorkCheck(taskId, actor.id, fingerprint, now);
      if (cached)
        return {
          receiptId: cached.id,
          reused: true,
          report,
          createdAt: cached.created_at,
          expiresAt: cached.expires_at,
        };
      const receipt = this.db.putTaskWorkCheck({
        taskId,
        reviewerId: actor.id,
        fingerprint,
        report: JSON.stringify(report),
        createdAt: now,
        expiresAt: now + WORK_CHECK_TTL_MS,
      });
      return {
        receiptId: receipt.id,
        reused: false,
        report,
        createdAt: receipt.created_at,
        expiresAt: receipt.expires_at,
      };
    });
  }

  checkArtifact(taskId: number, actor: WorkActor, fresh = false, now = Date.now()) {
    return this.db.transaction(() => {
      const task = this.task(taskId, actor);
      const state = this.load(taskId);
      const artifact = state.document.artifact;
      if (!artifact) throw new Error("Create an artifact before checking it.");
      const sources = artifact.rules.map((rule) => {
        const ref = rule.selection?.ref ?? rule.source?.ref;
        return ref ? this.resolveSource(actor, ref) : undefined;
      });
      const fingerprint = digest([
        "declared-task-artifact-v2",
        state.revision,
        artifact,
        task.title,
        task.description,
        task.prerequisites,
        task.deliverables,
        sources.map((source) => (source ? [source.status, source.version ?? null] : null)),
      ]);
      const cached = fresh
        ? undefined
        : this.db.getTaskWorkCheck(taskId, actor.id, fingerprint, now);
      if (cached)
        return {
          receiptId: cached.id,
          reused: true,
          createdAt: cached.created_at,
          expiresAt: cached.expires_at,
          report: JSON.parse(cached.report) as ArtifactCheckReport,
        };
      const checks: ArtifactCheckReport["checks"] = artifact.rules.map((rule, index) => {
        let actual: ReturnType<typeof artifactAt>;
        try {
          actual = artifactAt(artifact.value, rule.path);
        } catch {
          actual = { present: false };
        }
        const source = sources[index];
        const evidence =
          !rule.source && !rule.selection
            ? "undeclared"
            : source?.status !== "current"
              ? source!.status
              : source.version !==
                  (rule.selection ? rule.selectionVersion : rule.source!.sourceVersion)
                ? "changed"
                : "current";
        const active = ruleApplies(artifact.value, rule);
        let selection: ReturnType<typeof selectArtifactSource> | undefined;
        if (rule.selection && evidence === "current")
          selection = selectArtifactSource(source!, rule.selection);
        const matches =
          rule.op === "includesSource"
            ? !!selection && actual.present && includesSourceSelection(actual.value, selection)
            : artifactRuleMatches(artifact.value, rule);
        return {
          id: rule.id,
          path: rule.path,
          op: rule.op,
          ...(rule.expected !== undefined ? { expected: rule.expected } : {}),
          ...(selection ? { expected: selection } : {}),
          ...(actual.present ? { actual: actual.value } : {}),
          evidence,
          status: !active
            ? "inactive"
            : (rule.source || rule.selection) && evidence !== "current"
              ? "unverified"
              : matches
                ? "matches"
                : "discrepancy",
        };
      });
      const projections: NonNullable<ArtifactCheckReport["projections"]> = (
        artifact.projections ?? []
      ).map((projection) => {
        try {
          const scope = artifactAt(artifact.value, projection.scopePath);
          const batch = scope.present
            ? projection.batches.find((entry) => digest(entry.scope) === digest(scope.value))
            : undefined;
          const actual = artifactAt(artifact.value, projection.path);
          return {
            path: projection.path,
            scopePath: projection.scopePath,
            status: !batch
              ? "unverified"
              : actual.present && digest(actual.value) === digest(batch.entries)
                ? "matches"
                : "discrepancy",
          };
        } catch {
          return { path: projection.path, scopePath: projection.scopePath, status: "unverified" };
        }
      });
      const active = checks.filter((check) => check.status !== "inactive");
      const coverage = checks.filter(
        (check) => check.op === "includesSource" && check.status !== "inactive",
      );
      const report: ArtifactCheckReport = {
        contract: "declared-task-artifact-v1",
        revision: state.revision,
        checks,
        projections,
        coverage: {
          declared: artifact.rules.filter((rule) => rule.op === "includesSource").length,
          active: coverage.length,
          matched: coverage.filter((check) => check.status === "matches").length,
          complete: coverage.length ? coverage.every((check) => check.status === "matches") : null,
        },
        outcome: [...active, ...projections].some((check) => check.status === "discrepancy")
          ? "discrepancies"
          : (!active.length && !projections.length) ||
              [...active, ...projections].some((check) => check.status === "unverified")
            ? "unverified"
            : "matches-declared-checks",
        scope:
          "Only listed active checks and recorded projections were evaluated. Coverage concerns declared source selections only; null means none are active. Matching does not confirm semantic support, missing requirements or task approval. Use an answer-free review packet for a separate evidence assessment.",
      };
      const receipt = this.db.putTaskWorkCheck({
        taskId,
        reviewerId: actor.id,
        fingerprint,
        report: JSON.stringify(report),
        createdAt: now,
        expiresAt: now + WORK_CHECK_TTL_MS,
      });
      return {
        receiptId: receipt.id,
        reused: false,
        createdAt: receipt.created_at,
        expiresAt: receipt.expires_at,
        report,
      };
    });
  }

  apply(taskId: number, actor: WorkActor, expectedRevision: number, action: WorkAction) {
    const task = this.task(taskId, actor);
    const state = this.load(taskId);
    if (state.revision !== expectedRevision)
      throw new Error(
        `Work changed: expected revision ${expectedRevision}, current ${state.revision}. Read the current work before retrying.`,
      );
    const document = state.document;
    const before = canonicalFederationJson(document);
    const authorId = this.db.durableEntityKey(actor.id);
    const canEdit = this.canEdit(task, actor);
    const ownerOnly = () => {
      if (!canEdit)
        throw new Error(
          "Only the task creator or current claimant edits the draft. Use propose to suggest a field change.",
        );
    };
    const id = (prefix: string) => `${prefix}${state.revision + 1}`;
    const fieldRevision = (field: string) =>
      has(document.fieldRevisions, field) ? document.fieldRevisions[field]! : 0;
    const patchFields = (patch: WorkPatch) => {
      for (const [field, value] of Object.entries(patch)) {
        if (!has(document.fields, field) || document.fields[field] !== value) {
          document.fields[field] = value;
          document.fieldRevisions[field] = state.revision + 1;
        }
      }
    };
    if (action.kind === "patch" || action.kind === "propose") {
      validateWorkPatch(action.patch);
      if (action.kind === "patch") {
        ownerOnly();
        patchFields(action.patch);
      } else {
        const base = Object.fromEntries(
          Object.keys(action.patch).map((field) => [
            field,
            has(document.fields, field)
              ? {
                  present: true,
                  value: document.fields[field],
                  revision: fieldRevision(field),
                }
              : { present: false, revision: 0 },
          ]),
        );
        const duplicate = document.proposals.some(
          (proposal) =>
            !proposal.accepted &&
            !proposal.retired &&
            proposal.authorId === authorId &&
            digest([proposal.patch, proposal.base]) === digest([action.patch, base]),
        );
        if (!duplicate)
          document.proposals.push({ id: id("p"), authorId, patch: action.patch, base });
      }
    } else if (action.kind === "accept") {
      ownerOnly();
      const proposal = document.proposals.find(
        (entry) => entry.id === action.id && !entry.retired && !entry.accepted,
      );
      if (!proposal) throw new Error("Pending proposal not found.");
      for (const [field, base] of Object.entries(proposal.base)) {
        if (
          has(document.fields, field) !== base.present ||
          fieldRevision(field) !== base.revision ||
          (base.present && document.fields[field] !== base.value)
        )
          throw new Error(
            `Proposal is stale for ${field}; inspect the current value and propose an updated change.`,
          );
      }
      patchFields(proposal.patch);
      proposal.accepted = { authorId };
    } else if (action.kind === "cite") {
      requireField(action.field);
      if (!has(document.fields, action.field))
        throw new Error("Create the field before attaching evidence.");
      if (typeof action.quote !== "string" || !action.quote.trim())
        throw new Error("A nonempty verbatim quotation is required.");
      const source = this.resolveSource(actor, action.ref);
      if (source.text === undefined || !source.version)
        throw new Error("Source unavailable to this reader; no citation was removed or replaced.");
      const start = source.text.indexOf(action.quote);
      if (start < 0) throw new Error("Quotation is not present in the accessible source.");
      const citation = {
        field: action.field,
        ref: action.ref,
        sourceVersion: source.version,
        start,
        end: start + action.quote.length,
      };
      if (
        !document.citations.some(
          (entry) =>
            !entry.retired &&
            entry.field === citation.field &&
            entry.ref === citation.ref &&
            entry.sourceVersion === citation.sourceVersion &&
            entry.start === citation.start &&
            entry.end === citation.end,
        )
      )
        document.citations.push({ id: id("c"), authorId, ...citation });
    } else if (action.kind === "expect") {
      requireField(action.field);
      if (!has(document.fields, action.field))
        throw new Error("Create the field before declaring a check.");
      if (!["eq", "lte", "gte", "oneOf"].includes(action.op))
        throw new Error("Check operator must be eq, lte, gte or oneOf.");
      if (
        action.op === "oneOf"
          ? !Array.isArray(action.expected) ||
            !action.expected.length ||
            !action.expected.every(isWorkValue)
          : !isWorkValue(action.expected) ||
            ((action.op === "lte" || action.op === "gte") && typeof action.expected !== "number")
      )
        throw new Error("Expected value does not match the check operator.");
      const citation = document.citations.find(
        (entry) => entry.id === action.citation && entry.field === action.field && !entry.retired,
      );
      if (
        !citation ||
        citationStatus(citation, this.resolveSource(actor, citation.ref)) !== "current"
      )
        throw new Error(
          "Declare the check using a current citation for this field that you can read.",
        );
      const constraint = {
        field: action.field,
        op: action.op,
        expected: action.expected,
        citation: action.citation,
      };
      if (
        !document.constraints.some(
          (entry) =>
            !entry.retired &&
            digest([entry.field, entry.op, entry.expected, entry.citation]) ===
              digest([constraint.field, constraint.op, constraint.expected, constraint.citation]),
        )
      )
        document.constraints.push({ id: id("k"), authorId, ...constraint });
    } else {
      const entry: WorkEntry | undefined = [
        ...document.citations,
        ...document.constraints,
        ...document.proposals,
      ].find((item) => item.id === action.id);
      if (!entry) throw new Error("Work entry not found.");
      if (!canEdit && entry.authorId !== authorId)
        throw new Error("Only the entry author or task owner may retire it.");
      if (typeof action.reason !== "string" || !action.reason.trim())
        throw new Error("Retirement requires a reason; history is preserved.");
      if (!entry.retired) entry.retired = { authorId, reason: action.reason.trim() };
    }
    if (before === canonicalFederationJson(document))
      return { revision: state.revision, changed: false };
    const row = this.db.appendTaskWorkRevision({
      taskId,
      expectedRevision,
      authorId: actor.id,
      authorName: actor.name,
      action: action.kind,
      document: JSON.stringify(document),
    });
    if (!row)
      throw new Error("Work changed while saving; read the current revision before retrying.");
    return { revision: row.revision, changed: true };
  }

  check(taskId: number, actor: WorkActor, fresh = false, now = Date.now()) {
    return this.db.transaction(() => this.checkCurrent(taskId, actor, fresh, now));
  }

  private checkCurrent(taskId: number, actor: WorkActor, fresh: boolean, now: number) {
    const task = this.task(taskId, actor);
    const { revision, document } = this.load(taskId);
    // Resolve before cache lookup, so ACL, content and verification changes invalidate reuse.
    const sources = this.sources(document, actor, false);
    const fingerprint = digest([
      "declared-task-work-v1",
      revision,
      document,
      [task.title, task.description, task.prerequisites, task.deliverables],
      [...sources].map(([ref, source]) => [ref, source.status, source.version ?? null]),
    ]);
    const cached = fresh ? undefined : this.db.getTaskWorkCheck(taskId, actor.id, fingerprint, now);
    if (cached)
      return {
        receiptId: cached.id,
        reused: true,
        createdAt: cached.created_at,
        expiresAt: cached.expires_at,
        report: JSON.parse(cached.report) as WorkCheckReport,
      };
    const citations: WorkCheckReport["citations"] = document.citations
      .filter((entry) => !entry.retired)
      .map((citation) => ({
        id: citation.id,
        field: citation.field,
        ref: citation.ref,
        status: citationStatus(citation, sources.get(citation.ref)!),
      }));
    const checks: WorkCheckReport["checks"] = document.constraints
      .filter((entry) => !entry.retired)
      .map((constraint) => {
        const present = has(document.fields, constraint.field);
        const actual = document.fields[constraint.field];
        const supported = citations.some(
          (citation) => citation.id === constraint.citation && citation.status === "current",
        );
        return {
          id: constraint.id,
          field: constraint.field,
          op: constraint.op,
          expected: constraint.expected,
          citation: constraint.citation,
          ...(present ? { actual } : {}),
          status:
            !present || !supported
              ? "unverified"
              : matches(actual!, constraint)
                ? "matches"
                : "contradiction",
        };
      });
    const uncheckedFields = Object.keys(document.fields).filter(
      (field) => !checks.some((check) => check.field === field && check.status !== "unverified"),
    );
    const pendingProposals = document.proposals
      .filter((proposal) => !proposal.accepted && !proposal.retired)
      .map((proposal) => proposal.id);
    const report: WorkCheckReport = {
      contract: "declared-task-work-v1",
      revision,
      outcome: checks.some((check) => check.status === "contradiction")
        ? "discrepancies"
        : checks.length === 0 ||
            checks.some((check) => check.status === "unverified") ||
            citations.some((citation) => citation.status !== "current") ||
            uncheckedFields.length > 0 ||
            pendingProposals.length > 0
          ? "unverified"
          : "consistent",
      citations,
      checks,
      uncheckedFields,
      pendingProposals,
      scope: CHECK_SCOPE,
    };
    const receipt = this.db.putTaskWorkCheck({
      taskId,
      reviewerId: actor.id,
      fingerprint,
      report: JSON.stringify(report),
      createdAt: now,
      expiresAt: now + WORK_CHECK_TTL_MS,
    });
    return {
      receiptId: receipt.id,
      reused: false,
      createdAt: receipt.created_at,
      expiresAt: receipt.expires_at,
      report,
    };
  }
}
