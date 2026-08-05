import type { FlywheelBindingRow, FlywheelBindingState, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import { FlywheelClient, type FlywheelEvent, type FlywheelFetch } from "./flywheel";

const AGENT_SCOPES = [
  "sandbox:create",
  "sandbox:exec",
  "sandbox:read",
  "sandbox:stop",
  "sandbox:hibernate",
  "publish",
];

export interface FlywheelWorkspace {
  sessionId: string;
  sandboxId: string;
  image: string;
  keepAlive: boolean;
  state: FlywheelBindingState;
  publishedUrl?: string;
  lastError?: string;
}

export interface FlywheelExecutionResult {
  output: string;
  events: FlywheelEvent[];
}

export class FlywheelExecutionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Flywheel command exceeded ${timeoutMs}ms; remote cancellation was requested.`);
    this.name = "FlywheelExecutionTimeoutError";
  }
}

export interface FlywheelToolBackend {
  create(entityId: EntityId, image?: string, keepAlive?: boolean): Promise<FlywheelWorkspace>;
  exec(entityId: EntityId, command: string, args?: string[], cwd?: string): Promise<string>;
  execDetailed?(
    entityId: EntityId,
    command: string,
    args?: string[],
    cwd?: string,
    options?: { timeoutMs?: number },
  ): Promise<FlywheelExecutionResult>;
  publish(entityId: EntityId, port: number): Promise<string>;
  hibernate(entityId: EntityId): Promise<void>;
  resume(entityId: EntityId): Promise<void>;
  stop(entityId: EntityId): Promise<void>;
  status(entityId: EntityId): FlywheelWorkspace | undefined;
  reconcile?(): Promise<void>;
}

interface EntityWorkspace extends FlywheelWorkspace {
  client: FlywheelClient;
  capabilityExpiresAt: number;
}

export class FlywheelManager implements FlywheelToolBackend {
  private readonly operator: FlywheelClient;
  private readonly workspaces = new Map<EntityId, EntityWorkspace>();
  private readonly creating = new Set<EntityId>();

  constructor(
    private readonly baseUrl: string,
    operatorToken: string,
    private readonly defaultImage: string,
    private readonly fetch?: FlywheelFetch,
    private readonly db?: MarinaDB,
  ) {
    this.operator = new FlywheelClient({ baseUrl, token: operatorToken, fetch });
    for (const binding of db?.listFlywheelBindings() ?? []) {
      this.workspaces.set(
        binding.entity_id as EntityId,
        workspaceFromBinding(binding, this.operator),
      );
    }
  }

  static fromEnv(db?: MarinaDB): FlywheelManager | undefined {
    const token = process.env.FLYWHEEL_TOKEN;
    if (!token) return undefined;
    return new FlywheelManager(
      process.env.FLYWHEEL_RPC_URL ?? "http://localhost:8088/rpc",
      token,
      process.env.FLYWHEEL_IMAGE ?? "localhost/h2oai/flywheel-agentd:latest",
      undefined,
      db,
    );
  }

  async create(entityId: EntityId, image = this.defaultImage, keepAlive = true) {
    if (this.workspaces.has(entityId) || this.creating.has(entityId)) {
      throw new Error(
        "This entity already has a Flywheel sandbox; stop it before creating another.",
      );
    }
    this.creating.add(entityId);
    try {
      const { sessionId } = await this.operator.createSession();
      const { client, expiresAt } = await this.mintAgentClient(sessionId);
      const sandbox = await client.createSandbox({ sessionId, image, keepAlive });
      const workspace: EntityWorkspace = {
        client,
        capabilityExpiresAt: expiresAt,
        sessionId,
        sandboxId: sandbox.sandboxId,
        image,
        keepAlive: sandbox.keepAlive,
        state: "running",
      };
      this.workspaces.set(entityId, workspace);
      this.db?.saveFlywheelBinding({
        entityId,
        sessionId,
        sandboxId: sandbox.sandboxId,
        image,
        keepAlive: sandbox.keepAlive,
        state: "running",
      });
      return publicWorkspace(workspace);
    } finally {
      this.creating.delete(entityId);
    }
  }

  async exec(entityId: EntityId, command: string, args: string[] = [], cwd?: string) {
    return (await this.execDetailed(entityId, command, args, cwd)).output;
  }

  async execDetailed(
    entityId: EntityId,
    command: string,
    args: string[] = [],
    cwd?: string,
    options?: { timeoutMs?: number },
  ) {
    const workspace = this.requireRunning(entityId);
    const output: string[] = [];
    const events: FlywheelEvent[] = [];
    const client = await this.clientFor(workspace);
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      for await (const event of client.exec(
        {
          sessionId: workspace.sessionId,
          sandboxId: workspace.sandboxId,
          command,
          args,
          cwd,
        },
        { signal: controller.signal },
      )) {
        events.push(event);
        const data = processData(event);
        if (data) output.push(data);
      }
    } catch (error) {
      if (timedOut) throw new FlywheelExecutionTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      output: output.join("") || "Command completed without output.",
      events,
    };
  }

  async publish(entityId: EntityId, port: number) {
    const workspace = this.requireRunning(entityId);
    const client = await this.clientFor(workspace);
    const result = await client.publish({
      sessionId: workspace.sessionId,
      sandboxId: workspace.sandboxId,
      port,
    });
    workspace.publishedUrl = result.url;
    this.db?.updateFlywheelBinding(entityId, { publishedUrl: result.url, lastError: null });
    return result.url;
  }

  async hibernate(entityId: EntityId) {
    const workspace = this.requireRunning(entityId);
    const client = await this.clientFor(workspace);
    await client.hibernate(workspace);
    workspace.state = "hibernated";
    this.db?.updateFlywheelBinding(entityId, { state: "hibernated", lastError: null });
  }

  async resume(entityId: EntityId) {
    const workspace = this.require(entityId);
    if (workspace.state !== "hibernated") throw new Error("Flywheel sandbox is not hibernated.");
    const client = await this.clientFor(workspace);
    await client.resume(workspace);
    workspace.state = "running";
    workspace.lastError = undefined;
    this.db?.updateFlywheelBinding(entityId, { state: "running", lastError: null });
  }

  async stop(entityId: EntityId) {
    const workspace = this.require(entityId);
    workspace.state = "stopping";
    this.db?.updateFlywheelBinding(entityId, { state: "stopping" });
    const client = await this.clientFor(workspace);
    try {
      await client.stopSandbox(workspace);
      this.workspaces.delete(entityId);
      this.db?.deleteFlywheelBinding(entityId);
    } catch (error) {
      workspace.state = "unavailable";
      workspace.lastError = sanitizedError(error);
      this.db?.updateFlywheelBinding(entityId, {
        state: "unavailable",
        lastError: workspace.lastError,
      });
      throw error;
    }
  }

  status(entityId: EntityId): FlywheelWorkspace | undefined {
    const workspace = this.workspaces.get(entityId);
    return workspace ? publicWorkspace(workspace) : undefined;
  }

  async reconcile(): Promise<void> {
    const reconciledAt = Date.now();
    await Promise.all(
      [...this.workspaces.entries()].map(async ([entityId, workspace]) => {
        try {
          const result = await this.operator.listSandboxes(workspace.sessionId);
          const remote = result.sandboxes.find((sandbox) => sandbox.id === workspace.sandboxId);
          if (!remote || remote.status === "stopped") {
            workspace.state = "unavailable";
            workspace.lastError = "Flywheel sandbox is missing or stopped.";
          } else {
            workspace.state = remote.status === "hibernated" ? "hibernated" : "running";
            workspace.lastError = undefined;
          }
          this.db?.updateFlywheelBinding(entityId, {
            state: workspace.state,
            lastError: workspace.lastError ?? null,
            reconciledAt,
          });
        } catch (error) {
          workspace.state = "unavailable";
          workspace.lastError = sanitizedError(error);
          this.db?.updateFlywheelBinding(entityId, {
            state: "unavailable",
            lastError: workspace.lastError,
            reconciledAt,
          });
        }
      }),
    );
  }

  private require(entityId: EntityId): EntityWorkspace {
    const workspace = this.workspaces.get(entityId);
    if (!workspace)
      throw new Error("No Flywheel sandbox for this entity. Use action=create first.");
    return workspace;
  }

  private requireRunning(entityId: EntityId): EntityWorkspace {
    const workspace = this.require(entityId);
    if (workspace.state !== "running") {
      throw new Error(
        workspace.state === "hibernated"
          ? "Flywheel sandbox is hibernated; resume it first."
          : `Flywheel sandbox is ${workspace.state}; host execution was not attempted.`,
      );
    }
    return workspace;
  }

  private async clientFor(workspace: EntityWorkspace): Promise<FlywheelClient> {
    if (Date.now() < workspace.capabilityExpiresAt - 30_000) return workspace.client;
    const refreshed = await this.mintAgentClient(workspace.sessionId);
    workspace.client = refreshed.client;
    workspace.capabilityExpiresAt = refreshed.expiresAt;
    return workspace.client;
  }

  private async mintAgentClient(sessionId: string) {
    const capability = await this.operator.mintCapability({
      sessionId,
      scopes: AGENT_SCOPES,
      ttlSeconds: 600,
    });
    const parsedExpiry = Date.parse(capability.expiresAt);
    return {
      client: new FlywheelClient({
        baseUrl: this.baseUrl,
        token: capability.token,
        fetch: this.fetch,
      }),
      // A malformed/missing timestamp must not produce a permanently trusted
      // client. Fall back just inside the requested ten-minute TTL.
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 570_000,
    };
  }
}

function publicWorkspace(workspace: EntityWorkspace): FlywheelWorkspace {
  return {
    sessionId: workspace.sessionId,
    sandboxId: workspace.sandboxId,
    image: workspace.image,
    keepAlive: workspace.keepAlive,
    state: workspace.state,
    publishedUrl: workspace.publishedUrl,
    lastError: workspace.lastError,
  };
}

function workspaceFromBinding(
  binding: FlywheelBindingRow,
  operator: FlywheelClient,
): EntityWorkspace {
  return {
    client: operator,
    capabilityExpiresAt: 0,
    sessionId: binding.session_id,
    sandboxId: binding.sandbox_id,
    image: binding.image,
    keepAlive: binding.keep_alive === 1,
    state: binding.state,
    publishedUrl: binding.published_url ?? undefined,
    lastError: binding.last_error ?? undefined,
  };
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function processData(event: FlywheelEvent): string {
  const body = event.body as { case?: unknown; value?: unknown } | undefined;
  const processEvent =
    (event.process as { data?: unknown } | undefined) ??
    (body?.case === "process" ? (body.value as { data?: unknown } | undefined) : undefined);
  const data = processEvent?.data;
  if (typeof data !== "string" || data.length === 0) return "";
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return data;
  }
}
