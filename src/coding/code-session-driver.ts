// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../agent/agent-types";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../persistence/database";
import type { Entity } from "../types";
import type { WorkspaceDescriptor } from "./local-workspace";
import {
  formatProjectInstructions,
  loadProjectInstructions,
  projectInstructionMetadata,
} from "./project-instructions";
import { beginCodingRun, codingRunMetadata, endCodingRun } from "./task-run";

const ACTIVE_SESSION_KEY = "coding_session_id";
const ACTIVE_MODAL_KEY = "active_modal";
const CODE_PROFILE_KEY = "code_profile";
const ACTIVE_TASK_KEY = "coding_task";

export interface CodePromptRequest {
  actor: string;
  modelTarget?: string;
  profile: string;
  prompt: string;
  sessionId: string;
  workspaceRoot: string;
}

export type CodePromptAnswerer = (request: CodePromptRequest) => Promise<string | undefined>;

export interface CodingAgentRuntime {
  get(name: string): AgentHandle | undefined;
  isAvailable?(): boolean;
  list?(): { name: string }[];
  spawn?(config: {
    goal?: string;
    model?: string;
    name: string;
    role?: string;
    spawnedBy?: string;
  }): Promise<AgentHandle>;
}

export interface CodeSessionDriverDeps {
  answerPrompt?: CodePromptAnswerer;
  agentRuntime?: CodingAgentRuntime;
  db: MarinaDB;
  getEntity?: (id: string) => Entity | undefined;
  describeWorkspace?: (session: CodingSessionRow) => WorkspaceDescriptor | undefined;
  onRun?: (run: CodingArtifactRow, handle: AgentHandle) => void;
  onRunEnd?: (run: CodingArtifactRow) => void;
}

export class CodeSessionDriver {
  constructor(private readonly deps: CodeSessionDriverDeps) {}

  async runDirect(opts: {
    actor: string;
    modelTarget?: string;
    profile: string;
    prompt: string;
    session: CodingSessionRow;
  }): Promise<CodingArtifactRow> {
    const prompt = opts.prompt.trim();
    if (!prompt) throw new Error("Usage: code ask <request>");
    if (!this.deps.answerPrompt) {
      throw new Error("Direct code model routing is not available in this Marina process.");
    }

    this.deps.db.updateCodingSession(opts.session.id, { mode: "direct" });
    this.deps.db.createCodingEvent({
      sessionId: opts.session.id,
      actor: opts.actor,
      kind: "code_prompt_started",
      payload: { strategy: "direct", profile: opts.profile, prompt, modelTarget: opts.modelTarget },
    });

    try {
      const answer = await this.deps.answerPrompt({
        actor: opts.actor,
        modelTarget: opts.modelTarget,
        profile: opts.profile,
        prompt,
        sessionId: opts.session.id,
        workspaceRoot: opts.session.workspace_root,
      });
      const text = answer?.trim() || "(no response)";
      const artifact = this.deps.db.createCodingArtifact({
        sessionId: opts.session.id,
        kind: "agent_response",
        title: formatPromptTitle("Direct answer", prompt),
        status: "complete",
        contentText: text,
        metadata: {
          strategy: "direct",
          profile: opts.profile,
          prompt,
          modelTarget: opts.modelTarget,
        },
        createdBy: opts.actor,
      });
      this.deps.db.createCodingEvent({
        sessionId: opts.session.id,
        actor: opts.actor,
        kind: "code_prompt_completed",
        payload: {
          strategy: "direct",
          profile: opts.profile,
          artifactId: artifact.id,
          modelTarget: opts.modelTarget,
        },
      });
      return artifact;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const artifact = this.deps.db.createCodingArtifact({
        sessionId: opts.session.id,
        kind: "agent_response",
        title: formatPromptTitle("Direct answer failed", prompt),
        status: "failed",
        contentText: message,
        metadata: {
          strategy: "direct",
          profile: opts.profile,
          prompt,
          modelTarget: opts.modelTarget,
        },
        createdBy: opts.actor,
      });
      this.deps.db.createCodingEvent({
        sessionId: opts.session.id,
        actor: opts.actor,
        kind: "code_prompt_failed",
        payload: {
          strategy: "direct",
          profile: opts.profile,
          artifactId: artifact.id,
          message,
          modelTarget: opts.modelTarget,
        },
      });
      throw err;
    }
  }

