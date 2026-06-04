import { validateFetchUrl } from "../net/url-guard";
import type { MarinaDB } from "../persistence/database";
import {
  CONNECTOR_HTTP_RATE_MS,
  CONNECTOR_HTTP_TIMEOUT_MS,
  CONNECTOR_MAX_BODY_BYTES,
  CONNECTOR_TOOL_RATE_MS,
} from "./constants";
import { getErrorMessage } from "./errors";

/**
 * MCPorter-backed connector runtime.
 * Manages outbound MCP connections to external servers.
 * Uses dynamic import so the system degrades gracefully if mcporter is not installed.
 */

export interface ConnectorInfo {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  status: "active" | "disabled" | "error";
}

export interface ToolInfo {
  name: string;
  description?: string;
}

export class ConnectorRuntime {
  // biome-ignore lint/suspicious/noExplicitAny: mcporter types are external
  private runtime: any = null;
  private available = false;
  private fetchLastCall = new Map<string, number>();
  private db?: MarinaDB;

  constructor(db?: MarinaDB) {
    this.db = db;
  }

  /** Initialize the MCPorter runtime. Returns false if mcporter is not installed. */
  async init(): Promise<boolean> {
    try {
      const mcporter = await import("mcporter");
      this.runtime = await mcporter.createRuntime();
      this.available = true;
      return true;
    } catch {
      console.warn("[connectors] mcporter not available. External connectors disabled.");
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Load connectors from database and register them with the runtime. */
  async loadFromDB(): Promise<number> {
    if (!this.db || !this.available) return 0;
    const connectors = this.db.listConnectors("active");
    let loaded = 0;
    for (const conn of connectors) {
      try {
        if (conn.transport === "http" && conn.url) {
          await this.runtime.registerDefinition({
            name: conn.name,
            command: {
              kind: "http",
              url: new URL(conn.url),
              headers: parseHeaders(conn.auth_data),
            },
          });
          loaded++;
        } else if (conn.transport === "stdio" && conn.command) {
          const args = conn.args ? (JSON.parse(conn.args) as string[]) : [];
          await this.runtime.registerDefinition({
            name: conn.name,
            command: { kind: "stdio", command: conn.command, args, cwd: "." },
          });
          loaded++;
        }
      } catch (err) {
        console.error(`[connectors] Failed to load connector "${conn.name}":`, err);
        if (this.db) {
          this.db.updateConnectorStatus(conn.id, "error");
        }
      }
    }
    if (loaded > 0) {
      console.log(`[connectors] Loaded ${loaded} connectors from database.`);
    }
    return loaded;
  }

  /** Register an HTTP MCP server. */
  async addHttpServer(name: string, url: string, headers?: Record<string, string>): Promise<void> {
    if (!this.available) throw new Error("Connector runtime not available.");
    await this.runtime.registerDefinition({
      name,
      command: { kind: "http", url: new URL(url), headers },
    });
  }

  /** Register a stdio MCP server (admin only — spawns a process). */
  async addStdioServer(name: string, command: string, args: string[]): Promise<void> {
    if (!this.available) throw new Error("Connector runtime not available.");
    await this.runtime.registerDefinition({
      name,
      command: { kind: "stdio", command, args, cwd: "." },
    });
  }

  /** Close and remove a server connection. */
  async removeServer(name: string): Promise<void> {
    if (!this.available) return;
    try {
      await this.runtime.close(name);
    } catch {
      // Expected: server may not be connected
    }
  }

  /** List all registered server names. */
  listServers(): string[] {
    if (!this.available) return [];
    try {
      return this.runtime.listServers?.() ?? [];
    } catch {
      // Expected: runtime may not support listServers
      return [];
    }
  }

  /** List tools available on a server. */
  async listTools(server: string): Promise<ToolInfo[]> {
    if (!this.available) return [];
    try {
      const tools = await this.runtime.listTools(server);
      if (Array.isArray(tools)) {
        return tools.map((t: { name: string; description?: string }) => ({
          name: t.name,
          description: t.description,
        }));
      }
      return [];
    } catch (err) {
      throw new Error(`Failed to list tools for "${server}": ${getErrorMessage(err)}`);
    }
  }

  /** Call a tool on a server. Rate-limited per entity. */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    entityId?: string,
  ): Promise<unknown> {
    if (!this.available) throw new Error("Connector runtime not available.");

    // Rate limit: 1 call per 2 seconds per entity
    if (entityId) {
      const key = `${entityId}:${server}`;
      const now = Date.now();
      const last = this.fetchLastCall.get(key) ?? 0;
      if (now - last < CONNECTOR_TOOL_RATE_MS) {
        throw new Error("Rate limited. Wait before calling again.");
      }
      this.fetchLastCall.set(key, now);
    }

    try {
      const result = await this.runtime.callTool(server, tool, args);
      return result;
    } catch (err) {
      throw new Error(`Tool call failed: ${getErrorMessage(err)}`);
    }
  }

  /** HTTP GET with rate limiting. */
  async httpGet(
    url: string,
    entityId?: string,
  ): Promise<{ status: number; body: string } | { error: string }> {
    // SSRF protection
    const urlError = validateFetchUrl(url);
    if (urlError) return { error: urlError };

    if (entityId) {
      const key = `http:${entityId}`;
      const now = Date.now();
      const last = this.fetchLastCall.get(key) ?? 0;
      if (now - last < CONNECTOR_HTTP_RATE_MS) {
        return { error: "Rate limited. Wait before fetching again." };
      }
      this.fetchLastCall.set(key, now);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECTOR_HTTP_TIMEOUT_MS);
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      clearTimeout(timeout);
      const body = await response.text();
      return {
        status: response.status,
        body:
          body.length > CONNECTOR_MAX_BODY_BYTES ? body.slice(0, CONNECTOR_MAX_BODY_BYTES) : body,
      };
    } catch (err) {
      return { error: `Fetch failed: ${getErrorMessage(err)}` };
    }
  }

  /** HTTP POST with rate limiting. */
  async httpPost(
    url: string,
    body: string,
    entityId?: string,
  ): Promise<{ status: number; body: string } | { error: string }> {
    // SSRF protection
    const urlError = validateFetchUrl(url);
    if (urlError) return { error: urlError };

    if (entityId) {
      const key = `http:${entityId}`;
      const now = Date.now();
      const last = this.fetchLastCall.get(key) ?? 0;
      if (now - last < CONNECTOR_HTTP_RATE_MS) {
        return { error: "Rate limited. Wait before fetching again." };
      }
      this.fetchLastCall.set(key, now);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECTOR_HTTP_TIMEOUT_MS);
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const respBody = await response.text();
      return {
        status: response.status,
        body:
          respBody.length > CONNECTOR_MAX_BODY_BYTES
            ? respBody.slice(0, CONNECTOR_MAX_BODY_BYTES)
            : respBody,
      };
    } catch (err) {
      return { error: `Fetch failed: ${getErrorMessage(err)}` };
    }
  }

  /** Shut down all connections. */
  async close(): Promise<void> {
    if (!this.available) return;
    try {
      await this.runtime.close();
    } catch {
      // Expected: runtime may already be closed
    }
  }
}

function parseHeaders(authData: string | null): Record<string, string> | undefined {
  if (!authData) return undefined;
  try {
    return JSON.parse(authData) as Record<string, string>;
  } catch {
    return undefined;
  }
}
