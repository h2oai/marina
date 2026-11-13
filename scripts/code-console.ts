import { MarinaPanelClient } from "../src/sdk/panel-client";
import { CodePanels } from "./code-panels";
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import type { CommandOptions, MarinaAgent, Perception } from "../src/sdk/client";
import { worldEssentials } from "./code-controls";
import { colorizeDiff, type DiffPayload, diffColorEnabled, diffPayloadFor } from "./code-diff";
import { CodeDiscovery } from "./code-discovery";
import { type CodingHarness, codingAgent, type HarnessStore } from "./code-harness";
import { fastestModelFor, inferCodeDefaultModel } from "./code-model";
import { addressedMessage, MODES, type WorkspaceMode } from "./code-modes";
import { installedCodingAdapters, NativeTerminal, type TerminalAgent } from "./code-native";
import {
  codePerceptionFormat,
  codingSessionPhase,
  renderRunResult,
  workerActivityLabel,
} from "./code-presentation";
import { styleActivity, styleCodeEntry, themeFor } from "./code-style";
import {
  CodeTerminal,
  type CodeTerminalOptions,
  formatCodePerception,
  isWorldInput,
  NO_CODING,
  QUIT_INPUTS,
  terminalEssentials,
  terminalHelp,
  terminalText,
  verificationReadinessLabel,
} from "./code-terminal";
import { type EntryFormat, perceptionView, type TranscriptView } from "./code-views";
import { workflowCommand } from "./code-workflow";
import { findPanel, PANELS } from "./term-panels";
import { loadCliConfig, renderFormat, type SegmentContext } from "./term-prompt";
import { sanitizeServerText } from "./term-sanitize";
import { httpBase, WorldStatus } from "./term-status";
import type { Theme } from "./term-theme";

/** World panels `/live` serves; prompt and theme stay with `marina connect`. */
const LIVE_PANELS = PANELS.map((panel) => panel.name).filter(
  (name) => !["prompt", "theme"].includes(name),
);

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
  /**
   * A world view with no coding session (`marina connect --tui`): the World and the
   * use-case boards only. Coding controls are refused, never sent.
   */
  worldOnly?: boolean;
  sessionId?: string;
  tui?: boolean;
  /** First use-case mode for --tui (default coding). */
  mode?: WorkspaceMode;
  /** The welcome card already told the person what to type. */
  welcomed?: boolean;
  /** No provider key or local runtime: idle reads "no model", never "ready". */
  noModel?: boolean;
  terminalStreams?: Pick<CodeTerminalOptions, "input" | "output">;
  /** Where plain (non-terminal) output goes; default stdout. `-p --json` uses stderr. */
  plainOutput?: NodeJS.WritableStream;
}

