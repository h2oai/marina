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
  state: "running" | "hibernated";
  publishedUrl?: string;
}

export interface FlywheelToolBackend {
  create(entityId: EntityId, image?: string, keepAlive?: boolean): Promise<FlywheelWorkspace>;
  exec(entityId: EntityId, command: string, args?: string[], cwd?: string): Promise<string>;
  publish(entityId: EntityId, port: number): Promise<string>;
  hibernate(entityId: EntityId): Promise<void>;
  resume(entityId: EntityId): Promise<void>;
  stop(entityId: EntityId): Promise<void>;
  status(entityId: EntityId): FlywheelWorkspace | undefined;
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
  ) {
    this.operator = new FlywheelClient({ baseUrl, token: operatorToken, fetch });
  }

  static fromEnv(): FlywheelManager | undefined {
    const token = process.env.FLYWHEEL_TOKEN;
    if (!token) return undefined;
    return new FlywheelManager(
      process.env.FLYWHEEL_RPC_URL ?? "http://localhost:8088/rpc",
      token,
      process.env.FLYWHEEL_IMAGE ?? "localhost/h2oai/flywheel-agentd:latest",
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
      return publicWorkspace(workspace);
    } finally {
      this.creating.delete(entityId);
    }
  }

  async exec(entityId: EntityId, command: string, args: string[] = [], cwd?: string) {
    const workspace = this.requireRunning(entityId);
    const output: string[] = [];
    const client = await this.clientFor(workspace);
    for await (const event of client.exec({
      sessionId: workspace.sessionId,
      sandboxId: workspace.sandboxId,
      command,
      args,
      cwd,
    })) {
      const data = processData(event);
      if (data) output.push(data);
    }
    return output.join("") || "Command completed without output.";
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
    return result.url;
  }

  async hibernate(entityId: EntityId) {
    const workspace = this.requireRunning(entityId);
    const client = await this.clientFor(workspace);
    await client.hibernate(workspace);
    workspace.state = "hibernated";
  }

  async resume(entityId: EntityId) {
    const workspace = this.require(entityId);
    if (workspace.state !== "hibernated") throw new Error("Flywheel sandbox is not hibernated.");
    const client = await this.clientFor(workspace);
    await client.resume(workspace);
    workspace.state = "running";
  }

  async stop(entityId: EntityId) {
    const workspace = this.require(entityId);
    const client = await this.clientFor(workspace);
    await client.stopSandbox(workspace);
    this.workspaces.delete(entityId);
  }

  status(entityId: EntityId): FlywheelWorkspace | undefined {
    const workspace = this.workspaces.get(entityId);
    return workspace ? publicWorkspace(workspace) : undefined;
  }

  private require(entityId: EntityId): EntityWorkspace {
    const workspace = this.workspaces.get(entityId);
    if (!workspace)
      throw new Error("No Flywheel sandbox for this entity. Use action=create first.");
    return workspace;
  }

  private requireRunning(entityId: EntityId): EntityWorkspace {
    const workspace = this.require(entityId);
    if (workspace.state !== "running")
      throw new Error("Flywheel sandbox is hibernated; resume it first.");
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
  };
}

function processData(event: FlywheelEvent): string {
  const data = (event.process as { data?: unknown } | undefined)?.data;
  if (typeof data !== "string" || data.length === 0) return "";
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return data;
  }
}
