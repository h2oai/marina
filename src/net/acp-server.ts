/**
 * ACP (Agent Client Protocol) server — stdio ndjson JSON-RPC 2.0.
 *
 * Editor / agent-client integration: Zed, JetBrains, VS Code, Neovim, and any
 * compat profile that speaks ACP. Clients spawn `bun run scripts/acp.ts <name>`
 * and talk to it over the subprocess stdio. ACP is generic — Marina provides
 * one ACP surface that all of these clients share.
 *
 * Protocol spec: https://agentclientprotocol.com
 *
 * Minimum-viable contract implemented here:
 *   initialize       — capability handshake
 *   session/new      — mint a session id, store cwd
 *   session/prompt   — run through Marina's command engine, stream updates,
 *                      resolve with {stopReason}
 *   session/cancel   — notification, aborts in-flight turn (best effort)
 *
 * Everything else returns JSON-RPC -32601 "Method not found".
 *
 * Wire rules:
 *   - ndjson: one JSON object per line, no embedded newlines
 *   - stdout is SACRED — only ACP messages. All logging goes to stderr.
 *   - capability checks first; never call fs/* or terminal/* without advertisement.
 *
 * Proxy model: this server uses an MarinaAgent SDK client (WebSocket) so each
 * ACP session maps to one Marina entity in a running world. No new commands.
 */

import type { MarinaAgent } from "../sdk/client";
import type { Perception } from "../types";
import { formatPerception } from "./formatter";

const PROTOCOL_VERSION = 1;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpSession {
  id: string;
  cwd: string;
  inFlight: boolean;
  cancelled: boolean;
}

export interface AcpServerOptions {
  /** Connected agent — must already be logged in. */
  agent: MarinaAgent;
  /** Agent name advertised in initialize. Default "marina". */
  agentName?: string;
  /** Agent version advertised in initialize. Default "0.1.0". */
  agentVersion?: string;
  /** Readable byte stream carrying the client's ndjson stdout. */
  input?: NodeJS.ReadableStream;
  /** Writable byte stream — the agent's ndjson output. */
  output?: NodeJS.WritableStream;
}

export class AcpServer {
  private agent: MarinaAgent;
  private agentName: string;
  private agentVersion: string;
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  private sessions = new Map<string, AcpSession>();
  private buffer = "";

  constructor(opts: AcpServerOptions) {
    this.agent = opts.agent;
    this.agentName = opts.agentName ?? "marina";
    this.agentVersion = opts.agentVersion ?? "0.1.0";
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
  }

  start(): void {
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drain();
    });
  }

  stop(): void {}

  private drain(): void {
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) void this.handleLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private send(msg: unknown): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private respond(id: number | string | null, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.send(msg);
  }

  private respondError(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const msg: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.send(msg);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      // Parse error — we cannot recover an id, null is correct per spec.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[acp] parse error: ${message}\n`);
      this.respondError(null, -32700, "Parse error");
      return;
    }

    const { id, method, params } = req;

    try {
      if (method === "initialize") {
        this.handleInitialize(id ?? null);
        return;
      }
      if (method === "session/new") {
        this.handleSessionNew(id ?? null, params);
        return;
      }
      if (method === "session/prompt") {
        await this.handleSessionPrompt(id ?? null, params);
        return;
      }
      if (method === "session/cancel") {
        this.handleSessionCancel(params);
        return; // notification — no response
      }
      if (method === "authenticate") {
        // We advertise no authMethods, but answer politely.
        this.respond(id ?? null, null);
        return;
      }

      // Everything else — not supported.
      if (id !== undefined) {
        this.respondError(id ?? null, -32601, `Method not found: ${method}`);
      }
      // Notifications for unknown methods are silently ignored per JSON-RPC.
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      process.stderr.write(`[acp] handler error for ${method}: ${message}\n`);
      if (id !== undefined) {
        this.respondError(id ?? null, -32603, "Internal error");
      }
    }
  }

  private handleInitialize(id: number | string | null): void {
    this.respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: {
        name: this.agentName,
        title: "Marina",
        version: this.agentVersion,
      },
    });
  }

  private handleSessionNew(id: number | string | null, params: unknown): void {
    const p = (params ?? {}) as { cwd?: string };
    const sessionId = `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: p.cwd ?? process.cwd(),
      inFlight: false,
      cancelled: false,
    });
    this.respond(id, { sessionId });
  }

  private handleSessionCancel(params: unknown): void {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) return;
    const sess = this.sessions.get(p.sessionId);
    if (sess) sess.cancelled = true;
  }

  private async handleSessionPrompt(id: number | string | null, params: unknown): Promise<void> {
    const p = (params ?? {}) as {
      sessionId?: string;
      prompt?: Array<{ type?: string; text?: string }>;
    };
    if (!p.sessionId) {
      this.respondError(id, -32602, "sessionId is required");
      return;
    }
    const sess = this.sessions.get(p.sessionId);
    if (!sess) {
      this.respondError(id, -32602, `Unknown sessionId: ${p.sessionId}`);
      return;
    }
    if (sess.inFlight) {
      this.respondError(id, -32603, "Session already has an in-flight prompt");
      return;
    }

    sess.inFlight = true;
    sess.cancelled = false;

    try {
      const promptText = (p.prompt ?? [])
        .filter(
          (b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
        )
        .map((b) => b.text as string)
        .join("\n")
        .trim();

      if (!promptText) {
        this.respond(id, { stopReason: "end_turn" });
        return;
      }

      // Run through Marina's command engine via the SDK.
      const perceptions: Perception[] = await this.agent.command(promptText);

      if (sess.cancelled) {
        this.respond(id, { stopReason: "cancelled" });
        return;
      }

      // Stream each perception as an agent_message_chunk.
      for (const perception of perceptions) {
        const text = formatPerception(perception, "markdown");
        if (!text) continue;
        this.notify("session/update", {
          sessionId: sess.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }

      this.respond(id, { stopReason: sess.cancelled ? "cancelled" : "end_turn" });
    } catch (err) {
      // Spec: cancellation must not surface as an error. Any abort gets swallowed.
      if (sess.cancelled) {
        this.respond(id, { stopReason: "cancelled" });
        return;
      }
      const message = (err as Error).message ?? String(err);
      process.stderr.write(`[acp] prompt error: ${message}\n`);
      this.respondError(id, -32603, "Prompt failed");
    } finally {
      sess.inFlight = false;
    }
  }
}
