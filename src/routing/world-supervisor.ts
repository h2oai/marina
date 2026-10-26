// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-world supervisor: the native agent supervisor (`MarinaSupervisor`,
 * Claude Code / Codex / pi) run by the server itself, started by a person with
 * `supervisor start` and drained on shutdown. It is the same supervisor
 * `marina supervise` runs, holding the same thing: a routing-only supervision
 * credential issued to that person (`src/routing/supervision-credential.ts`:
 * renewed at 80 %, revoked on stop). Its routing traffic goes over the
 * server's own loopback HTTP API with that credential, so the routing API's
 * authentication, supervision scope and rate limits apply to it exactly as to
 * an external supervisor; every launch is still a Streams control the person
 * sends with their own session (`code.exec` + `agent.spawn` at the route).
 *
 * In-process rather than a child: the supervisor is async I/O (HTTP sync, a
 * local journal, native child processes), never blocks the event loop, and
 * holds nothing the server does not already hold. What it must NOT inherit is
 * the server's environment, which carries provider keys and server secrets:
 * native agents get `supervisorAgentEnvironment()` (an allowlist; they use
 * their own CLI logins) and reach the world through their resident relay.
 * It therefore needs supervised residents (`MARINA_SUPERVISED_RESIDENTS`, on
 * by default): without them a run would act through a session token the
 * server never holds.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WorkspaceRegistry } from "../coding/workspace-registry";
import { dataDir } from "../config/data-dir";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { localHttpBase } from "../net/listen-ports";
import type { MarinaDB } from "../persistence/database";
import { type AgentAdapter, BUILTIN_AGENT_ADAPTERS } from "./agent-adapters";
import {
  marinaResidentConnector,
  type ResidentConnector,
  residentWorldUrl,
} from "./resident-connection";
import { supervisedResidentsEnabled } from "./residents";
import { holdSupervision, type SupervisionHold } from "./supervision-credential";
import { MarinaSupervisor } from "./supervisor";
import { residentInstructions } from "./supervisor-instructions";

const log = new Logger();

/** Supervisor sync cadence (the CLI's 2 s). */
const TICK_MS = 2_000;
/** Longest a stop waits for the final sync before closing anyway. */
const FINAL_SYNC_MS = 10_000;
/** Durable record of a running in-world supervisor, resumed on boot. */
export const WORLD_SUPERVISOR_STATE_OWNER = "routing:supervisor";
const STATE_KEY = "in-world";

type Adapter = AgentAdapter & { executable: string };

/** The database surface the in-world supervisor reads and writes. */
export type WorldSupervisorDb = Pick<
  MarinaDB,
  | "getUserByName"
  | "isBanned"
  | "getAgentConfig"
  | "getPrincipal"
  | "issueSupervisionCredential"
  | "revokeSupervisionCredential"
  | "getCoreMemory"
  | "setCoreMemory"
  | "deleteCoreMemory"
>;

export interface WorldSupervisorStatus {
  running: boolean;
  owner?: string;
  root?: string;
  label?: string;
  sessionId?: string;
  adapters?: string[];
  startedAt?: number;
  /** Why the last supervisor stopped on its own (journal failure). */
  failure?: string;
  /** The last routing sync error while running (cleared by a good sync). */
  lastError?: string;
}

export interface WorldSupervisorStartOptions {
  db: WorldSupervisorDb;
  /** The person's account name. */
  owner: string;
  /** Canonical project root (inside the configured code roots). */
  root: string;
  label?: string;
  /** The server's own HTTP base (default: this process's bound port). */
  url?: string;
  /** Test seam: routing transport. */
  fetch?: typeof fetch;
  /** Default: the installed Claude Code / Codex / pi executables on PATH. */
  adapters?: Adapter[];
  /** Default: `<data dir or DB directory>/supervisor/<hash>`. */
  stateDirectory?: string;
  /** Test seam: how residents hold their world connection. */
  connect?: ResidentConnector;
  /** Keep the start for the next boot (default true). */
  persist?: boolean;
}

