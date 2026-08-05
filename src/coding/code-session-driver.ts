import type { AgentHandle } from "../agent/agent-types";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../persistence/database";
import type { Entity } from "../types";

const ACTIVE_SESSION_KEY = "coding_session_id";
const ACTIVE_MODAL_KEY = "active_modal";
const CODE_PROFILE_KEY = "code_profile";

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
    modelTarget?: string;
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
    const boundEntity = this.bindAgentEntity(agent, opts.session, opts.profile);

    const attention = [
      `You have been assigned to Marina coding session ${opts.session.id}.`,
      `Requester: ${opts.actor}`,
      `Profile: ${opts.profile}`,
      `Execution target: ${opts.session.execution_target}`,
      opts.modelTarget ? `Model target: ${opts.modelTarget}` : undefined,
      `Workspace: ${opts.session.workspace_root}`,
      boundEntity
        ? `Your active Code Mode session has been bound to ${opts.session.id}.`
        : "This adapter did not expose an entity id, so resume the session explicitly before using session-scoped commands.",
      "",
      "Use the marina_code tool when it is available. Use marina_command only as a fallback.",
      boundEntity
        ? opts.session.execution_target === "flywheel"
          ? "Start with marina_code status, then inspect with files/read/search/diff. Finite commands run in the active Flywheel project with no host fallback; use code service for long-running apps."
          : "Start with marina_code status, then inspect with files/read/search/diff. Use verify for the local check chain and run only host-allowlisted checks."
        : `First run: code resume ${opts.session.id}. Then use marina_code status/files/read/search/diff/verify when available.`,
      "Use patch to propose a unified diff, apply/reject for patch decisions, show/artifacts/patches/history for durable context.",
      opts.session.execution_target === "flywheel"
        ? "Use code service start/probe/screenshot for managed app evidence; use observe for additional behavior notes."
        : "Use observe to record app or manual behavior notes. Long-running app launch is disabled on the Marina host; configure Flywheel and use code service.",
      "Record durable progress with code plan, code summary, code handoff, and code decision.",
      "",
      `Request: ${prompt}`,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");

    this.deps.db.updateCodingSession(opts.session.id, { mode: "agent" });
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
      },
    });
    await agent.sendAttention(attention);

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
      },
      createdBy: opts.actor,
    });
  }

  private bindAgentEntity(
    agent: AgentHandle,
    session: CodingSessionRow,
    profile: string,
  ): Entity | undefined {
    const entityId = agent.getStatus().entityId;
    if (!entityId || !this.deps.getEntity) return undefined;
    const entity = this.deps.getEntity(entityId);
    if (!entity) return undefined;
    entity.properties[ACTIVE_MODAL_KEY] = "code";
    entity.properties[ACTIVE_SESSION_KEY] = session.id;
    entity.properties[CODE_PROFILE_KEY] = profile;
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