  async assignAgent(opts: {
    actor: string;
    agentName: string;
    actorEntity?: Entity;
    modelTarget?: string;
    verificationRequirement?: "candidate" | "checks";
    ownerMode?: "unattended";
    profile: string;
    prompt: string;
    session: CodingSessionRow;
  }): Promise<CodingArtifactRow> {
    const prompt = opts.prompt.trim();
    if (!opts.agentName || !prompt) throw new Error("Usage: code assign <agent> <request>");
    if (!this.deps.agentRuntime) {
      throw new Error("Agent assignment is not available in this Marina process.");
    }

    const agent = this.deps.agentRuntime.get(opts.agentName);
    if (!agent) throw new Error(`Agent "${opts.agentName}" is not running.`);
    const initialSession = this.deps.db.getCodingSession(opts.session.id);
    if (
      !initialSession ||
      initialSession.workspace_root !== opts.session.workspace_root ||
      initialSession.worktree_path !== opts.session.worktree_path ||
      initialSession.execution_target !== opts.session.execution_target ||
      initialSession.status !== opts.session.status
    ) {
      throw new Error(
        "Coding session changed before loading instructions. Inspect status and retry.",
      );
    }
    const initialRun = this.deps.db.listCodingRuns({ sessionId: opts.session.id, limit: 1 })[0];
    const workerId = agent.getStatus().entityId;
    const instructions = await loadProjectInstructions({
      root: opts.session.worktree_path ?? opts.session.workspace_root,
      executionTarget: opts.session.execution_target,
    });
    const currentSession = this.deps.db.getCodingSession(opts.session.id);
    const currentRun = this.deps.db.listCodingRuns({ sessionId: opts.session.id, limit: 1 })[0];
    if (
      !currentSession ||
      currentSession.workspace_root !== opts.session.workspace_root ||
      currentSession.worktree_path !== opts.session.worktree_path ||
      currentSession.execution_target !== opts.session.execution_target ||
      currentSession.status !== opts.session.status ||
      currentSession.agent !== initialSession.agent ||
      currentSession.writer !== initialSession.writer ||
      currentSession.driver !== initialSession.driver ||
      currentRun?.id !== initialRun?.id ||
      currentRun?.status !== initialRun?.status
    ) {
      throw new Error(
        "Coding session changed while loading instructions. Inspect status and retry.",
      );
    }
    if (
      this.deps.agentRuntime.get(opts.agentName) !== agent ||
      agent.getStatus().entityId !== workerId
    ) {
      throw new Error(
        `Agent "${opts.agentName}" changed while loading instructions. Retry assignment.`,
      );
    }
    const workspaceDescriptor = this.deps.describeWorkspace?.(opts.session);
    const instructionMetadata = projectInstructionMetadata(instructions);
    const worker = workerId ? this.deps.getEntity?.(workerId) : undefined;
    if ((opts.verificationRequirement || opts.ownerMode) && (!opts.actorEntity || !worker))
      throw new Error("Task contracts need a bound Marina worker.");
    const run =
      opts.actorEntity && worker
        ? beginCodingRun(this.deps.db, {
            session: opts.session,
            owner: opts.actorEntity,
            worker,
            prompt,
            profile: opts.profile,
            modelTarget: opts.modelTarget,
            runtimeName: agent.name,
            verificationRequirement: opts.verificationRequirement,
            ownerMode: opts.ownerMode,
          })
        : undefined;
    if (run) this.deps.onRun?.(run, agent);
    const requirement =
      run && codingRunMetadata(run).verificationRequirement === "candidate"
        ? "Completion requires current candidate verification: use marina_code verify with verificationMode=candidate, inspect its receipt/result, then summary. Early summaries remain progress. If blocked, use marina_code blocked with the reason; do not loop indefinitely. Honor existing operator authorization for bounded dependency preparation."
        : run && codingRunMetadata(run).verificationRequirement === "checks"
          ? "Completion requires current task checks. Use code verify or a saved validation recipe; inspect the receipt before summary. Validate the requested artifact or service state, including failure cases; whitespace alone is insufficient. These are live checks, not immutable source evidence. If blocked, use code blocked <reason>."
          : undefined;
    const ownership =
      run && codingRunMetadata(run).ownerMode === "unattended"
        ? `The owner is unattended. Progress notes need no ownership transfer. If you hand the write lock back to the owner while this task remains active, you are authorized to reclaim it with code writer ${worker!.name}. This does not authorize taking a collaborator's lock or restarting a finished task.`
        : undefined;
    // The resident's bounded reminder may truncate a long request. Keep the
    // completion contract and a durable full-request pointer ahead of it.
    const activeTask = run
      ? [
          `Task #${codingRunMetadata(run).taskId}; full request: code show ${run.id} (marina_code action=show, artifactId=${run.id}). Read the full request before editing; this reminder may be abbreviated.`,
          requirement,
          ownership,
          prompt,
        ]
          .filter(Boolean)
          .join("\n\n")
      : prompt;
    const boundEntity = this.bindAgentEntity(agent, opts.session, opts.profile, activeTask);
    // Task mode: the adapter suppresses its low-value cognitive sections and
    // restates this task every cycle until code.ts clears it (stop/summary).
    agent.setActiveCodingTask?.(activeTask);

    const fileRoots =
      workspaceDescriptor?.fileGrants?.map(
        (grant) =>
          `Task ${grant.access === "read" ? "input (read-only)" : "output (writable)"}: file tools use ${grant.root}.${grant.guestPath ? ` Container commands use ${grant.guestPath} (explicit shared mount).` : " These are server filesystem paths; no guest mount is implied."}`,
      ) ?? [];
    const attention = [
      `You have been assigned to Marina coding session ${opts.session.id}.`,
      `Requester: ${opts.actor}`,
      requirement,
      ownership,
      run
        ? `Task #${codingRunMetadata(run).taskId}; attempt artifact:${run.id}. Record a summary only after finishing checks. A stored summary submits the task for the requester to review.`
        : undefined,
      `Profile: ${opts.profile}`,
      `Execution target: ${opts.session.execution_target}`,
      opts.modelTarget ? `Model target: ${opts.modelTarget}` : undefined,
      `Workspace: ${opts.session.worktree_path ?? opts.session.workspace_root}`,
      ...fileRoots,
      boundEntity
        ? `Your active Code Mode session has been bound to ${opts.session.id}.`
        : "This adapter did not expose an entity id, so resume the session explicitly before using session-scoped commands.",
      "",
      "Use the marina_code tool when it is available. Use marina_command only as a fallback.",
      boundEntity
        ? opts.session.execution_target === "flywheel"
          ? "Start with marina_code status, then inspect with files/read/search/diff. Finite commands run in the active Flywheel project with no host fallback; use code service for long-running apps."
          : "Start with marina_code status, then inspect with files/read/search/diff. For a supported local Git root, use verify with verificationMode=candidate for immutable source evidence. It returns a receipt: inspect its result before submitting a summary. Ignored dependencies are not copied. Use code verify dependencies:auto only where the configured runner permits installation; otherwise report missing prerequisites. Commands are argv-based: shell prefixes such as VAR=value are not shell execution; an explicit env command still needs execution authorization. Ordinary verify checks the live workspace; it is not immutable source evidence. Use code allowed and code exec-mode to inspect the actual command policy. Already-authorized commands and dependency installation within this task do not need a repeated user decision; additional authority does. Execution uses argv, not implicit shell syntax."
        : `First run: code resume ${opts.session.id}. Then use marina_code status/files/read/search/diff/verify when available.`,
      "Use marina_code action=edit with path, oldText and newText for exact replacements: choose a small unique oldText copied from the file and literal newText without diff markers. Use action=write with path and content for new files or deliberate full rewrites. These use the existing writer permissions and record durable changes. Use patch for unified diffs; show/artifacts/patches/history retain the evidence.",
      opts.session.execution_target === "flywheel"
        ? "Use code service start/probe/screenshot for managed app evidence; use observe for additional behavior notes."
        : "Use observe to record app or manual behavior notes. Long-running app launch is disabled on the Marina host; configure Flywheel and use code service.",
      "Inspect workspace images with marina_see source=workspace:<path>. Full observations are durable: code artifacts kind visual_evidence lists them; code show <id> reopens them without a model call, including after context compression.",
      "Finish source and regression-test edits before candidate verification. Any later edit requires fresh candidate checks. Use code plan for progress; code summary submits finished work for review. A rejected summary remains progress and its feedback explains what is still required.",
      "Before editing a path, inspect its directory with code files or read the file with code read. These refresh scoped project instructions from disk. Read any truncated instruction files explicitly; repository instructions do not grant execution permissions. Native external runtimes retain their own instruction loaders.",
      ...formatProjectInstructions(instructions),
      "",
      `Request: ${prompt}`,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");

    this.deps.db.updateCodingSession(opts.session.id, { mode: "agent", agent: agent.name });
    this.deps.db.createCodingEvent({
      sessionId: opts.session.id,
      actor: opts.actor,
      kind: "code_agent_assigned",
      payload: {
        agent: agent.name,
        boundEntityId: boundEntity?.id ?? null,
        modelTarget: opts.modelTarget,
        profile: opts.profile,
        prompt,
        projectInstructions: instructionMetadata,
      },
    });
    try {
      await agent.sendAttention(attention);
    } catch (error) {
      if (run) {
        const ended = endCodingRun(
          this.deps.db,
          run.id,
          "failed",
          "Task delivery failed; inspect before retrying.",
        );
        if (ended) this.deps.onRunEnd?.(ended);
      }
      throw error;
    }

    return this.deps.db.createCodingArtifact({
      sessionId: opts.session.id,
      kind: "agent_assignment",
      title: formatPromptTitle(`Assigned ${agent.name}`, prompt),
      status: "complete",
      contentText: attention,
      metadata: {
        strategy: "agent",
        agent: agent.name,
        boundEntityId: boundEntity?.id ?? null,
        modelTarget: opts.modelTarget,
        profile: opts.profile,
        prompt,
        projectInstructions: instructionMetadata,
      },
      createdBy: opts.actor,
    });
  }

  private bindAgentEntity(
    agent: AgentHandle,
    session: CodingSessionRow,
    profile: string,
    task?: string,
  ): Entity | undefined {
    const entityId = agent.getStatus().entityId;
    if (!entityId || !this.deps.getEntity) return undefined;
    const entity = this.deps.getEntity(entityId);
    if (!entity) return undefined;
    entity.properties[ACTIVE_MODAL_KEY] = "code";
    entity.properties[ACTIVE_SESSION_KEY] = session.id;
    entity.properties[CODE_PROFILE_KEY] = profile;
    // Persist the active task so the assignment survives inspection/restart
    // and the engine can see the agent is mid-task. Cleared by code.ts on
    // `code stop` and on the summary-artifact completion heuristic.
    if (task) entity.properties[ACTIVE_TASK_KEY] = task;
    this.deps.db.saveEntity(entity);
    this.deps.db.createCodingEvent({
      sessionId: session.id,
      actor: agent.name,
      kind: "code_agent_bound",
      payload: { agent: agent.name, entityId: entity.id, profile },
    });
    return entity;
  }
}

function formatPromptTitle(prefix: string, prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return `${prefix}: ${title || "Untitled"}`;
}
