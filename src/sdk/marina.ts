// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── The front door ────────────────────────────────────────────────────────
//
//   const marina = await Marina.local("./my-project");      // a server for this folder
//   const marina = await Marina.connect("ws://host:3300", { name: "builder" });
//
//   const run = await marina.code.run("Fix the failing test");
//   for await (const step of run.steps()) console.log(step.label);
//   console.log(await run.result);
//   await marina.close();
//
// One connection, every surface: commands, coding, and the HTTP clients signed
// in with this session. Python, Java and Rust SDKs have the same shape.

import type { CapabilityManifest } from "./capabilities";
import {
  type ClientOptions,
  type CommandOptions,
  type CommandResult,
  MarinaAgent,
  type SessionInfo,
} from "./client";
import { MarinaCoding } from "./coding";
import { MarinaInvestigationClient } from "./investigation-client";
import { MarinaMemoryClient } from "./memory-client";
import { MarinaPanelClient } from "./panel-client";
import type { Perception } from "./protocol";
import { MarinaRoutingClient } from "./routing-client";

export interface ConnectOptions
  extends Pick<ClientOptions, "principal" | "model" | "commandTimeout" | "internalToken"> {
  /** Log in under this name (2-20 letters or digits). */
  name?: string;
  /**
   * Or resume a session: the token from an earlier session, within 60 s of
   * its disconnect. Each token works once; `marina.token` is the newest.
   */
  token?: string;
}

export interface LocalOptions {
  /** A throwaway database instead of the folder's saved one (deleted on close). */
  fresh?: boolean;
  /**
   * How to run the Marina CLI (default `["marina"]`, found on PATH). From a
   * checkout: `["bun", "run", "/path/to/marina/scripts/marina.ts"]`.
   */
  command?: string[];
  /** Extra environment for the server (a provider key, `MARINA_DEFAULT_MODEL`, …). */
  env?: Record<string, string>;
  /** Give up if the server is not ready within this long (default 90 s). */
  startTimeoutMs?: number;
}

/** What `marina serve <folder> --json` prints once its server is ready: one JSON line. */
export interface LocalServerAnnouncement {
  protocol: "marina.local.v1";
  /** WebSocket URL. */
  url: string;
  /** HTTP base URL of the same server. */
  http: string;
  /** The name to log in as: the folder's owner, an operator of this server. */
  name: string;
  pid: number;
  folder: string;
}

const LOCAL_PROTOCOL = "marina.local.v1";

/** ws(s):// and http(s):// forms of one server URL. */
export function serverUrls(url: string): { ws: string; http: string } {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("A server URL carries no credentials, query or fragment.");
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol))
    throw new Error(`Not a Marina server URL: ${url}`);
  const path = parsed.pathname.replace(/\/$/, "");
  return {
    ws: `${secure ? "wss" : "ws"}://${parsed.host}${path}`,
    // The WebSocket listens at the root or at `/ws`; HTTP is at the root.
    http: `${secure ? "https" : "http"}://${parsed.host}${path.replace(/\/ws$/, "")}`,
  };
}

export class Marina {
  /** Code Mode: run coding tasks, follow them, review their changes. */
  readonly code: MarinaCoding;
  private routingClient?: MarinaRoutingClient;
  private investigationClient?: MarinaInvestigationClient;
  private panelClient?: MarinaPanelClient;
  private closing?: Promise<void>;

  private constructor(
    /** The WebSocket client underneath, for anything the front door does not wrap. */
    readonly client: MarinaAgent,
    /** WebSocket URL. */
    readonly url: string,
    /** HTTP base URL of the same server. */
    readonly httpUrl: string,
    private stopServer?: () => Promise<void>,
  ) {
    this.code = new MarinaCoding(client);
  }

  /** Connect to a running Marina. */
  static async connect(url: string, options: ConnectOptions): Promise<Marina> {
    if (!options.name === !options.token)
      throw new Error("Pass a name to log in, or a token to resume a session (one of them).");
    const urls = serverUrls(url);
    const client = new MarinaAgent(urls.ws, {
      principal: options.principal ?? "agent",
      // A program's commands mean what they say: Code Mode never turns a
      // command into a coding task (tasks go through `code.run`).
      commandGrammar: "world",
      ...(options.model ? { model: options.model } : {}),
      ...(options.commandTimeout ? { commandTimeout: options.commandTimeout } : {}),
      ...(options.internalToken ? { internalToken: options.internalToken } : {}),
    });
    try {
      if (options.token) await client.reconnect(options.token);
      else await client.connect(options.name!);
    } catch (error) {
      client.disconnect();
      throw error;
    }
    return new Marina(client, urls.ws, urls.http);
  }

