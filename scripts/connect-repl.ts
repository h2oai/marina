// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The interactive `marina connect` session: banner, the bottom input area,
 * one command at a time (later lines queue, as in Claude Code), local slash
 * panels, and a status bar fed by the live world. Scripted modes never come
 * here — `connect.ts` keeps their output plain.
 */

import type { CommandCatalogEntry } from "../src/sdk/capabilities";
import type { MarinaAgent, Perception } from "../src/sdk/client";
import { MARINA_VERSION } from "../src/version";
import { runCliCommand } from "./connect-command";
import type { TermCaps } from "./term-caps";
import { count, pageBudget, tipLines, type Welcome, welcomeCard } from "./term-frame";
import { findPanel, PANELS } from "./term-panels";
import {
  type CliConfig,
  type CliFormats,
  DEFAULT_FORMATS,
  loadCliConfig,
  renderFormat,
  type SegmentContext,
  saveCliSetting,
} from "./term-prompt";
import { glyphsFor, type RenderOptions, renderPerception, wrap } from "./term-render";
import { defaultHistoryFile, ReplScreen } from "./term-repl";
import { httpBase, WorldStatus } from "./term-status";
import { createTheme, PALETTES, paletteFor, type Theme } from "./term-theme";

/** Plain verbs for the busy line (no whimsy in a shared world). */
const VERBS: Record<string, string> = {
  ask: "Asking",
  forecast: "Forecasting",
  research: "Researching",
  recall: "Recalling",
  search: "Searching",
  web: "Searching the web",
  readiness: "Checking readiness",
  look: "Looking",
  move: "Moving",
  goto: "Moving",
  benchmark: "Benchmarking",
  agent: "Working with agents",
  code: "Coding",
  task: "Updating tasks",
  note: "Writing",
  think: "Thinking",
};

export function busyLabel(input: string): string {
  const verb = input.split(/\s+/, 1)[0]!.toLowerCase();
  return `${VERBS[verb] ?? `Running ${verb}`}…`;
}

interface Session {
  name: string;
  entityId: string;
}

export interface InteractiveOptions {
  agent: MarinaAgent;
  session: Session;
  url: string;
  caps: TermCaps;
  capabilities: CommandCatalogEntry[];
  /** Restore the same identity after a dropped connection (the cached session token). */
  reconnect?: () => Promise<void>;
  /** Stop the login-time collector and take what it buffered (welcome, look, brief). */
  handoff: () => Perception[];
  /** The session resumed a cached identity (the card says welcome back). */
  returning?: boolean;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const { agent, session, url } = options;
  let config: CliConfig = loadCliConfig();
  const out = process.stdout;
  const makeTheme = () =>
    createTheme(
      { ...options.caps, columns: out.columns || options.caps.columns },
      PALETTES[(config.theme ?? "").toLowerCase()] ?? paletteFor(options.caps),
    );
  let theme: Theme = makeTheme();
  const status = new WorldStatus(httpBase(url), () => agent.getSession()?.token, session.name);
  let capabilities = options.capabilities;
  let connected = true;
  let last: { ok: boolean; ms: number } | undefined;
  const queue: string[] = [];
  let running = false;
  /** The wait Esc can stop (the command itself keeps running on the server). */
  let waiting: AbortController | undefined;
  /** Commands whose wait you stopped; their output may still arrive. */
  const abandoned: string[] = [];
  const lateHeader = () => {
    const from = abandoned.length === 1 ? `“${abandoned[0]}”` : "a command you stopped waiting for";
    return `  ${theme.fg("faint")(`${glyphsFor(theme).result}  late output from ${from}`)}`;
  };
  let closing = false;
  let reconnecting = false;

  const segmentContext = (): SegmentContext => ({
    theme,
    name: session.name,
    connected,
    snapshot: status.snapshot,
    room: status.room(),
    here: status.roomPopulation(),
    last,
    queued: queue.length,
  });

  const renderOptions = (): RenderOptions => {
    const agents = new Set((status.snapshot.ops?.agents ?? []).map((a) => a.name));
    return { theme, self: session.name, width: out.columns || 80, isAgent: (n) => agents.has(n) };
  };

  const screen = new ReplScreen({
    input: process.stdin,
    output: out,
    theme,
    historyFile: defaultHistoryFile(),
    chrome: () => {
      const c = segmentContext();
      return {
        prompt: renderFormat(config.prompt, c),
        rule: renderFormat(config.rule, c),
        left: renderFormat(config.status, c),
        right: renderFormat(config.statusRight, c),
      };
    },
    queued: () => queue.length,
    onEscape: () => {
      if (!waiting) return false;
      waiting.abort();
      return true;
    },
    completer: async (line) => complete(line),
    onLine: (line) => {
      queue.push(line);
      void drain();
    },
    onClose: () => {
      closing = true;
      status.stop();
      out.write(`${theme.fg("faint")(`${glyphsFor(theme).ellipsis} disconnected from ${url}`)}\n`);
      agent.disconnect();
      process.exit(0);
    },
  });

