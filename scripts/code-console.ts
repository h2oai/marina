// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../src/engine/errors";
import type { MarinaAgent, Perception } from "../src/sdk/client";
import { type CodingHarness, codingAgent, type HarnessStore } from "./code-harness";
import { inferCodeDefaultModel } from "./code-model";
import { installedCodingAdapters, NativeTerminal, type TerminalAgent } from "./code-native";
import { CodeTerminal, TERMINAL_HELP, terminalText } from "./code-terminal";

export interface CodeConsoleOptions {
  agent: MarinaAgent;
  url: string;
  root: string;
  directory: string;
  harness: CodingHarness;
  store: HarnessStore;
  finish: (code: number) => void;
}

export class CodeConsole {
  private terminal?: CodeTerminal;
  private native?: NativeTerminal;
  private startingNative?: Promise<NativeTerminal>;
  private selected?: string;
  private harness: CodingHarness;
  private marinaHarness: CodingHarness;
  private marinaBusy = false;
  private interrupted = false;
  private lastInterruptAt = 0;
  private closing = false;
  private interactive = true;
  private commands: Promise<void> = Promise.resolve();
  constructor(private options: CodeConsoleOptions) {
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
  write(text: string) {
    const token = this.options.agent.getSession()?.token;
    if (token)
      text = text
        .replaceAll(token, "[redacted]")
        .replaceAll(encodeURIComponent(token), "[redacted]");
    if (this.terminal) this.terminal.write(text);
    else process.stdout.write(`${terminalText(text)}\n`);
  }
  ask(text: string, signal?: AbortSignal) {
    return this.terminal?.ask(text, signal) ?? Promise.resolve("");
  }
  completed() {
    this.marinaBusy = false;
  }
  observe(p: Perception) {
    const code = p.data?.code as { event?: string; phase?: string } | undefined;
    if (code?.event === "code_lifecycle" && code.phase === "received") this.marinaBusy = true;
  }
  busy() {
    return this.selected
      ? ["running", "waiting", "starting"].includes(
          this.native?.agents.get(this.selected)?.state.status ?? "",
        )
      : this.marinaBusy;
  }
  async start(interactive: boolean) {
    this.interactive = interactive;
    if (interactive || process.stdin.isTTY) {
      this.terminal = new CodeTerminal({
        line: (text) => {
          if (!interactive) return;
          // Stop/exit must overtake a pending slow prompt or launch.
          if (["/stop", "/quit", "exit", "quit"].includes(text)) {
            void this.line(text).catch((error) => this.write(getErrorMessage(error)));
            return;
          }
          this.commands = this.commands
            .then(() => this.line(text))
            .catch((error) => this.write(getErrorMessage(error)));
        },
        interrupt: () => {
          void this.interrupt();
        },
        close: () => {
          void this.close(interactive ? 0 : 1);
        },
      });
    }
    if (interactive) {
      this.write("Describe a task. /help shows controls; /dashboard opens the UI.");
      this.write(
        `Available runtimes: marina${installedCodingAdapters()
          .map((a) => `, ${a.id}`)
          .join("")}`,
      );
    }
    this.commands = this.selectHarness(this.harness);
    await this.commands;
  }
  private async runtime() {
    if (this.native) return this.native;
    if (!this.startingNative) {
      this.startingNative = (async () => {
        const runtime = new NativeTerminal({
          url: this.options.url,
          token: this.options.agent.getSession()!.token,
          root: this.options.root,
          directory: this.options.directory,
          write: (text) => this.write(text),
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
  private async selectHarness(harness: CodingHarness) {
    if (
      harness.agent === "marina" &&
      this.marinaBusy &&
      (harness.model !== this.marinaHarness.model || harness.profile !== this.marinaHarness.profile)
    )
      throw new Error("Stop or finish Marina's active task before changing its harness");
    await this.options.agent.command(`code profile use ${harness.profile ?? "marina"}`);
    if (harness.agent === "marina") {
      if (harness.model) {
        const current = await this.options.agent.command("code");
        if (!current.some((p) => (p.data?.code as { sessionId?: string } | undefined)?.sessionId))
          await this.options.agent.command("code start");
        await this.options.agent.command(`code model set ${harness.model}`);
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
      this.selected ? this.native!.agents.get(this.selected)!.session.label : "marina",
    );
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
      await this.options.agent.command(`code do ${text}`);
    }
  }
  private select(agent: TerminalAgent) {
    if (["stopped", "failed", "disconnected"].includes(agent.state.status))
      throw new Error("That session is no longer active; launch a new agent");
    this.selected = agent.session.id;
    this.harness = agent.harness ?? { version: 1, agent: codingAgent(agent.state.adapter) };
    this.terminal?.setTarget(agent.session.label);
    this.write(`Selected ${agent.session.label} · ${agent.state.cwd}`);
  }
  private async line(text: string) {
    if (this.closing) return;
    if (["/quit", "exit", "quit"].includes(text)) {
      await this.close(0);
      return;
    }
    if (!text.startsWith("/")) {
      this.interrupted = false;
      if (this.selected) await this.task(text);
      else {
        // Preserve Code Mode's existing task/command/dialect parser.
        const results = await this.options.agent.command(text);
        if (results.some((p) => p.kind === "error")) this.marinaBusy = false;
      }
      return;
    }
    const space = text.indexOf(" ");
    const verb = space < 0 ? text : text.slice(0, space);
    const argument = space < 0 ? "" : text.slice(space + 1).trim();
    if (verb === "/help") {
      this.write(TERMINAL_HELP);
      return;
    }
    if (verb === "/stop") {
      await this.stopSelected();
      return;
    }
    if (verb === "/world") {
      if (!argument) throw new Error("Usage: /world <Marina command>");
      await this.options.agent.command(`/${argument}`);
      return;
    }
    if (verb === "/agents") {
      this.write(`marina · ${this.marinaBusy ? "working" : "ready"} · ${this.options.root}`);
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
        this.write(`Saved as this folder's default: ${this.options.store.path}`);
        return;
      }
      if (argument.startsWith("use ")) {
        await this.selectHarness(this.options.store.load(argument.slice(4).trim())!);
        return;
      }
      throw new Error("Usage: /harness [list|save <name>|use <name-or-path>|export]");
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
    else await this.options.agent.command("code stop");
    this.marinaBusy = false;
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
    this.terminal?.close();
    try {
      await this.startingNative?.catch(() => undefined);
      await this.native?.stop();
    } finally {
      this.options.finish(code);
    }
  }
}