  /**
   * Start a Marina for a folder and connect to it as its owner. It codes in
   * that folder and keeps its sessions and memory in `~/.marina/projects/`
   * (the same home `marina <folder>` uses). `close()` stops it.
   *
   * Needs Node or Bun, and the `marina` CLI (`options.command` to point at it).
   */
  static async local(folder: string, options: LocalOptions = {}): Promise<Marina> {
    const server = await startLocalServer(folder, options);
    try {
      const marina = await Marina.connect(server.announcement.url, {
        name: server.announcement.name,
      });
      marina.stopServer = server.stop;
      return marina;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  /** This session: entity id, name, and the newest token. */
  get session(): SessionInfo {
    const session = this.client.getSession();
    if (!session) throw new Error("Not connected.");
    return session;
  }

  /** The newest session token: it signs the HTTP clients and resumes a dropped session. */
  get token(): string {
    return this.session.token;
  }

  /**
   * Run one world command (`look`, `task list`, `memory recall …`). Rejects
   * when the server refuses it. Coding tasks go through `code.run`.
   */
  command(text: string, options?: CommandOptions): Promise<CommandResult> {
    return this.client.command(text, options);
  }

  /** Every command this session may run, with its forms and effects. */
  capabilities(): Promise<CapabilityManifest> {
    return this.client.capabilities();
  }

  /** Everything the server sends this session. Returns a function that stops listening. */
  onEvent(handler: (frame: Perception) => void): () => void {
    this.client.onPerception(handler);
    return () => this.client.offPerception(handler);
  }

  /** Participant routing (`/api/routing`), signed in as this session. */
  get routing(): MarinaRoutingClient {
    this.routingClient ??= new MarinaRoutingClient({ url: this.httpUrl, token: () => this.token });
    return this.routingClient;
  }

  /** Investigations (`/api/investigations`), signed in as this session. */
  get investigations(): MarinaInvestigationClient {
    this.investigationClient ??= new MarinaInvestigationClient({
      url: this.httpUrl,
      token: () => this.token,
    });
    return this.investigationClient;
  }

  /** Published panels (`/api/canvases`), signed in as this session. */
  get panels(): MarinaPanelClient {
    this.panelClient ??= new MarinaPanelClient({ url: this.httpUrl, token: () => this.token });
    return this.panelClient;
  }

  /**
   * Memory (`/v1/memory`). It takes a memory credential of its own (audience
   * `marina:memory`), never this session's token.
   */
  memory(credential: string): MarinaMemoryClient {
    return new MarinaMemoryClient(this.httpUrl, credential);
  }

  /** Disconnect, and stop the server if `Marina.local` started it. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.code.closed();
      this.client.disconnect();
      await this.stopServer?.();
    })();
    return this.closing;
  }
}

// ─── Marina.local: the `marina serve` child ────────────────────────────────

interface ChildLike {
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  stdin: { end(): void } | null;
  exitCode: number | null;
  kill(signal?: string): boolean;
  once(event: "exit", listener: (code: number | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}
type Spawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; stdio: string[] },
) => ChildLike;

/** Start `marina serve <folder> --json` and wait for its announcement. */
export async function startLocalServer(
  folder: string,
  options: LocalOptions = {},
): Promise<{ announcement: LocalServerAnnouncement; stop: () => Promise<void> }> {
  const host = globalThis as { process?: { env: Record<string, string | undefined> } };
  if (!host.process) throw new Error("Marina.local needs Node or Bun; use Marina.connect here.");
  // Not resolved by bundlers: browsers get the error above, never a broken bundle.
  const childProcess = "node:child_process";
  const { spawn } = (await import(childProcess)) as { spawn: Spawn };
  const [command = "marina", ...args] = options.command ?? ["marina"];
  const child = spawn(
    command,
    [...args, "serve", folder, "--json", ...(options.fresh ? ["--fresh"] : [])],
    {
      env: { ...host.process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    // The server drains before it exits; a stuck one is killed.
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    await exited;
    clearTimeout(timer);
  };
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 40) stderr.shift();
  });
  const why = () => {
    const tail = stderr.join("").trim().split("\n").slice(-8).join("\n");
    return tail ? `\n${tail}` : "";
  };
  const announcement = await new Promise<LocalServerAnnouncement>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`The Marina server for ${folder} was not ready in time.${why()}`));
    }, options.startTimeoutMs ?? 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not run ${command}: ${error.message}. Install Marina, or pass { command: [...] }.`,
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`The Marina server for ${folder} exited (${code}) before it was ready.${why()}`),
      );
    });
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line || !out.includes("\n")) return;
      try {
        const parsed = JSON.parse(line) as LocalServerAnnouncement;
        if (parsed.protocol !== LOCAL_PROTOCOL) throw new Error(`unexpected ${parsed.protocol}`);
        clearTimeout(timer);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timer);
        void stop();
        reject(new Error(`marina serve said something unexpected: ${String(error)}`));
      }
    });
  });
  return { announcement, stop };
}