/** Installed native agents this server can supervise. */
export function installedAgentAdapters(): Adapter[] {
  return BUILTIN_AGENT_ADAPTERS.flatMap((adapter) => {
    const path = Bun.which(adapter.executable);
    return path ? [{ ...adapter, executable: path }] : [];
  });
}

/** Variables a native agent may inherit from the server's environment. */
const AGENT_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
]);

/**
 * The environment native agents start with: locale, paths and terminal only
 * (`LC_*` / `XDG_*` included). Provider keys, Marina settings and every other
 * server secret stay in the server; agents use their own CLI logins under
 * HOME and act in the world through their resident relay.
 */
export function supervisorAgentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (
      value !== undefined &&
      (AGENT_ENV_ALLOW.has(key) || key.startsWith("LC_") || key.startsWith("XDG_"))
    )
      out[key] = value;
  return out;
}

/**
 * Why `name` may not own a supervisor, or undefined: the same rule as the
 * routing API's supervision issue (people supervise; an agent account, by
 * config or principal, never does).
 */
export function supervisionOwnerRefusal(db: WorldSupervisorDb, name: string): string | undefined {
  const account = db.getUserByName(name);
  if (!account) return "Log in with a Marina account to supervise agents.";
  if (db.isBanned(name)) return "This account is not available.";
  if (db.getAgentConfig(name) || db.getPrincipal("agent", name))
    return "Only a person may supervise agents.";
  const principal = db.getPrincipal("human", name);
  if (!principal || principal.principal_id !== account.id)
    return "Only a person may supervise agents.";
  return undefined;
}

/** Where the supervisor journal lives: beside the world's other state. */
export function worldSupervisorStateDirectory(
  owner: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const db = env.DB_PATH?.trim() || "marina.db";
  const base =
    dataDir(env) ?? (db === ":memory:" ? join(tmpdir(), "marina") : dirname(resolve(db)));
  return join(base, "supervisor", Bun.hash(`${owner}:${root}`).toString(16));
}

interface Running {
  owner: string;
  root: string;
  label: string;
  supervisor: MarinaSupervisor;
  hold: SupervisionHold;
  sessionId: string;
  adapters: string[];
  startedAt: number;
  loop: Promise<void>;
  wake?: () => void;
  stopping: boolean;
}

