import { MarinaPanelClient } from "../src/sdk/panel-client";
import { CodePanels } from "./code-panels";
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import type { CommandOptions, MarinaAgent, Perception } from "../src/sdk/client";
import { CodeDiscovery } from "./code-discovery";
import { type CodingHarness, codingAgent, type HarnessStore } from "./code-harness";
import { inferCodeDefaultModel } from "./code-model";
import { installedCodingAdapters, NativeTerminal, type TerminalAgent } from "./code-native";
import { codingSessionPhase, workerActivityLabel } from "./code-presentation";
import {
  CodeTerminal,
  type CodeTerminalOptions,
  formatCodePerception,
  isWorldInput,
  QUIT_INPUTS,
  terminalEssentials,
  terminalHelp,
  terminalText,
  verificationReadinessLabel,
} from "./code-terminal";
import { perceptionView, type TranscriptView } from "./code-views";
import { workflowCommand } from "./code-workflow";

export interface CodeConsoleOptions {
  agent: MarinaAgent;
  url: string;
  root: string;
  directory: string;
  harness: CodingHarness;
  store: HarnessStore;
  finish: (code: number) => void;
  /** Attached to an existing world. Source and execution belong to that server. */
  connected?: boolean;
  sessionId?: string;
  tui?: boolean;
  terminalStreams?: Pick<CodeTerminalOptions, "input" | "output">;
  /** Where plain (non-terminal) output goes; default stdout. `-p --json` uses stderr. */
  plainOutput?: NodeJS.WritableStream;
}

export class CodeConsole {
  private terminal?: CodeTerminal;
  private discovery = new CodeDiscovery();
  private panels?: CodePanels;
  private native?: NativeTerminal;
  private startingNative?: Promise<NativeTerminal>;
  private selected?: string;
  private harness: CodingHarness;
  private marinaHarness: CodingHarness;
  private marinaBusy = false;
  private marinaPhase = "ready";
  private checksRunning = false;
  private verificationReadiness?: string;
  private workerActivity?: string;
  private workerObservedAt = -Infinity;
  private runId?: string;
  private runSettled = false;
  private supersededRuns = new Set<string>();
  private interrupted = false;
  private lastInterruptAt = 0;
  private closing = false;
  private interactive = true;
  private commands: Promise<void> = Promise.resolve();
  private sessionId?: string;
  private commandSequence = 0;
  private selectionSequence = 0;
  constructor(private options: CodeConsoleOptions) {
    this.sessionId = options.sessionId;
    this.harness = options.harness;
    this.marinaHarness =
      options.harness.agent === "marina"
        ? structuredClone(options.harness)
        : {
            version: 1,
            agent: "marina",
            model: inferCodeDefaultModel(process.env),
          };
  }
  /** Only confirmed results of commands issued by this view can select its session. */
  private async command(text: string, options?: CommandOptions) {
    const sequence = ++this.commandSequence;
    const result = await this.options.agent.command(text, options);
    let changedSession: string | undefined;
    if (result.completion === "confirmed" && sequence >= this.selectionSequence) {
      for (const p of result) {
        const code = p.data?.code as
          | { event?: string; sessionId?: string; workspace?: string }
          | undefined;
        if (
          !p.command_request_id ||
          !code?.sessionId ||
          !["session_started", "session_resumed", "session_branched", "code_mode_entered"].includes(
            code.event ?? "",
          )
        )
          continue;
        this.selectionSequence = sequence;
        if (this.sessionId !== code.sessionId) {
          this.marinaBusy = false;
          this.marinaPhase = "syncing";
          this.checksRunning = false;
          this.verificationReadiness = undefined;
          this.workerActivity = undefined;
          this.workerObservedAt = -Infinity;
          this.runId = undefined;
          this.runSettled = false;
          this.supersededRuns.clear();
          changedSession = code.sessionId;
        }
        this.sessionId = code.sessionId;
        if (code.workspace) this.options.root = code.workspace;
        if (this.options.connected) this.terminal?.setTarget(`marina:${this.sessionId}`);
      }
    }
    if (changedSession) {
      this.updatePrompt();
      try {
        // A fast worker may finish before selection is confirmed. Request fresh
        // status instead of replaying an earlier received event as current work.
        // The normal perception listener applies it once, in arrival order.
        await this.options.agent.command("code status", {
          codingTarget: { sessionId: changedSession },
        });
      } catch (error) {
        this.write(`Session selected; status refresh failed: ${getErrorMessage(error)}`);
      }
      if (this.sessionId === changedSession && this.marinaPhase === "syncing") {
        this.marinaPhase = "status unknown";
        this.updatePrompt();
      }
    }
    return result;
  }
  private activity() {
    if (this.runSettled || this.marinaPhase === "interrupt requested") return this.marinaPhase;
    return (
      this.workerActivity ??
      this.verificationReadiness ??
      `${this.marinaPhase}${this.checksRunning ? " · checks running" : ""}`
    );
  }
  private updatePrompt() {
    const selected = this.selected ? this.native?.agents.get(this.selected) : undefined;
    this.terminal?.setStatus(this.safeText(selected ? selected.state.status : this.activity()));
  }
  private safeText(text: string) {
    const token = this.options.agent.getSession()?.token;
    if (token)
      text = text
        .replaceAll(token, "[redacted]")
        .replaceAll(encodeURIComponent(token), "[redacted]");
    return terminalText(text);
  }
  write(text: string, view: TranscriptView = "all", urgent = false) {
    this.updatePrompt();
    text = this.safeText(text);
    if (this.terminal) this.terminal.write(text, view, urgent);
    else (this.options.plainOutput ?? process.stdout).write(`${text}\n`);
  }
  /** The one perception printer: metadata drives local views, never rendered prose. */
  /**
   * While the console sets itself up (selecting the launch harness), the
   * replies to its own setup commands are bookkeeping, not news: they are
   * observed but not printed. Errors and approval requests always print.
   */
  private settingUp = false;

