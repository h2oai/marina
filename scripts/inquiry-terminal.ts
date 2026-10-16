// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type Component,
  Editor,
  HStack,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type Terminal,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { getErrorMessage } from "../src/engine/errors";
import {
  InvestigationApiError,
  type MarinaInvestigationClient,
} from "../src/sdk/investigation-client";
import {
  type InvestigationView,
  investigationAttemptText,
  investigationPlainText,
} from "../src/sdk/investigation-text";
import {
  type InvestigationEvent,
  type InvestigationRequest,
  type InvestigationSnapshot,
  investigationTerminal,
} from "../src/sdk/investigation-types";

const HELP = `MARINA · prediction and research

Type a question and press Enter to begin. Every new submission uses a request key.
/predict <question>     predict a Yes/No outcome
/research <question>    build a sourced report
/list                   saved private cases
/open <case-id>         open a saved answer
/new                    return to the question prompt
/why /sources /report   inspect the answer
/events                 live stages and captured document IDs
/content <id>           inspect a captured input/output
/cancel                 stop the displayed attempt and its owned children
/browser                open this case in the dashboard
/quit                   detach; server work continues

F1 help · F2 answer · F3 why · F4 sources · F5 activity · F6 report · F7 browser
PgUp/PgDn scroll · Ctrl+C or Ctrl+D detach

No coding folder is needed. Reads never invoke models. Private case grants also
work for agents and external clients. Costs can settle after cancellation; the
display labels incomplete accounting rather than treating unknown cost as zero.`;

const accent = (text: string) =>
  process.env.NO_COLOR === undefined ? `\x1b[36m${text}\x1b[0m` : text;
const plain = (text: string) => text;