/** At most one in-world supervisor per server, owned by the engine. */
export class WorldSupervisor {
  private current?: Running;
  private starting = false;
  private stopPromise?: Promise<void>;
  private lastFailure?: string;
  private lastError?: string;
  private db?: WorldSupervisorDb;
  /** Test seam: transport, adapters, state directory, connector for every start. */
  private testDefaults: Partial<WorldSupervisorStartOptions> = {};

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Test seam: options merged under every later `start` (the command's included). */
  setStartDefaultsForTests(defaults: Partial<WorldSupervisorStartOptions>): void {
    this.testDefaults = defaults;
  }

  status(): WorldSupervisorStatus {
    const run = this.current;
    if (!run) return { running: false, ...(this.lastFailure ? { failure: this.lastFailure } : {}) };
    return {
      running: true,
      owner: run.owner,
      root: run.root,
      label: run.label,
      sessionId: run.sessionId,
      adapters: run.adapters,
      startedAt: run.startedAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Start the supervisor for `owner` in `root`. Throws with a person-readable
   * reason when it cannot (already running, residents off, not a person, no
   * installed agent, the credential could not be issued).
   */
  async start(requested: WorldSupervisorStartOptions): Promise<WorldSupervisorStatus> {
    const options = { ...this.testDefaults, ...requested };
    if (this.current || this.starting || this.stopPromise)
      throw new Error(
        this.current
          ? `The in-world supervisor already runs for ${this.current.owner} in ${this.current.root}; \`supervisor stop\` first.`
          : "The in-world supervisor is starting or stopping; try again shortly.",
      );
    if (!supervisedResidentsEnabled())
      throw new Error(
        "The in-world supervisor needs supervised residents (MARINA_SUPERVISED_RESIDENTS is off): each launched agent must act as its own account.",
      );
    const refusal = supervisionOwnerRefusal(options.db, options.owner);
    if (refusal) throw new Error(refusal);
    const adapters = options.adapters ?? installedAgentAdapters();
    if (!adapters.length)
      throw new Error(
        "No supported agent executable (claude, codex, pi) is on this server's PATH.",
      );
    this.starting = true;
    this.db = options.db;
    let hold: SupervisionHold | undefined;
    let supervisor: MarinaSupervisor | undefined;
    try {
      const url = options.url ?? localHttpBase();
      const principal = options.db.getPrincipal("human", options.owner)!;
      // The routing API's own issue, for the person who started it here.
      const issued = options.db.issueSupervisionCredential(principal.principal_id);
      hold = holdSupervision({
        url,
        grant: {
          credentialId: issued.credentialId,
          token: issued.token,
          expiresAt: issued.expiresAt,
        },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const stateDirectory =
        options.stateDirectory ?? worldSupervisorStateDirectory(options.owner, options.root);
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      const label = options.label ?? "World agents";
      supervisor = new MarinaSupervisor({
        client: hold.client,
        root: options.root,
        stateDirectory,
        label,
        binding: `world:${options.owner}:${options.root}`,
        adapters,
        agentEnvironment: supervisorAgentEnvironment(),
        secrets: [issued.token],
        residents: { connect: options.connect ?? marinaResidentConnector(residentWorldUrl(url)) },
        instructions: residentInstructions(),
      });
      const session = await supervisor.start();
      const run: Running = {
        owner: options.owner,
        root: options.root,
        label,
        supervisor,
        hold,
        sessionId: session.id,
        adapters: adapters.map((adapter) => adapter.label),
        startedAt: Date.now(),
        loop: Promise.resolve(),
        stopping: false,
      };
      this.current = run;
      this.lastFailure = undefined;
      this.lastError = undefined;
      run.loop = this.loop(run);
      if (options.persist !== false)
        options.db.setCoreMemory(
          WORLD_SUPERVISOR_STATE_OWNER,
          STATE_KEY,
          JSON.stringify({ owner: options.owner, root: options.root, label }),
        );
      log.info("routing", "In-world supervisor started", {
        owner: options.owner,
        root: options.root,
        adapters: run.adapters.join(","),
      });
      return this.status();
    } catch (error) {
      supervisor?.close();
      await hold?.close();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async loop(run: Running): Promise<void> {
    while (!run.stopping) {
      try {
        await run.supervisor.tick();
        this.lastError = undefined;
      } catch (error) {
        const message = getErrorMessage(error);
        if (message !== this.lastError)
          log.warn("routing", "In-world supervisor sync failed; output stays in its journal", {
            error: message,
          });
        this.lastError = message;
      }
      if (run.supervisor.failure) {
        this.lastFailure = run.supervisor.failure;
        log.error("routing", "In-world supervisor stopped", { error: run.supervisor.failure });
        void this.stop({ keep: true });
        return;
      }
      if (run.stopping) return;
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, TICK_MS);
        timer.unref?.();
        run.wake = () => {
          clearTimeout(timer);
          resolveSleep();
        };
      });
      run.wake = undefined;
    }
  }

  /**
   * Stop the supervisor: its native agents stop, its residents are retired,
   * a final sync publishes their last output, and its credential is revoked.
   * `keep` leaves the boot record (a server shutdown resumes it next boot);
   * an explicit `supervisor stop` clears it.
   */
  stop(options: { keep?: boolean } = {}): Promise<void> {
    if (!options.keep) this.forget();
    if (this.stopPromise) return this.stopPromise;
    const run = this.current;
    if (!run) return Promise.resolve();
    run.stopping = true;
    run.wake?.();
    this.stopPromise = (async () => {
      try {
        await run.loop;
        await run.supervisor.stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          run.supervisor.tick().catch((error) => {
            log.warn("routing", "In-world supervisor final sync failed; output kept in journal", {
              error: getErrorMessage(error),
            });
          }),
          new Promise<void>((resolveWait) => {
            timer = setTimeout(resolveWait, FINAL_SYNC_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      } catch (error) {
        log.warn("routing", "In-world supervisor did not stop cleanly", {
          error: getErrorMessage(error),
        });
      } finally {
        run.supervisor.close();
        await run.hold.close();
        this.current = undefined;
        this.stopPromise = undefined;
        log.info("routing", "In-world supervisor stopped", { owner: run.owner });
      }
    })();
    return this.stopPromise;
  }

  private forget(): void {
    try {
      this.db?.deleteCoreMemory(WORLD_SUPERVISOR_STATE_OWNER, STATE_KEY);
    } catch (error) {
      log.warn("routing", "Could not clear the in-world supervisor record", {
        error: getErrorMessage(error),
      });
    }
  }
}

/**
 * The project root a supervisor may run in: a directory inside the configured
 * Code Mode roots (`MARINA_CODE_ROOTS` / `MARINA_CODE_DEFAULT_ROOT`), the
 * default root when none is named — the same rule as Code Mode host
 * execution, which is refused while no root is configured.
 */
export function resolveSupervisorRoot(
  input: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { root: string } | { error: string } {
  let registry: WorkspaceRegistry;
  try {
    registry = WorkspaceRegistry.fromEnv(env);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
  if (!registry.hostExecAllowed)
    return {
      error:
        "No code root is configured, so host execution is off: set MARINA_CODE_ROOTS (or open a folder with `marina .`) and restart.",
    };
  try {
    return { root: registry.resolveRoot(input ?? "").root };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

/**
 * `MARINA_SUPERVISOR_AUTOSTART`: what the server starts on boot.
 * - `resume` (default): the supervisor a person started with `supervisor
 *   start` and did not stop, for that same person and root.
 * - `off`: nothing.
 * - `person:<name>`: a supervisor for that person's account in the default
 *   code root (the operator's choice, made in the environment).
 */
export function supervisorAutostart(
  env: NodeJS.ProcessEnv = process.env,
): { mode: "resume" } | { mode: "off" } | { mode: "person"; owner: string } {
  const raw = env.MARINA_SUPERVISOR_AUTOSTART?.trim() ?? "";
  if (!raw || raw.toLowerCase() === "resume") return { mode: "resume" };
  if (/^(off|false|0|no)$/i.test(raw)) return { mode: "off" };
  const person = /^person:(.+)$/i.exec(raw)?.[1]?.trim();
  if (person) return { mode: "person", owner: person };
  log.warn("routing", "Unknown MARINA_SUPERVISOR_AUTOSTART; nothing starts on boot", {
    value: raw.slice(0, 40),
  });
  return { mode: "off" };
}

/**
 * Boot: start what `MARINA_SUPERVISOR_AUTOSTART` asks for, once the HTTP
 * listener is up. Never throws: a supervisor that cannot start is logged and
 * the server boots without it (the person can `supervisor start` later).
 */
export async function autostartWorldSupervisor(
  host: WorldSupervisor,
  db: WorldSupervisorDb,
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<WorldSupervisorStartOptions> = {},
): Promise<WorldSupervisorStatus | undefined> {
  const autostart = supervisorAutostart(env);
  if (autostart.mode === "off" || !supervisedResidentsEnabled(env)) return undefined;
  const saved = autostart.mode === "resume" ? savedWorldSupervisor(db) : undefined;
  const owner = autostart.mode === "person" ? autostart.owner : saved?.owner;
  if (!owner) return undefined;
  const root = resolveSupervisorRoot(saved?.root, env);
  try {
    if ("error" in root) throw new Error(root.error);
    return await host.start({
      db,
      owner,
      root: root.root,
      ...(saved?.label ? { label: saved.label } : {}),
      ...overrides,
    });
  } catch (error) {
    log.warn("routing", "In-world supervisor did not start on boot", {
      owner,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

/** The supervisor a previous boot left running (owner, root, label), if any. */
export function savedWorldSupervisor(
  db: Pick<MarinaDB, "getCoreMemory">,
): { owner: string; root: string; label?: string } | undefined {
  const row = db.getCoreMemory(WORLD_SUPERVISOR_STATE_OWNER, STATE_KEY);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as { owner?: unknown; root?: unknown; label?: unknown };
    if (typeof parsed.owner !== "string" || typeof parsed.root !== "string") return undefined;
    return {
      owner: parsed.owner,
      root: parsed.root,
      ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
    };
  } catch {
    return undefined;
  }
}