/** What a world-only view runs locally; everything else needs a coding session. */
const WORLD_ONLY_VERBS = ["/world", "/live", "/view", "/help", "/panel", "/dashboard"];

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
  private marinaPhase: string;
  private checksRunning = false;
  private verificationReadiness?: string;
  private workerActivity?: string;
  private workerObservedAt = -Infinity;
  private runId?: string;
  private runSettled = false;
  /** The end-of-run result block, once per attempt (interactive only). */
  private resultShown = new Set<string>();
  private runStartedAt?: number;
  /** Each agent's reported spend when the run began (ops snapshot), for the run's own cost. */
  private runCostStart = new Map<string, number>();
  /** When the coder's stream last spoke: the result waits until its final words are in. */
  private lastStreamAt = 0;
  /** When the coder last finished a message (its words, not a tool line). */
  private lastProseAt = 0;
  /** While the result block fetches the diff, that reply is not echoed on its own. */
  private quietReplies = false;
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
    this.marinaPhase = this.idlePhase();
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
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }
  private idlePhase(): string {
    return this.options.noModel ? "no model" : "ready";
  }
  private activity() {
    if (this.runSettled || this.marinaPhase === "interrupt requested") return this.marinaPhase;
    const base =
      this.workerActivity ??
      this.verificationReadiness ??
      `${this.marinaPhase}${this.checksRunning ? " · checks running" : ""}`;
    if (!this.marinaBusy || this.runStartedAt === undefined) return base;
    // Alive and moving: how long it has been working and what it did last.
    const s = Math.max(0, Math.floor((Date.now() - this.runStartedAt) / 1000));
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return `${base} · ${clock}${this.lastStep ? ` · ${this.lastStep}` : ""}`;
  }
  /** The coder's latest visible step ("Edit paginate.js"), for the status line. */
  private lastStep?: string;
  private ticker?: ReturnType<typeof setInterval>;
  private updatePrompt() {
    const selected = this.selected ? this.native?.agents.get(this.selected) : undefined;
    this.terminal?.setStatus(this.safeText(selected ? selected.state.status : this.activity()));
  }
  /** Live world state for the status line and `/live` panels (same data as the dashboard). */
  private liveStatus?: WorldStatus;
  private liveFormat = loadCliConfig().status;

  private startLiveStatus() {
    const session = this.options.agent.getSession();
    if (!session) return;
    this.liveStatus = new WorldStatus(
      httpBase(this.options.url),
      () => this.options.agent.getSession()?.token,
      session.name,
    );
    this.liveStatus.onChange(() => this.terminal?.refreshStatus());
    this.liveStatus.want(MODES[this.terminal?.currentMode ?? "coding"].parts ?? []);
    this.liveStatus.start();
  }

  private liveContext(theme: Theme): SegmentContext {
    const status = this.liveStatus;
    return {
      theme,
      name: this.options.agent.getSession()?.name ?? "",
      connected:
        typeof this.options.agent.isConnected === "function"
          ? this.options.agent.isConnected()
          : true,
      snapshot: status?.snapshot ?? { at: {} },
      room: status?.room(),
      here: status?.roomPopulation(),
      queued: 0,
      cwd: this.options.root,
    };
  }

  private liveStatusLine(): string {
    if (!this.liveStatus) return "";
    const out = (this.options.terminalStreams?.output ?? process.stderr) as {
      isTTY?: boolean;
      columns?: number;
    };
    const theme = themeFor(out.isTTY ? out : undefined);
    return theme.level ? renderFormat(this.liveFormat, this.liveContext(theme)) : "";
  }

  /** A mode's board: its live cards stacked, each sized to the board pane. */
  private board(mode: WorkspaceMode, width: number): string[] {
    const out = (this.options.terminalStreams?.output ?? process.stderr) as { isTTY?: boolean };
    const theme = themeFor(out.isTTY ? { isTTY: true, columns: width } : undefined);
    const context = this.liveContext(theme);
    return MODES[mode].board.flatMap((name) => {
      const panel = findPanel(name);
      if (!panel) return [];
      return [
        ...panel.render(context).map((line) => sanitizeServerText(this.redact(line), theme)),
        "",
      ];
    });
  }

  /** `/live [panel]`: a dashboard view of the live world, drawn in the terminal. */
  private async live(argument: string) {
    const name = argument.trim() || "status";
    const panel = findPanel(name);
    if (!panel || ["prompt", "theme"].includes(panel.name)) {
      this.write(
        `No live panel "${name}". Panels: ${LIVE_PANELS.join(", ")}. Formats and themes: marina connect → /prompt, /theme.`,
      );
      return;
    }
    if (!this.liveStatus) this.startLiveStatus();
    await this.liveStatus?.refresh(true, panel.needs ?? ["health", "system", "world", "profile"]);
    const out = (this.options.terminalStreams?.output ?? process.stderr) as {
      isTTY?: boolean;
      columns?: number;
    };
    // In the fullscreen workspace the card goes to the focused pane only, drawn at that
    // pane's width; a terminal-wide card would wrap its borders inside a narrow pane.
    const target = this.terminal?.cardTarget();
    const sized =
      target?.columns === undefined ? out : { isTTY: out.isTTY, columns: target.columns };
    const theme = themeFor(sized.isTTY ? sized : undefined);
    this.write(
      panel.render(this.liveContext(theme)).join("\n"),
      target?.view ?? "all",
      false,
      "styled",
    );
  }

  private redact(text: string) {
    const token = this.options.agent.getSession()?.token;
    if (token)
      text = text
        .replaceAll(token, "[redacted]")
        .replaceAll(encodeURIComponent(token), "[redacted]");
    return text;
  }
  private safeText(text: string) {
    return terminalText(this.redact(text));
  }
  write(text: string, view: TranscriptView = "all", urgent = false, format?: EntryFormat) {
    this.updatePrompt();
    // A locally rendered panel keeps its vetted colour (re-checked on print).
    text = format === "styled" ? this.redact(text) : this.safeText(text);
    if (this.terminal) this.terminal.write(text, view, urgent, format);
    else {
      const out = this.options.plainOutput ?? process.stdout;
      const stream = out as { isTTY?: boolean; columns?: number };
      const theme = themeFor(stream.isTTY ? stream : undefined);
      out.write(
        `${format === "diff" ? colorizeDiff(text, diffColorEnabled(stream), theme) : format === "styled" ? sanitizeServerText(text, theme) : format === "activity" ? styleActivity(text, theme) : styleCodeEntry(text, theme)}\n`,
      );
    }
  }
  /** The one perception printer: metadata drives local views, never rendered prose. */
  /**
   * While the console sets itself up (selecting the launch harness), the
   * replies to its own setup commands are bookkeeping, not news: they are
   * observed but not printed. Errors and approval requests always print.
   */
  private settingUp = false;

  receive(p: Perception) {
    const stream = p.data?.code as
      | {
          event?: string;
          metadata?: { kind?: string; activity?: { label?: unknown; quiet?: unknown } };
        }
      | undefined;
    if (stream?.event === "agent_output") {
      this.lastStreamAt = Date.now();
      if (stream.metadata?.kind === "prose") this.lastProseAt = Date.now();
      const step = stream.metadata?.kind === "tool" ? stream.metadata.activity : undefined;
      if (step && step.quiet !== true && typeof step.label === "string")
        this.lastStep = terminalText(step.label).slice(0, 60);
    }
    // The result block's own `code diff` reply is part of that block, not a separate entry.
    if (this.quietReplies && p.command_request_id) {
      this.observe(p);
      return;
    }
    this.observe(p);
    const mention = addressedMessage(p, this.options.agent.getSession()?.name ?? "");
    if (mention)
      this.terminal?.noteMention(this.redact(mention.from), this.redact(mention.message));
    this.discovery.observe(p, this.sessionId);
    const urgent = p.kind === "error" || p.kind === "auth_error" || !!p.data?.execApproval;
    if (this.settingUp && !urgent) return;
    const text = formatCodePerception(p, this.sessionId);
    if (text)
      this.write(
        text,
        perceptionView(p),
        p.kind === "error" || p.kind === "auth_error" || !!p.data?.execApproval,
        codePerceptionFormat(p),
      );
  }
  /**
   * The end of a run, once: wait for the coder's last words, then the session diff,
   * the checks, the time and cost, and the exact next commands (`renderRunResult`).
   */
  private async showResult(runId: string, meta: Record<string, unknown> | undefined) {
    const m = meta ?? {};
    // The coder's closing words usually arrive just after it submits: wait for them
    // (and a short quiet after), so the result is the last thing on the page.
    const endedAt = Date.now();
    const giveUp = endedAt + 12_000;
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 200));
    while (Date.now() < giveUp && this.lastProseAt < endedAt - 3_000) await sleep();
    while (Date.now() < giveUp && Date.now() - this.lastStreamAt < 800) await sleep();
    let diff: DiffPayload | undefined;
    this.quietReplies = true;
    try {
      const replies = await this.command("code diff");
      diff = replies
        .map((p) => diffPayloadFor(p.data?.code as Record<string, unknown> | undefined))
        .find((d): d is DiffPayload => d !== undefined);
    } catch {
      // No diff to show: the block still says how the run ended.
    } finally {
      this.quietReplies = false;
    }
    if (runId !== this.runId) return; // a newer run started meanwhile
    const agent = typeof m.agent === "string" ? m.agent : undefined;
    let costUsd: number | undefined;
    if (agent && this.liveStatus) {
      await this.liveStatus.refresh(true, ["ops"]).catch(() => undefined);
      const now = this.liveStatus.snapshot.ops?.agents.find((a) => a.name === agent);
      if (now) costUsd = now.cost.totalUsd - (this.runCostStart.get(agent) ?? 0);
    }
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    this.write(
      renderRunResult({
        outcome: text(m.outcome),
        reason: text(m.reason),
        detail: text(m.detail),
        verification: text(m.verification),
        verificationReason: text(m.verificationReason),
        budgetForced: !!m.budgetForced,
        runId,
        ...(this.runStartedAt !== undefined ? { elapsedMs: Date.now() - this.runStartedAt } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(diff ? { diff } : {}),
      }),
      "coding",
      false,
      "diff",
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
    this.marinaPhase = this.idlePhase();
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
      this.runStartedAt = Date.now();
      this.lastStep = undefined;
      this.runCostStart = new Map(
        (this.liveStatus?.snapshot.ops?.agents ?? []).map((a) => [a.name, a.cost.totalUsd]),
      );
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
      const phase = codingSessionPhase(meta);
      // An idle session is "ready" only when a model can run its tasks.
      this.marinaPhase = phase === "ready" ? this.idlePhase() : phase;
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
        // One block per submission: a run the coder submits again gets the new outcome.
        const resultKey = `${this.runId}:${String((code.metadata as { summaryId?: unknown })?.summaryId ?? "")}`;
        if (this.interactive && this.runId && !this.resultShown.has(resultKey)) {
          this.resultShown.add(resultKey);
          void this.showResult(this.runId, code.metadata as Record<string, unknown>).catch(() => {
            // The result block is a summary of what already printed; a failed fetch loses nothing.
          });
        }
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
        worldOnly: this.options.worldOnly,
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
        location: this.options.worldOnly
          ? `World · ${this.options.url}`
          : `${this.options.connected ? "Server" : "Local"} workspace · ${this.options.root}`,
        statusLine: () => this.liveStatusLine(),
        ...(this.options.mode ? { mode: this.options.mode } : {}),
        modeChanged: (mode) => {
          this.liveStatus?.want(MODES[mode].parts ?? []);
          void this.liveStatus?.refresh(true);
        },
        board: (mode, width) => this.board(mode, width),
        status: this.idlePhase(),
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
    if (interactive && this.terminal) this.startLiveStatus();
    // The working clock ticks once a second while a run is busy.
    if (interactive && this.terminal) {
      this.ticker = setInterval(() => {
        if (this.marinaBusy && !this.runSettled) this.updatePrompt();
      }, 1_000);
      this.ticker.unref?.();
    }
    if (interactive && (!this.options.welcomed || this.terminal?.currentMode !== "coding"))
      this.write(MODES[this.terminal?.currentMode ?? "coding"].hint);
    if (this.options.worldOnly) {
      this.write(
        "World view: no coding session. F3 cycles modes; closing this terminal leaves the world running.",
      );
      return;
    }
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
          write: (text, format) => this.write(text, "coding", false, format),
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
  async task(
    text: string,
    wait = false,
    timeoutMs = 600_000,
    unattended = false,
    verification: "checks" | "candidate" | "delivery" = "checks",
    /** An unattended task's wall-clock budget (ms), sent as `budget:<seconds>s`. */
    budgetMs?: number,
    /** Candidate only: verified means the repository's own gates passed (`gates:repository`). */
    gates = false,
  ) {
    this.interrupted = false;
    if (this.selected) {
      const id = this.selected;
      const revision = await this.native!.prompt(id, text, wait);
      if (wait) await this.native!.waitForTurn(id, revision, timeoutMs);
    } else {
      this.marinaBusy = true;
      this.marinaPhase = "working";
      this.updatePrompt();
      await this.command(
        `code do ${unattended ? `verification:${verification} ${gates && verification === "candidate" ? "gates:repository " : ""}owner:unattended ` : ""}${unattended && budgetMs ? `budget:${Math.max(1, Math.floor(budgetMs / 1000))}s ` : ""}-- ${text}`,
      );
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
    // `@name …`, `@a,b …`, `@all …`, `@@…`: world shorthand for `agent
    // attention` (the server expands it, src/engine/parse-mentions.ts), never a
    // prompt to the selected native agent.
    if (text.startsWith("@") && text.length > 1) {
      await this.command(text);
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
    if (this.options.worldOnly && !WORLD_ONLY_VERBS.includes(verb)) {
      this.write(`${verb} needs a coding session. ${NO_CODING}`);
      return;
    }
    if (verb === "/view") {
      if (this.terminal) this.terminal.selectView(argument);
      else this.write("Focused views require an interactive terminal; /world remains available.");
      return;
    }
    if (verb === "/help" && this.options.worldOnly) {
      this.write(worldEssentials());
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
    if (verb === "/live") {
      await this.live(argument);
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
    if (verb === "/continue") {
      if (this.harness.agent !== "marina")
        throw new Error(
          "/continue resumes Marina's session in this folder. /use marina selects it; native agents use /resume.",
        );
      await this.command("code continue");
      return;
    }
    if (verb === "/cost" || verb === "/usage") {
      await this.command("code cost");
      return;
    }
    if (verb === "/compact") {
      await this.command("code compact");
      return;
    }
    if (verb === "/world") {
      if (!argument) throw new Error("Usage: /world <Marina command>");
      await this.command(`/${argument}`);
      return;
    }
    if (verb === "/memory") {
      const [sub] = argument.split(/\s+/);
      if (!argument) {
        await this.command("/note list");
        return;
      }
      if (sub === "save") {
        const line = argument.slice("save".length).trim();
        if (!line) throw new Error("Usage: /memory save <line>");
        await this.command(`/note ${line}`);
        return;
      }
      if (sub === "recall") {
        const query = argument.slice("recall".length).trim();
        if (!query) throw new Error("Usage: /memory recall <query>");
        await this.command(`/recall ${query}`);
        return;
      }
      throw new Error("Usage: /memory [save <line> | recall <query>]");
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
    if (verb === "/plan") {
      if (destination.nativeId || this.selected || this.harness.agent !== "marina")
        throw new Error(
          "/plan uses Marina's plan mode. /use marina selects it; native agents keep their own tools.",
        );
      if (!argument) throw new Error("Usage: /plan <request>");
      this.interrupted = false;
      await this.command(
        `code do mode:plan -- ${argument}`,
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
      const results = await this.command(
        workflow,
        destination.sessionId ? { codingTarget: { sessionId: destination.sessionId } } : undefined,
      );
      // In --tui, /diff also opens the navigable diff view over the same
      // structured result. The transcript entry is unchanged.
      if (verb === "/diff" && this.terminal) {
        const shown = results.find((p) => codePerceptionFormat(p) === "diff");
        if (shown) this.terminal.showDiff(this.safeText(formatCodePerception(shown)));
      }
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
    if (verb === "/model") {
      if (this.harness.agent !== "marina")
        throw new Error(
          "/model switches Marina's model. /use marina selects it; native agents keep their own model.",
        );
      if (!argument) {
        this.write(`Model · ${this.harness.model ?? "runtime default (cheapest available)"}`);
        return;
      }
      await this.selectHarness({ ...this.harness, agent: "marina", model: argument });
      return;
    }
    if (verb === "/fast") {
      if (this.harness.agent !== "marina")
        throw new Error("/fast selects Marina's cheapest reachable model. /use marina selects it.");
      const fast = fastestModelFor(process.env);
      if (!fast) throw new Error("No provider key configured — set one or run `marina init`.");
      await this.selectHarness({ ...this.harness, agent: "marina", model: fast });
      return;
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
    if (this.ticker) clearInterval(this.ticker);
    this.liveStatus?.stop();
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