/** Native presentation host; no engine, coding session or shell-command interpreter. */
export class InvestigationTerminal {
  private readonly tui: TuiAltScreen;
  private readonly body = new Text("", 1, 1);
  private readonly context = new Text("", 1, 1);
  private readonly scroll: ScrollView;
  private readonly editor: Editor;
  private readonly controller = new AbortController();
  private snapshot?: InvestigationSnapshot;
  private events: InvestigationEvent[] = [];
  private cursor = 0;
  private view: InvestigationView | "events" | "help" | "custom" = "answer";
  private custom = "";
  private status = "Ready";
  private busy = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private request?: { fingerprint: string; key: string };
  private resolveClosed!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly client: MarinaInvestigationClient,
    private readonly url: string,
    screen?: Terminal,
  ) {
    this.tui = new TuiAltScreen(screen ?? new ProcessTerminal(), true, undefined, {
      mouse: false,
      copyOnSelect: false,
    });
    this.editor = new Editor(this.tui, {
      borderColor: accent,
      selectList: {
        selectedPrefix: accent,
        selectedText: accent,
        description: plain,
        scrollInfo: plain,
        noMatch: plain,
      },
    });
    this.scroll = new ScrollView(this.body, { follow: "none", scrollbar: "auto", primary: true });
    const line = (value: () => string): Component => ({
      invalidate() {},
      render: (width) => [truncateToWidth(value(), Math.max(1, width), "…")],
    });
    this.tui.setLayoutRoot(
      new VStack([
        { component: line(() => accent(" MARINA  ·  Predict & Research")), basis: 1 },
        {
          component: line(() =>
            investigationPlainText(
              ` ${this.snapshot?.attempt.state ?? "Ready"} · ${this.view} · ${this.status}`,
            ),
          ),
          basis: 1,
        },
        {
          component: new HStack(
            [
              { component: this.scroll, basis: 50, grow: 3, minSize: 1 },
              {
                component: new ScrollView(this.context, { primary: false }),
                basis: 28,
                grow: 1,
                minSize: 1,
                visible: ({ width, height }) => width >= 100 && height >= 12,
              },
            ],
            { gap: 1 },
          ),
          basis: 0,
          grow: 1,
          minSize: 1,
        },
        {
          component: line(
            () =>
              " F1 help · F2 answer · F3 why · F4 sources · F5 activity · F6 report · F7 browser",
          ),
          basis: 1,
        },
        { component: this.editor, basis: "auto", minSize: 1, maxSize: 6 },
      ]),
    );
    this.editor.onSubmit = (value) => {
      void this.command(value, true);
    };
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (data.startsWith("\x1b[200~")) return;
      if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && !this.editor.getText())) {
        this.close();
        return { consume: true };
      }
      const shortcuts = ["help", "answer", "why", "sources", "events", "report", "browser"];
      const index = shortcuts.findIndex((_shortcut, i) => matchesKey(data, `f${i + 1}` as "f1"));
      if (index >= 0) {
        void this.command(`/${shortcuts[index]}`);
        return { consume: true };
      }
      return undefined;
    });
    this.redraw();
    this.tui.start();
  }

  private signal() {
    return AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]);
  }

  async start(request?: InvestigationRequest, key?: string, caseId?: string) {
    if (request?.question.trim()) await this.submit(request, key);
    else if (caseId) await this.open(caseId);
  }

  private redraw() {
    if (this.closed) return;
    const attempt = this.snapshot?.attempt;
    const body =
      this.view === "help"
        ? HELP
        : this.view === "custom"
          ? this.custom
          : this.view === "events"
            ? this.events
                .map(
                  (event) =>
                    `${event.sequence} · ${event.actor} · ${event.kind}${event.message ? `\n  ${event.message}` : ""}${event.inputId ? `\n  input: ${event.inputId}` : ""}${event.outputId ? `\n  output: ${event.outputId}` : ""}`,
                )
                .join("\n\n") || "Waiting for captured work…"
            : attempt
              ? investigationAttemptText(attempt, this.view)
              : "What shall we predict?\n\nAsk a question below. Marina will gather evidence and evaluate the outcomes.\n\nUse /research for a research report, /list to reopen saved work, or F1 for help.";
    this.body.setText(investigationPlainText(body));
    this.context.setText(
      investigationPlainText(
        attempt
          ? [
              "THIS INVESTIGATION",
              "",
              attempt.request.kind,
              attempt.request.question,
              "",
              `Started by ${attempt.actor.name}`,
              `Owner: ${this.snapshot!.case.owner.name}`,
              `Access: ${this.snapshot!.case.access}`,
              "",
              `${this.events.filter((event) => event.kind === "stage_completed").length} completed stages`,
              `${new Set(this.events.filter((event) => event.kind === "stage_started").map((event) => event.actor)).size} model/worker identities`,
              "",
              `$${attempt.accounting.knownUsd.toFixed(4)} recorded`,
              attempt.accounting.complete ? "Accounting complete" : "Accounting incomplete",
              `${attempt.accounting.outstanding} outstanding calls`,
              "",
              `Case ${attempt.caseId}`,
              `Attempt ${attempt.id}`,
              "",
              "Ctrl+C detaches.",
              "/cancel stops this attempt.",
            ].join("\n")
          : "YOUR MARINA\n\nPredictions · Research\nPrivate evidence · Live activity\n\nThe same saved answers in chat, dashboard and terminal.\n\nNo folder or coding agent required.",
      ),
    );
    this.tui.requestRender();
  }

  private async open(caseId: string, attemptId?: string) {
    const snapshot = await this.client.get(caseId, attemptId, this.signal());
    if (this.closed) return;
    this.snapshot = snapshot;
    this.events = [];
    this.cursor = 0;
    this.view = "answer";
    this.status = "Connected";
    this.scroll.scrollToStart();
    this.redraw();
    await this.refresh();
  }

  private async submit(request: InvestigationRequest, key?: string) {
    const fingerprint = JSON.stringify(request);
    if (this.request?.fingerprint !== fingerprint)
      this.request = { fingerprint, key: key ?? crypto.randomUUID() };
    this.status = `Submitting · ${this.request.key}`;
    this.redraw();
    const admitted = await this.client.start(request, this.request.key, this.signal());
    this.request = undefined; // next intentional submission is a new attempt
    await this.open(admitted.attempt.caseId, admitted.attempt.id);
  }

  private async refresh() {
    if (this.closed || !this.snapshot || this.refreshing) return;
    this.refreshing = true;
    clearTimeout(this.timer);
    const id = this.snapshot.attempt.id;
    try {
      const [snapshot, page] = await Promise.all([
        this.client.get(this.snapshot.case.id, id, this.signal()),
        this.client.events(id, this.cursor, this.signal()),
      ]);
      if (this.closed || this.snapshot?.attempt.id !== id) return;
      this.snapshot = snapshot;
      if (page.reset) {
        this.events = [];
        this.cursor = 0;
      } else {
        this.events = [...this.events, ...page.events].slice(-1000);
        this.cursor = page.cursor;
      }
      this.status = page.more ? "Catching up with recorded work…" : "Connected";
    } catch (error) {
      if (this.closed) return;
      if (error instanceof InvestigationApiError && [401, 403, 404].includes(error.status)) {
        this.snapshot = undefined;
        this.events = [];
        this.custom = "This investigation is no longer available to this account.";
        this.view = "custom";
      }
      this.status = `Reconnecting: ${getErrorMessage(error)}`;
    } finally {
      this.refreshing = false;
      this.redraw();
      if (!this.closed && this.snapshot)
        this.timer = setTimeout(
          () => void this.refresh(),
          investigationTerminal(this.snapshot.attempt.state) &&
            this.snapshot.attempt.accounting.outstanding === 0
            ? 10_000
            : 2000,
        );
    }
  }

  async command(text: string, fromEditor = false) {
    if (this.closed || this.busy || !text.trim()) return;
    this.busy = true;
    try {
      const [verb, ...words] = text.trim().split(/\s+/);
      const argument = words.join(" ");
      if (!verb?.startsWith("/")) await this.submit({ kind: "prediction", question: text.trim() });
      else if (verb === "/predict" || verb === "/research") {
        if (!argument) throw new Error("Add a question after the command");
        await this.submit({
          kind: verb === "/research" ? "research" : "prediction",
          question: argument,
        });
      } else if (verb === "/open") await this.open(argument);
      else if (["/answer", "/why", "/sources", "/report", "/events", "/help"].includes(verb)) {
        this.view = verb.slice(1) as typeof this.view;
        this.scroll.scrollToStart();
      } else if (verb === "/list") {
        const list = await this.client.list(undefined, this.signal());
        this.custom =
          list.cases.map((item) => `${item.question}\n  /open ${item.id}`).join("\n\n") ||
          "No saved investigations.";
        this.view = "custom";
      } else if (verb === "/content") {
        const content = await this.client.content(argument, this.signal());
        this.custom = `${content.label}\n${content.bytes} bytes · SHA-256 ${content.hash}\n\n${JSON.stringify(content.value, null, 2)}`;
        this.view = "custom";
      } else if (verb === "/cancel") {
        if (!this.snapshot) throw new Error("Open an attempt first");
        await this.client.cancel(this.snapshot.attempt.id, this.signal());
        await this.refresh();
      } else if (verb === "/new") {
        this.snapshot = undefined;
        this.events = [];
        this.cursor = 0;
        this.view = "answer";
        clearTimeout(this.timer);
      } else if (verb === "/browser") {
        const url = new URL(this.url);
        url.pathname = `/predict${this.snapshot ? `/${encodeURIComponent(this.snapshot.case.id)}` : ""}`;
        if (this.snapshot) url.searchParams.set("attempt", this.snapshot.attempt.id);
        const command =
          process.platform === "darwin"
            ? ["open", url.href]
            : process.platform === "win32"
              ? ["explorer.exe", url.href]
              : ["xdg-open", url.href];
        const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        if (await child.exited) throw new Error(`Open this URL in a browser: ${url.href}`);
      } else if (verb === "/quit") this.close();
      else throw new Error("Unknown command. Press F1 for help.");
      if (fromEditor) this.editor.setText("");
    } catch (error) {
      this.status = getErrorMessage(error);
    } finally {
      this.busy = false;
      this.redraw();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort(new Error("Terminal detached"));
    this.tui.stop({ preserveScreen: true });
    this.resolveClosed();
  }
}

export async function runInvestigationTerminal(
  client: MarinaInvestigationClient,
  url: string,
  request?: InvestigationRequest,
  key?: string,
  caseId?: string,
) {
  const terminal = new InvestigationTerminal(client, url);
  const close = () => terminal.close();
  process.on("SIGTERM", close);
  process.stdin.on("end", close);
  try {
    await terminal.start(request, key, request ? undefined : caseId);
    await terminal.done;
  } finally {
    process.removeListener("SIGTERM", close);
    process.stdin.removeListener("end", close);
    terminal.close();
  }
}