  // ── output ────────────────────────────────────────────────────────────────
  const pending = new Map<Perception, boolean>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const onPerception = (p: Perception) => {
    if (p.data?.capabilities) return;
    // Your command's own output waits for its outcome (so a refusal renders as
    // one), unless the command runs long — then it streams.
    if (running && p.command_request_id) {
      pending.set(p, false);
      flushTimer ??= setTimeout(flushPending, 1_200);
      return;
    }
    const lines = renderPerception(p, renderOptions(), { own: !!p.command_request_id });
    screen.print(p.command_request_id && abandoned.length ? [lateHeader(), ...lines] : lines);
  };
  // A dropped socket (server restart, network) is a state, not an exit: the
  // status bar says offline and the session comes back on its own token.
  agent.on("disconnect", () => {
    if (closing) return;
    connected = false;
    screen.refresh();
    void reconnectLoop();
  });
  async function reconnectLoop() {
    if (reconnecting || !options.reconnect) return;
    reconnecting = true;
    for (let attempt = 0; !connected && !closing; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(1_000 * 2 ** attempt, 15_000)));
      try {
        await options.reconnect();
        connected = true;
        screen.flash("reconnected");
        void status.refresh(true);
      } catch {
        screen.flash(`offline · retrying (${attempt + 1})`, 1_500);
      }
    }
    reconnecting = false;
    screen.refresh();
  }

  function flushPending() {
    flushTimer = undefined;
    const lines: string[] = [];
    for (const [p, shown] of pending) {
      if (shown) continue;
      pending.set(p, true);
      lines.push(...renderPerception(p, renderOptions(), { own: true }));
    }
    if (lines.length) screen.print(lines);
  }

  async function drain() {
    if (running) {
      screen.refresh();
      return;
    }
    running = true;
    while (queue.length) {
      const line = queue.shift()!;
      if (line.startsWith("/")) {
        await slash(line);
        continue;
      }
      const started = Date.now();
      screen.setBusy(busyLabel(line));
      let failed = false;
      const report = (message: string) => {
        failed = true;
        screen.print([
          `  ${theme.fg("faint")(glyphsFor(theme).result)}  ${theme.fg("error")(`${glyphsFor(theme).error} ${message}`)}`,
        ]);
      };
      let ok = false;
      let result: Perception[] | undefined;
      const stop = new AbortController();
      waiting = stop;
      try {
        ok = await runCliCommand(agent, line, report, {
          signal: stop.signal,
          onResult: (perceptions) => {
            result = perceptions;
          },
        });
      } catch (err) {
        // Not a refusal: the transport failed. Say so; the line is not retried.
        report(`${err instanceof Error ? err.message : String(err)} — not run; reconnecting`);
        if (!agent.isConnected()) {
          connected = false;
          void reconnectLoop();
        }
      } finally {
        waiting = undefined;
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      // This request's output is exactly the SDK's per-request list; anything
      // else held back meanwhile is late output of a command you stopped waiting for.
      const mine = new Set(result ?? []);
      const late: string[] = [];
      const lines: string[] = [];
      for (const [p, shown] of pending) {
        if (shown) continue;
        if (mine.has(p) || !result)
          lines.push(...renderPerception(p, renderOptions(), { own: true, failed: !ok }));
        else late.push(...renderPerception(p, renderOptions(), { own: true }));
      }
      pending.clear();
      if (late.length) screen.print([lateHeader(), ...late, ""]);
      // Commands run in order per participant: once a later one completes,
      // everything abandoned before it has finished and delivered its output.
      if (!stop.signal.aborted && result) abandoned.length = 0;
      if (stop.signal.aborted) {
        failed = true;
        const note = `${theme.fg("warning")("stopped waiting")} ${theme.fg("muted")("— it keeps running on the server and your next commands wait behind it; its output prints here when it arrives")}`;
        lines.push(
          ...wrap(note, (out.columns || 80) - 5).map(
            (part, i) =>
              `${i ? "     " : `  ${theme.fg("faint")(glyphsFor(theme).result)}  `}${part}`,
          ),
        );
        abandoned.push(line);
      }
      // Stopping a wait is your choice, not a refusal: the chevron stays calm.
      last = { ok: stop.signal.aborted || (ok && !failed), ms: Date.now() - started };
      screen.setBusy(undefined);
      if (lines.length) screen.printResult([...lines, ""]);
      else if (!failed)
        screen.print([`  ${theme.fg("faint")(`${glyphsFor(theme).result}  done`)}`, ""]);
      // Movement, tasks and standing change with commands; read them now.
      void status.refresh(true, ["world", "system", "profile"]);
    }
    running = false;
    screen.refresh();
  }

  // ── slash commands ────────────────────────────────────────────────────────
  const LOCAL: { name: string; describe: string }[] = [
    { name: "help", describe: "keys, panels and how the prompt works" },
    ...PANELS.map((p) => ({ name: p.name, describe: p.describe })),
    { name: "statusline", describe: "show or change the status bar format" },
    { name: "expand", describe: "show the last collapsed result in full (ctrl+o)" },
    { name: "clear", describe: "clear the screen" },
    { name: "quit", describe: "disconnect and exit (ctrl+d)" },
  ];

  async function slash(line: string) {
    const [raw, ...rest] = line.slice(1).trim().split(/\s+/);
    const name = (raw ?? "").toLowerCase();
    const arg = rest.join(" ");
    const g = glyphsFor(theme);
    if (name === "" || name === "help" || name === "?")
      return void screen.print([...helpCard(), ""]);
    if (name === "quit" || name === "exit" || name === "q") return void screen.close();
    if (name === "clear") return void screen.clear();
    if (name === "expand") return void screen.expand();
    if ((name === "prompt" || name === "statusline") && rest.length) {
      const key: keyof CliFormats = name === "prompt" ? "prompt" : "status";
      const [verb, ...formatParts] = rest;
      // Keep the format exactly as typed after the verb (spaces matter).
      const format = line.replace(/^\/\S+\s+\S+\s?/, "");
      if (verb === "reset") {
        saveCliSetting(key, undefined);
        config = loadCliConfig();
        screen.print([`  ${theme.fg("success")(g.ok)} ${name} reset to the default`, ""]);
      } else if (verb === "set" && formatParts.length) {
        saveCliSetting(key, format);
        config = loadCliConfig();
        screen.print([`  ${theme.fg("success")(g.ok)} ${name} saved to ~/.marina/cli.json`, ""]);
      } else
        screen.print([
          `  ${theme.fg("error")(g.error)} usage: /${name} set <format> | /${name} reset`,
          "",
        ]);
      screen.refresh(true);
      return;
    }
    if (name === "statusline") {
      screen.print([
        `  ${theme.fg("muted")("now")}      ${renderFormat(config.status, segmentContext())}`,
        `  ${theme.fg("muted")("format")}   ${theme.fg("code")(config.status)}`,
        `  ${theme.fg("muted")("default")}  ${theme.fg("faint")(DEFAULT_FORMATS.status)}`,
        `  ${theme.fg("faint")("/prompt lists every segment")}`,
        "",
      ]);
      return;
    }
    if (name === "theme" && arg) {
      const palette = PALETTES[arg.toLowerCase()];
      if (!palette) {
        screen.print([
          `  ${theme.fg("error")(g.error)} no theme ${arg}; try ${Object.keys(PALETTES).join(", ")}`,
          "",
        ]);
        return;
      }
      saveCliSetting("theme", palette.name);
      config = loadCliConfig();
      theme = makeTheme();
      screen.setTheme(theme);
      screen.print([`  ${theme.fg("success")(g.ok)} theme ${palette.name}`, ""]);
      return;
    }
    const panel = findPanel(name);
    if (!panel) {
      const near = LOCAL.filter((l) => l.name.startsWith(name.slice(0, 2))).map(
        (l) => `/${l.name}`,
      );
      screen.print([
        `  ${theme.fg("error")(g.error)} no panel /${name}${near.length ? ` ${theme.fg("muted")(`— did you mean ${near.join(", ")}?`)}` : ""}`,
        `    ${theme.fg("faint")("world commands need no slash; /help lists panels")}`,
        "",
      ]);
      return;
    }
    if (panel.needs) {
      screen.setBusy(`Reading ${panel.name}…`);
      await status.refresh(true, panel.needs);
      screen.setBusy(undefined);
    }
    screen.printResult([...panel.render(segmentContext()), ""]);
  }

  function helpCard(): string[] {
    const t = theme;
    const pad = Math.max(...LOCAL.map((l) => l.name.length)) + 3;
    const keys: [string, string][] = [
      ["enter", "run a world command (look, say hi, task list, ask <question> …)"],
      ["tab", "complete commands and /panels"],
      ["↑ ↓", "history (kept in ~/.marina/history/connect, secrets skipped; MARINA_HISTORY=off)"],
      ["ctrl+o", "expand the last collapsed result"],
      ["ctrl+c", "clear the line; twice to exit"],
      ["ctrl+d", "exit"],
    ];
    return [
      `${t.bold(t.fg("accent")("Panels"))} ${t.fg("faint")("— local views of the live world; never sent as commands")}`,
      ...LOCAL.map(
        (l) => `  ${t.fg("code")(`/${l.name}`.padEnd(pad))}${t.fg("muted")(l.describe)}`,
      ),
      "",
      t.bold(t.fg("accent")("Keys")),
      ...keys.map(([k, v]) => `  ${t.fg("code")(k.padEnd(pad))}${t.fg("muted")(v)}`),
      "",
      `${t.fg("muted")("World help:")} ${t.fg("code")("help")}${t.fg("muted")(" · one command:")} ${t.fg("code")("help <command>")}${t.fg("muted")(" · what next:")} ${t.fg("code")("next")}`,
    ];
  }

  async function complete(line: string): Promise<string[]> {
    const words = line.trimStart();
    if (words.startsWith("/")) {
      const names = LOCAL.flatMap((l) => [l.name, ...(findPanel(l.name)?.aliases ?? [])]).map(
        (n) => `/${n}`,
      );
      if (words.startsWith("/theme "))
        return Object.keys(PALETTES)
          .map((p) => `/theme ${p}`)
          .filter((c) => c.startsWith(words));
      return names.filter((n) => n.startsWith(words));
    }
    try {
      capabilities = (await agent.capabilities()).commands;
    } catch {
      // allow-empty-catch: keep the last authenticated snapshot while disconnected.
    }
    const matches = capabilities
      .flatMap((entry) => [
        entry.name,
        ...entry.aliases,
        ...(entry.forms ?? []).map((form) => form.syntax.split(/ [<[]/)[0]!),
      ])
      .filter((candidate) => candidate.startsWith(words));
    return [...new Set(matches)];
  }

  // ── first page ────────────────────────────────────────────────────────────
  // The card, what the world said at login, and the input all fit on the
  // first page; whatever the login said past that is one ctrl+o away.
  await status.refresh(true, ["world", "health", "system", "profile"]);
  const card = welcomeCard(welcome(), theme, { columns: out.columns || 80, rows: out.rows || 24 });
  out.write(`\n${card.join("\n")}\n\n`);
  // Same tick: nothing arrives between taking the burst and listening.
  const burst = options
    .handoff()
    .filter((p) => !isLoginNoise(p))
    .flatMap((p) => renderPerception(p, renderOptions(), { own: false }));
  if (burst.length) screen.printResult([...burst, ""], pageBudget(out.rows || 24, card.length + 2));
  agent.onPerception(onPerception);
  status.onChange(() => screen.refresh());
  status.start();
  screen.setTitle(`marina · ${status.room() ?? session.name}`);
  screen.show();

  function welcome(): Welcome {
    const t = theme;
    const s = status.snapshot;
    const dot = t.fg("faint")(" · ");
    const muted = t.fg("muted");
    const room = status.room();
    return {
      title: `Marina ${MARINA_VERSION}`,
      greeting: `${options.returning ? "Welcome back" : "Welcome"}, ${session.name}!`,
      details: [
        [
          s.world?.name && t.bold(s.world.name),
          s.readiness?.profile && muted(`${s.readiness.profile} profile`),
        ]
          .filter(Boolean)
          .join(dot),
        // The same world in a browser: the dashboard on this server.
        t.fg("link")(httpBase(url).replace(/\/ws$/, "")),
      ].filter(Boolean),
      sections: [
        {
          title: "Tips for getting started",
          lines: tipLines(t, [
            ["next", "what to do now"],
            ["desire <sentence>", "start a journey"],
            ["/help", "keys and panels"],
          ]),
        },
        {
          title: "Right now",
          lines: [
            [
              room && `${muted("in")} ${t.bold(room)}`,
              s.health &&
                muted(`${s.health.connections} online · ${count(s.health.agents, "agent")}`),
            ]
              .filter(Boolean)
              .join(dot),
            ...(s.profile
              ? [muted(`standing ${s.profile.standing.toFixed(1)} · rank ${s.profile.rank}`)]
              : []),
            ...(s.system
              ? [
                  muted(
                    `${count(s.system.tasks.open, "open task")} · ${count(s.system.projects, "project")}`,
                  ),
                ]
              : []),
          ].filter(Boolean),
        },
      ],
    };
  }
}

/**
 * Login lines the card already says: the pre-login greeting, the session
 * itself (logged in / reconnected, which carries the token) and joining the
 * default channel.
 */
function isLoginNoise(p: Perception): boolean {
  const text = String(p.data?.text ?? "");
  return (
    /Enter your name to begin/i.test(text) ||
    typeof p.data?.token === "string" ||
    /^Joined channel "[^"]+"\.$/.test(text)
  );
}