  receive(p: Perception) {
    this.observe(p);
    this.discovery.observe(p, this.sessionId);
    const urgent = p.kind === "error" || p.kind === "auth_error" || !!p.data?.execApproval;
    if (this.settingUp && !urgent) return;
    const text = formatCodePerception(p, this.sessionId);
    if (text)
      this.write(
        text,
        perceptionView(p),
        p.kind === "error" || p.kind === "auth_error" || !!p.data?.execApproval,
      );
  }
  ask(text: string, signal?: AbortSignal) {
    return this.terminal?.ask(this.safeText(text), signal) ?? Promise.resolve("");
  }
  completed(sessionId?: string) {
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
    // Older integrations call this with only a session ID before observe().
    // Once an attempt is known, only its run-scoped terminal event can settle it.
    if (this.runId) return;
    this.marinaBusy = false;
    this.marinaPhase = "ready";
    this.workerActivity = undefined;
    this.workerObservedAt = -Infinity;
    this.updatePrompt();
  }
  observe(p: Perception) {
    const code = p.data?.code as
      | {
          event?: string;
          phase?: string;
          sessionId?: string;
          runId?: string;
          status?: string;
          verificationReadiness?: string;
          metadata?: {
            runId?: string;
            sessionId?: string;
            runStatus?: string;
            reviewStatus?: string;
            acceptedUnverified?: boolean;
            unverifiedAcceptance?: unknown;
            terminal?: boolean;
            outcome?: string;
            reason?: string;
            verificationReadiness?: string;
            workerState?: string;
            workerReason?: string;
            workerPauseKind?: string;
            workerObservedAt?: number;
          };
        }
      | undefined;
    if (!code) return;
    const meta = code.metadata ?? {};
    const sessionId = code.sessionId ?? meta.sessionId;
    if (this.sessionId && sessionId !== this.sessionId) return;
    const runId = meta.runId ?? code.runId;
    if (runId && runId !== this.runId) {
      if (this.supersededRuns.has(runId)) return;
      if (
        code.event !== "session_status" &&
        !(code.event === "code_lifecycle" && code.phase === "received")
      )
        return;
      if (this.runId) this.supersededRuns.add(this.runId);
      this.runId = runId;
      this.runSettled = false;
      this.verificationReadiness = undefined;
      this.workerActivity = undefined;
      this.workerObservedAt = -Infinity;
      this.checksRunning = false;
    } else if (this.runId && !runId) return;
    if (code.event === "task_run_review") {
      if (!runId || runId !== this.runId || !["approved", "rejected"].includes(code.status ?? ""))
        return;
      this.marinaPhase =
        code.status === "approved"
          ? meta.unverifiedAcceptance
            ? "accepted unverified"
            : "approved"
          : "rejected";
      this.runSettled = true;
      this.marinaBusy = false;
      this.checksRunning = false;
      this.workerActivity = undefined;
      this.verificationReadiness = undefined;
      this.updatePrompt();
      return;
    }
    if (this.runSettled && (code.event !== "session_status" || meta.runStatus === "active")) return;
    if (
      ["session_status", "worker_state_changed", "code_lifecycle"].includes(code.event ?? "") &&
      typeof meta.workerObservedAt === "number" &&
      Number.isFinite(meta.workerObservedAt) &&
      meta.workerObservedAt >= this.workerObservedAt &&
      ["working", "waiting", "paused", "recovering", "unavailable", "stopped", "unknown"].includes(
        meta.workerState ?? "",
      )
    ) {
      this.workerObservedAt = meta.workerObservedAt;
      this.workerActivity = workerActivityLabel(meta);
    }
    if (code.event === "session_status") {
      this.marinaBusy = meta.runStatus === "active";
      this.marinaPhase = codingSessionPhase(meta);
      this.runSettled = !!this.runId && !!meta.runStatus && meta.runStatus !== "active";
    }
    if (code.event === "verification_started") this.checksRunning = true;
    if (code.event === "verification_finished" || code.event === "verification_ran")
      this.checksRunning = false;
    if (
      (code.event === "verification_finished" || code.event === "verification_ran") &&
      this.verificationReadiness === "checks running"
    )
      this.verificationReadiness = undefined;
    if (code.event === "verification_required") {
      this.marinaBusy = true;
      this.marinaPhase = "working";
      this.verificationReadiness = "verification required";
    }
    if (code.event === "code_lifecycle") {
      if (code.phase === "received") this.marinaBusy = true;
      const phases: Record<string, string> = {
        received: "working",
        inspecting: "inspecting",
        planning: "planning",
        patching: "patching",
        applying: "applying",
        verifying: "verifying",
        awaiting_approval: "approval",
        submitting: "submitting",
      };
      this.marinaPhase = phases[code.phase ?? ""] ?? this.marinaPhase;
      if (meta.terminal || code.phase === "completed") {
        this.runSettled = !!this.runId;
        this.marinaBusy = false;
        this.checksRunning = false;
        this.verificationReadiness = undefined;
        this.marinaPhase =
          code.phase === "completed"
            ? "submitted for review"
            : meta.reason === "blocked"
              ? "blocked"
              : "stopped";
        this.updatePrompt();
        return;
      }
    }
    if (
      [
        "session_status",
        "code_lifecycle",
        "verification_required",
        "verification_started",
        "verification_ran",
        "verification_finished",
      ].includes(code.event ?? "")
    ) {
      const readiness = verificationReadinessLabel(
        meta.verificationReadiness ?? code.verificationReadiness,
      );
      if (readiness) this.verificationReadiness = readiness;
    }
    this.updatePrompt();
  }
  busy() {
    return this.selected
      ? ["running", "waiting", "starting"].includes(
          this.native?.agents.get(this.selected)?.state.status ?? "",
        )
      : this.marinaBusy;
  }
  /** UI input entry point. World input uses normal server admission independently of local launches. */
  submit(text: string): Promise<void> {
    text = text.trim();
    if (!text) return Promise.resolve();
    if (this.closing) return Promise.resolve();
    // Preserve the visible destination at input admission. World commands may
    // change the selection while an earlier coding request is still pending.
    const destination = { sessionId: this.sessionId, nativeId: this.selected };
    const report = (error: unknown) => this.write(getErrorMessage(error));
    if (
      isWorldInput(text) ||
      /^\/(?:view|panel)(?:\s|$)/.test(text) ||
      ["/help", "/help all", "/agents", "/stop", ...QUIT_INPUTS].includes(text)
    )
      return this.line(text, destination).catch(report);
    this.commands = this.commands.then(() => this.line(text, destination)).catch(report);
    return this.commands;
  }
  async start(interactive: boolean) {
    this.interactive = interactive;
    if (interactive || (this.options.terminalStreams?.input ?? process.stdin).isTTY) {
      this.terminal = new CodeTerminal({
        ...this.options.terminalStreams,
        views: interactive,
        tui: this.options.tui,
        connected: this.options.connected,
        completions: () => [
          ...this.discovery.suggestions(this.selected ? undefined : this.sessionId),
          ...[...(this.native?.agents.values() ?? [])]
            .filter((agent) => agent.state.role === "agent")
            .flatMap((agent) => {
              const inactive = ["disconnected", "stopped", "failed"].includes(agent.state.status);
              const verb = inactive
                ? agent.state.resumeSupported && agent.state.nativeSessionId
                  ? "/resume"
                  : undefined
                : "/use";
              const entries = verb
                ? [
                    {
                      value: `${verb} ${agent.session.id}`,
                      label: `${verb} ${agent.session.id}`,
                      description: this.safeText(agent.session.label).slice(0, 120),
                    },
                  ]
                : [];
              return entries;
            }),
        ],
        panelInput: (input) => this.panels?.input(input),
        viewChanged: (view) => this.panels?.setActive(view === "panel"),
        location: `${this.options.connected ? "Server" : "Local"} workspace · ${this.options.root}`,
        line: (text) => {
          if (!interactive) return;
          void this.submit(text);
        },
        interrupt: () => {
          void this.interrupt();
        },
        close: () => {
          void this.close(interactive ? 0 : 1);
        },
      });
    }
    if (interactive) this.write("Type a task in plain words, or /help.");
    if (this.options.connected) {
      this.terminal?.setTarget(`marina:${this.sessionId}`);
      this.write(
        "Connected to an existing world. Closing this terminal leaves its agents and tasks running.",
      );
      return;
    }
    this.settingUp = true;
    try {
      this.commands = this.selectHarness(this.harness, { quiet: true });
      await this.commands;
    } finally {
      this.settingUp = false;
    }
  }
  private async runtime() {
    if (this.options.connected)
      throw new Error(
        "Connected mode uses Marina's server-side coding agent. Local native runtimes need a separately configured workspace bridge.",
      );
    if (this.native) return this.native;
    if (!this.startingNative) {
      this.startingNative = (async () => {
        const runtime = new NativeTerminal({
          url: this.options.url,
          token: this.options.agent.getSession()!.token,
          root: this.options.root,
          directory: this.options.directory,
          write: (text) => this.write(text, "coding"),
          ask: (text, signal) => this.ask(text, signal),
        });
        await runtime.start();
        if (this.closing) {
          await runtime.stop();
          throw new Error("Terminal is closing");
        }
        this.native = runtime;
        return runtime;
      })().finally(() => {
        this.startingNative = undefined;
      });
    }
    return this.startingNative;
  }
  private async selectHarness(harness: CodingHarness, opts: { quiet?: boolean } = {}) {
    if (this.options.connected && harness.agent !== "marina")
      throw new Error(
        "Connected mode uses Marina's server-side coding agent; no local native runtime was launched.",
      );
    if (
      harness.agent === "marina" &&
      this.marinaBusy &&
      (harness.model !== this.marinaHarness.model || harness.profile !== this.marinaHarness.profile)
    )
      throw new Error("Stop or finish Marina's active task before changing its harness");
    await this.command(`code profile use ${harness.profile ?? "marina"}`);
    if (harness.agent === "marina") {
      if (harness.model) {
        const current = await this.command("code");
        if (!current.some((p) => (p.data?.code as { sessionId?: string } | undefined)?.sessionId))
          await this.command("code start");
        await this.command(`code model set ${harness.model}`);
      }
      this.selected = undefined;
      this.marinaHarness = structuredClone(harness);
    } else {
      if (!installedCodingAdapters().some((a) => a.id === harness.agent))
        throw new Error(`${harness.agent} is not installed in PATH`);
      const runtime = await this.runtime();
      const available = [...runtime.agents.values()].find(
        (a) => a.state.role === "agent" && a.state.status !== "disconnected",
      );
      // Only the first managed worker uses the user's actual folder. Additional writers are isolated.
      const workspace = available || this.marinaBusy ? "worktree" : "shared";
      let label = harness.agent as string;
      let number = 2;
      while ([...runtime.agents.values()].some((a) => a.session.label === label))
        label = `${harness.agent}-${number++}`;
      const agent = await runtime.launch(harness, label, workspace);
      this.selected = agent.session.id;
    }
    this.harness = structuredClone(harness);
    this.terminal?.setTarget(
      this.selected
        ? this.native!.agents.get(this.selected)!.session.label
        : this.options.connected
          ? `marina:${this.sessionId}`
          : "marina",
    );
    if (!opts.quiet)
      this.write(
        `Harness · ${harness.agent}${harness.model ? ` · ${harness.model}` : " · runtime default model"}${harness.profile ? ` · Marina dialect: ${harness.profile}` : ""}`,
      );
  }
  async task(text: string, wait = false, timeoutMs = 600_000) {
    this.interrupted = false;
    if (this.selected) {
      const id = this.selected;
      const revision = await this.native!.prompt(id, text, wait);
      if (wait) await this.native!.waitForTurn(id, revision, timeoutMs);
    } else {
      this.marinaBusy = true;
      this.marinaPhase = "working";
      this.updatePrompt();
      await this.command(`code do ${text}`);
    }
  }
  private select(agent: TerminalAgent) {
    if (["stopped", "failed", "disconnected"].includes(agent.state.status))
      throw new Error(
        "That session is not connected; use /resume for a supported session or launch new work",
      );
    this.selected = agent.session.id;
    this.harness = agent.harness ?? {
      version: 1,
      agent: codingAgent(agent.state.adapter),
      model: agent.state.model,
    };
    this.terminal?.setTarget(agent.session.label);
    this.write(`Selected ${agent.session.label} · ${agent.state.cwd}`);
  }
  private async line(text: string, destination: { sessionId?: string; nativeId?: string }) {
    if (this.closing) return;
    if (QUIT_INPUTS.includes(text)) {
      await this.close(0);
      return;
    }
    if (!text.startsWith("/")) {
      this.interrupted = false;
      if (this.selected) await this.task(text);
      else {
        // Preserve Code Mode's existing task/command/dialect parser.
        const results = await this.command(text);
        if (results.some((p) => p.kind === "error")) this.marinaBusy = false;
      }
      return;
    }
    const space = text.search(/\s/);
    const verb = space < 0 ? text : text.slice(0, space);
    const argument = space < 0 ? "" : text.slice(space + 1).trim();
    if (verb === "/view") {
      if (this.terminal) this.terminal.selectView(argument);
      else this.write("Focused views require an interactive terminal; /world remains available.");
      return;
    }
    if (verb === "/help") {
      this.write(
        argument === "all"
          ? terminalHelp(this.options.connected)
          : terminalEssentials(
              this.options.connected,
              this.options.connected ? [] : installedCodingAdapters().map((a) => a.id),
            ),
      );
      return;
    }
    if (verb === "/stop") {
      await this.stopSelected();
      return;
    }
    if (verb === "/resume") {
      const runtime = await this.runtime();
      const agent = [...runtime.agents.values()].find(
        (entry) => entry.session.id === argument || entry.session.label === argument,
      );
      if (!agent) throw new Error("Usage: /resume <exact name-or-id> from /agents");
      await runtime.control(agent.session.id, { action: "resume" });
      this.select(runtime.agents.get(agent.session.id)!);
      this.write(
        "Native history reconnected; inspect it before sending a new task. Prior instructions were not replayed.",
      );
      return;
    }
    if (verb === "/world") {
      if (!argument) throw new Error("Usage: /world <Marina command>");
      await this.command(`/${argument}`);
      return;
    }
    if (verb === "/task") {
      if (destination.nativeId || this.selected || this.harness.agent !== "marina")
        throw new Error(
          "/task uses Marina's verification workflow. /use marina selects it; native agents keep their own tools.",
        );
      if (!argument) throw new Error("Usage: /task <request>");
      this.interrupted = false;
      await this.command(
        `code do verification:candidate -- ${argument}`,
        destination.sessionId ? { codingTarget: { sessionId: destination.sessionId } } : undefined,
      );
      return;
    }
    const workflow = workflowCommand(verb, argument);
    if (workflow) {
      if (destination.nativeId || this.selected)
        throw new Error(
          "These controls inspect Marina's coding session. /use marina selects it; native agents keep their own tools.",
        );
      await this.command(
        workflow,
        destination.sessionId ? { codingTarget: { sessionId: destination.sessionId } } : undefined,
      );
      return;
    }
    if (verb === "/agents") {
      if (
        !this.options.connected &&
        !this.native &&
        existsSync(join(this.options.directory, "journal.db"))
      )
        await this.runtime();
      this.write(`marina · ${this.activity()} · ${this.options.root}`);
      for (const agent of this.native?.agents.values() ?? []) {
        if (agent.state.role === "agent")
          this.write(
            `${this.selected === agent.session.id ? "* " : "  "}${agent.session.label} · ${agent.state.status} · ${agent.state.cwd}\n  ${agent.session.id}`,
          );
      }
      return;
    }
    if (verb === "/use") {
      if (!argument) throw new Error("Usage: /use marina|claude|codex|pi|agent-name");
      const existing = [...(this.native?.agents.values() ?? [])].find(
        (a) => a.session.label === argument || a.session.id === argument,
      );
      if (existing) this.select(existing);
      else
        await this.selectHarness(
          argument === "marina" ? this.marinaHarness : { version: 1, agent: codingAgent(argument) },
        );
      return;
    }
    if (verb === "/spawn") {
      const [name, label, ...rest] = argument.split(/\s+/);
      const agent = codingAgent(name ?? "");
      if (agent === "marina" || rest.length)
        throw new Error("Usage: /spawn claude|codex|pi [name]");
      const runtime = await this.runtime();
      this.select(
        await runtime.launch(
          { version: 1, agent },
          label ?? `${agent}-${Date.now().toString(36)}`,
          "worktree",
        ),
      );
      return;
    }
    if (verb === "/harness") {
      if (!argument || argument === "export") {
        this.write(JSON.stringify(this.harness, null, 2));
        return;
      }
      if (argument === "list") {
        this.write(
          this.options.store.list().join("\n") ||
            "No saved harnesses. /harness save <name> remembers this selection.",
        );
        return;
      }
      if (argument.startsWith("save ")) {
        this.options.store.save(argument.slice(5).trim(), this.harness);
        this.write(
          `Saved ${this.options.connected ? "harness" : "as this folder's default"}: ${this.options.store.path}`,
        );
        return;
      }
      if (argument.startsWith("use ")) {
        await this.selectHarness(this.options.store.load(argument.slice(4).trim())!);
        return;
      }
      throw new Error("Usage: /harness [list|save <name>|use <name-or-path>|export]");
    }
    if (verb === "/panel") {
      this.panels ??= new CodePanels(
        new MarinaPanelClient({
          url: this.options.url,
          token: () => this.options.agent.getSession()?.token,
        }),
        (content, focus) => {
          if (this.terminal) this.terminal.setPanelContent(content, focus);
          else this.write(content);
        },
        async (id, spaceId, signal) => {
          const result = await this.options.agent.memoryService(
            {
              operation: "get",
              id,
              space_id: spaceId,
            },
            15000,
            signal,
          );
          if (!result.ok) throw new Error("Memory unavailable");
          return result.result;
        },
        {
          present: (state) => this.terminal?.setPanelState(state),
          ask: async (sessionId, request) => {
            const result = await this.options.agent.command(`code ask ${request}`, {
              codingTarget: { sessionId },
            });
            return result.completion === "confirmed"
              ? "Coding request completed; inspect the session activity for its outcome."
              : "Outcome unconfirmed. Reconcile session activity before submitting again.";
          },
        },
      );
      const parts = argument.trim().split(/\s+/);
      await this.panels.command(
        ((parts[0] === "desk" && parts.length === 1) ||
          (parts[0] === "publish" && parts.length === 2)) &&
          this.sessionId
          ? `${argument} ${this.sessionId}`
          : argument,
      );
      return;
    }
    if (verb === "/dashboard") {
      // This HTTP-only workspace does not reconnect Chat's single WebSocket.
      const url = `${this.options.url}/terminal#marina-token=${encodeURIComponent(this.options.agent.getSession()!.token)}`;
      const command =
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
            : ["xdg-open", url];
      const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
      if (await child.exited) this.write(`Open ${this.options.url} in your browser.`);
      return;
    }
    throw new Error(
      `Unknown terminal command: ${verb}. /help lists controls; /world sends Marina commands.`,
    );
  }
  private async stopSelected() {
    if (this.selected) await this.native!.control(this.selected, { action: "interrupt" });
    else await this.command("code stop");
    this.marinaBusy = false;
    if (!this.runSettled) this.marinaPhase = "interrupt requested";
    this.write("Interrupt requested. Inspect output before starting replacement work.");
  }
  async interrupt() {
    if (this.closing) return;
    // readline and the process signal can both report the same physical keypress.
    const now = Date.now();
    if (now - this.lastInterruptAt < 200) return;
    this.lastInterruptAt = now;
    if (this.busy() && !this.interrupted) {
      this.interrupted = true;
      this.write("Interrupting selected agent. Ctrl+C again exits.");
      try {
        await this.stopSelected();
      } catch (error) {
        this.write(getErrorMessage(error));
      }
    } else await this.close(this.interactive ? 0 : 1);
  }
  async close(code: number) {
    if (this.closing) return;
    this.closing = true;
    this.panels?.dispose();
    this.terminal?.close();
    try {
      await this.startingNative?.catch(() => undefined);
      await this.native?.stop();
    } finally {
      this.options.finish(code);
    }
  }
}
