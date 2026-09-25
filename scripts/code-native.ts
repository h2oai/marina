// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { getErrorMessage } from "../src/engine/errors";
import { type AgentAdapter, BUILTIN_AGENT_ADAPTERS } from "../src/routing/agent-adapters";
import { MarinaSupervisor } from "../src/routing/supervisor";
import {
  MarinaRoutingClient,
  type RuntimeControl,
  type RuntimeState,
} from "../src/sdk/routing-client";
import type { RoutingEventInput, RoutingSession } from "../src/sdk/routing-types";
import type { CodingHarness } from "./code-harness";
import { participantInstructions } from "./supervise";

export interface TerminalAgent {
  session: RoutingSession;
  state: RuntimeState;
  harness?: CodingHarness;
  revision: number;
  failure?: string;
}
export interface NativeTerminalOptions {
  url: string;
  token: string;
  root: string;
  directory: string;
  write: (text: string) => void;
  ask: (text: string, signal?: AbortSignal) => Promise<string>;
  client?: MarinaRoutingClient;
  adapters?: AgentAdapter[];
  /** Override for embedded clients/tests; the terminal uses one batched sync per second. */
  intervalMs?: number;
}
export function installedCodingAdapters(): AgentAdapter[] {
  return BUILTIN_AGENT_ADAPTERS.flatMap((adapter) => {
    const executable = Bun.which(adapter.executable);
    return executable ? [{ ...adapter, executable }] : [];
  });
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Owns local native processes; every control still passes Marina's authenticated routing API. */
export class NativeTerminal {
  readonly agents = new Map<string, TerminalAgent>();
  private client: MarinaRoutingClient;
  private supervisor?: MarinaSupervisor;
  private owner?: RoutingSession;
  private deliveries = new Map<string, string | null>();
  private listeners = new Set<() => void>();
  private output = new Map<string, string>();
  private outputTimer?: ReturnType<typeof setTimeout>;
  private requests = new Map<string, AbortController>();
  private loop?: Promise<void>;
  private stopping = false;
  private revision = 0;
  constructor(private options: NativeTerminalOptions) {
    this.client =
      options.client ?? new MarinaRoutingClient({ url: options.url, token: options.token });
  }
  async start() {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    this.supervisor = new MarinaSupervisor({
      client: this.client,
      root: this.options.root,
      stateDirectory: this.options.directory,
      binding: `terminal:${this.options.root}`,
      label: "Marina terminal",
      adapters: this.options.adapters ?? installedCodingAdapters(),
      agentEnvironment: {
        ...process.env,
        MARINA_URL: this.options.url,
        MARINA_TOKEN: this.options.token,
      },
      secrets: [this.options.token],
      instructions: participantInstructions(),
      onEvent: (session, event) => this.event(session, event),
    });
    try {
      this.owner = await this.supervisor.start();
      this.loop = this.pump();
    } catch (error) {
      this.supervisor.close();
      throw error;
    }
  }
  private async pump() {
    let disconnected = false;
    while (!this.stopping) {
      try {
        await this.supervisor!.tick();
        if (disconnected)
          this.options.write("Marina routing reconnected; queued output is being synchronized.");
        disconnected = false;
      } catch (error) {
        if (!disconnected)
          this.options.write(
            `Routing disconnected: ${getErrorMessage(error)}. Output remains in the local journal; retrying…`,
          );
        disconnected = true;
      }
      if (this.supervisor!.failure) {
        this.options.write(`Native runtime stopped: ${this.supervisor!.failure}`);
        this.stopping = true;
        for (const listener of this.listeners) listener();
        break;
      }
      // One batched sync for the entire roster, below the existing HTTP budget.
      if (!this.stopping) await Bun.sleep(this.options.intervalMs ?? 1000);
    }
  }
  private flush() {
    clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
    for (const [id, text] of this.output) {
      if (text)
        this.options.write(`[${this.agents.get(id)?.session.label ?? id}] ${text.trimEnd()}`);
    }
    this.output.clear();
  }
  private event(session: RoutingSession, event: RoutingEventInput) {
    const payload = record(event.payload);
    const revision = ++this.revision;
    if (event.kind === "runtime.state") {
      const state = payload as unknown as RuntimeState;
      const old = this.agents.get(session.id);
      this.agents.set(session.id, { ...old, session, state, revision });
      if (
        state.role === "agent" &&
        (old?.state.status !== state.status || old?.state.error !== state.error)
      ) {
        this.flush();
        this.options.write(
          `[${session.label}] ${state.status}${state.error ? ` · ${state.error}` : ""}`,
        );
      }
    } else if (event.kind === "output" && typeof payload.text === "string") {
      this.output.set(session.id, (this.output.get(session.id) ?? "") + payload.text);
      if ((this.output.get(session.id)?.length ?? 0) > 8000) this.flush();
      else this.outputTimer ??= setTimeout(() => this.flush(), 100);
    } else if (event.kind === "delivery.accepted" || event.kind === "delivery.error") {
      this.deliveries.set(
        String(payload.messageId),
        event.kind === "delivery.error" ? String(payload.text) : null,
      );
      if (this.deliveries.size > 1000) this.deliveries.delete(this.deliveries.keys().next().value!);
      if (event.kind === "delivery.error")
        this.options.write(`[${session.label}] ${payload.text}. Inspect output before retrying.`);
    } else if (event.kind === "approval.requested") {
      void this.approval(session, payload).catch((error) =>
        this.options.write(`Approval failed: ${getErrorMessage(error)}`),
      );
    } else if (event.kind === "approval.resolved") {
      this.requests.get(String(payload.requestId))?.abort();
    } else if (event.kind === "workspace.prepared") {
      this.options.write(
        `[${session.label}] Workspace: ${payload.cwd}${payload.dirty ? " (committed HEAD; uncommitted source edits are not copied)" : ""}`,
      );
    } else if (event.kind === "stderr" || event.kind === "adapter.error") {
      if (typeof payload.text === "string")
        this.options.write(`[${session.label}] ${payload.text}`);
    } else if (event.kind === "native.result" && payload.is_error) {
      const agent = this.agents.get(session.id);
      if (agent)
        agent.failure = String(
          payload.result ?? JSON.stringify(payload.errors) ?? "Native turn failed",
        );
    } else if (
      event.kind === "native.turn/completed" &&
      record(payload.turn).status !== "completed"
    ) {
      const agent = this.agents.get(session.id);
      if (agent) agent.failure = `Native turn ${String(record(payload.turn).status)}`;
    } else if (
      event.kind.startsWith("native.") &&
      !["native.assistant", "native.user"].includes(event.kind)
    ) {
      // Compact activity in the terminal; complete native payloads stay in Streams.
      if (/tool|item\/started|item\/completed|result|agent_settled/.test(event.kind))
        this.options.write(
          `[${session.label}] ${event.kind.slice(7)}${typeof payload.toolName === "string" ? ` · ${payload.toolName}` : ""}`,
        );
    }
    for (const listener of this.listeners) listener();
  }
  private async approval(session: RoutingSession, payload: Record<string, unknown>) {
    const id = String(payload.id);
    if (this.requests.has(id)) return;
    const cancellation = new AbortController();
    this.requests.set(id, cancellation);
    try {
      this.flush();
      this.options.write(
        `[${session.label}] ${payload.title}\n${JSON.stringify(payload.input, null, 2)}`,
      );
      const question = payload.kind === "question";
      const answer = await this.options.ask(
        `[${session.label}] ${question ? "Answer (blank cancels)" : "Allow? [y/N]"}: `,
        cancellation.signal,
      );
      if (this.stopping || cancellation.signal.aborted) return;
      await this.control(session.id, {
        action: "respond",
        requestId: id,
        allow: question ? !!answer.trim() : /^y(es)?$/i.test(answer.trim()),
        ...(question ? { answer } : {}),
      });
    } finally {
      this.requests.delete(id);
    }
  }
  private wait<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = () => {
        if (this.stopping) {
          finish();
          reject(new Error("Native runtime stopped"));
          return;
        }
        const value = read();
        if (value !== undefined) {
          finish();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("Native response timed out; inspect /agents and output before retrying"));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }
  async control(targetId: string, control: RuntimeControl) {
    if (!this.owner || this.stopping) throw new Error("Native runtime is not connected");
    const message = await this.client.control(
      this.owner.id,
      targetId,
      crypto.randomUUID(),
      control,
      AbortSignal.timeout(15_000),
    );
    const result = await this.wait(() =>
      this.deliveries.has(message.id) ? { error: this.deliveries.get(message.id) } : undefined,
    );
    if (result.error) throw new Error(result.error);
    return message;
  }
  async launch(harness: CodingHarness, label: string, workspace: "shared" | "worktree") {
    if ([...this.agents.values()].some((a) => a.session.label === label))
      throw new Error(`Agent name already in use: ${label}`);
    const message = await this.control(this.owner!.id, {
      action: "launch",
      adapter: harness.agent,
      label,
      workspace,
      model: harness.model,
    });
    const agent = [...this.agents.values()].find(
      (a) => a.session.clientKey === `run:${message.id}`,
    );
    if (!agent) throw new Error("Launch acknowledged without a runtime session; inspect Streams");
    agent.harness = structuredClone(harness);
    await this.client.publish(
      agent.session.id,
      [{ id: crypto.randomUUID(), kind: "harness.selected", payload: harness }],
      AbortSignal.timeout(15_000),
    );
    return agent;
  }
  async prompt(id: string, text: string, waitAccepted = true) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("Unknown native agent");
    agent.failure = undefined;
    const revision = this.revision;
    if (waitAccepted) await this.control(id, { action: "prompt", text });
    else {
      await this.client.control(
        this.owner!.id,
        id,
        crypto.randomUUID(),
        { action: "prompt", text },
        AbortSignal.timeout(15_000),
      );
      this.options.write(`[${agent.session.label}] Instruction queued in Marina`);
    }
    return revision;
  }
  async waitForTurn(id: string, after: number, timeoutMs: number) {
    const agent = await this.wait(() => {
      const current = this.agents.get(id);
      return current &&
        current.revision > after &&
        ["idle", "failed", "stopped", "disconnected"].includes(current.state.status)
        ? current
        : undefined;
    }, timeoutMs);
    this.flush();
    if (agent.state.status !== "idle" || agent.failure)
      throw new Error(agent.failure ?? agent.state.error ?? `Native agent ${agent.state.status}`);
  }
  async stop() {
    this.stopping = true;
    for (const listener of this.listeners) listener();
    await this.loop;
    try {
      await this.supervisor?.stop();
      await this.supervisor?.tick();
    } catch (error) {
      this.options.write(
        `Final output retained in ${this.options.directory}: ${getErrorMessage(error)}`,
      );
    } finally {
      this.supervisor?.close();
      this.flush();
    }
  }
}
