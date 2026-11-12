// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Coding ────────────────────────────────────────────────────────────────
//
// Run a coding task and follow it: typed steps while the coder works, then one
// Run result. The shapes are `marina.wire.v1` (protocol/README.md, "Coding");
// test/sdk-coding.test.ts holds them to src/protocol/wire.ts.

import type { MarinaClient } from "./client";
import type { Perception } from "./protocol";

/** What kind of step a coding activity is. */
export const CODING_ACTIVITY_KINDS = [
  "read",
  "search",
  "edit",
  "write",
  "patch",
  "run",
  "verify",
  "plan",
  "summary",
  "other",
] as const;

/** What the checks said. Only `passed` means checks ran on the change and passed. */
export const VERIFICATIONS = [
  "passed",
  "failed",
  "not_run",
  "error",
  "missing",
  "stale",
  "unbound",
  "unavailable",
] as const;

/** How a run ended. `submitted`: the coder finished and handed the change in for review. */
export const RUN_OUTCOMES = ["submitted", "failed", "cancelled", "interrupted"] as const;

/** One step the coder took. */
export interface CodingActivity {
  kind: (typeof CODING_ACTIVITY_KINDS)[number];
  /** One line in plain words: "Edit paginate.js". */
  label: string;
  path?: string;
  /** The change, as unified-diff body lines (`-old`, `+new`, ` context`), capped. */
  diff?: string[];
  /** Diff lines left out past the cap. */
  more?: number;
  /** Bookkeeping; a UI may hide it. */
  quiet?: boolean;
}

/** What the checks said. Only `passed` means checks ran on the change and passed. */
export type Verification = (typeof VERIFICATIONS)[number];

/** How a coding run ended. Review it with `review(runId, "approve" | "reject")`. */
export interface RunResult {
  runId: string;
  taskId?: number;
  agent?: string;
  terminal: true;
  phase: "completed" | "failed";
  /** `submitted`: the coder finished and handed the change in for review. */
  outcome?: (typeof RUN_OUTCOMES)[number];
  /** `blocked`, `agent_died`, or free text. */
  reason?: string;
  detail?: string;
  summary?: string;
  summaryId?: string;
  verification?: Verification;
  verificationReason?: string;
  /** Present when a budget forced the answer; never a free answer. */
  budgetForced?: { reason: string; used?: number; cap?: number };
}

/** One coding event, as the server sent it (`data.code` of a `code` frame). */
export interface CodeEvent {
  /** `agent_output`, `code_lifecycle`, `verification_finished`, … */
  event: string;
  /** Payload shape: `stream`, `lifecycle`, `diff`, `file`, `verification`, … */
  type: string;
  /** For people: print it as is (it may carry ANSI colour codes). */
  text: string;
  sessionId?: string;
  runId?: string;
  phase?: string;
  /** On `agent_output`: a step (`tool`), the coder's words (`prose`), or a failure. */
  kind?: "tool" | "prose" | "tool_error" | "error";
  /** On a step: what the coder did. */
  activity?: CodingActivity;
  /** On the end of a run. */
  result?: RunResult;
  /** The whole frame, for anything not lifted out above. */
  raw: Perception;
}

/** The coder asks to run a command outside its allowlist. */
export interface ExecApprovalRequest {
  token: string;
  argv: string[];
  cwd: string;
  /** The command as one line, for people. */
  rendered: string;
}

export interface CodeRunOptions {
  /**
   * What counts as done (default `checks`): `checks` runs the project's checks
   * on the change, `candidate` lets the coder's own checks stand,
   * `delivery` asks for the delivery checklist.
   */
  verification?: "checks" | "candidate" | "delivery";
  /**
   * Wall-clock budget for the coder: `"10m"`, `"90s"`, or milliseconds. At the
   * deadline it hands in what it has, labelled `budgetForced`.
   */
  budget?: string | number;
  /**
   * Give up waiting after this long (default 30 minutes): the run is stopped
   * and `result` rejects with `CodingTimeoutError`.
   */
  timeoutMs?: number;
}

export class CodingTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The coding run did not finish within ${timeoutMs} ms; it was stopped.`);
    this.name = "CodingTimeoutError";
  }
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The coding event a frame carries, or undefined when it is not one. */
export function codeEventOf(p: Perception): CodeEvent | undefined {
  const code = dict(p.data?.code);
  const event = str(code?.event);
  if (!code || !event) return undefined;
  const metadata = dict(code.metadata) ?? {};
  const kind = str(metadata.kind) as CodeEvent["kind"];
  const activity = dict(metadata.activity) as CodingActivity | undefined;
  const runId = str(metadata.runId);
  const result = runResultOf(code);
  return {
    event,
    type: str(code.type) ?? "",
    text: str(p.data.text) ?? "",
    ...(str(code.sessionId) ? { sessionId: str(code.sessionId) } : {}),
    ...(runId ? { runId } : {}),
    ...(str(code.phase) ? { phase: str(code.phase) } : {}),
    ...(kind ? { kind } : {}),
    ...(activity && typeof activity.label === "string" ? { activity } : {}),
    ...(result ? { result } : {}),
    raw: p,
  };
}

/** A run's end: a `code_lifecycle` event whose metadata says `terminal: true`. */
function runResultOf(code: Dict): RunResult | undefined {
  const metadata = dict(code.metadata);
  if (code.event !== "code_lifecycle" || metadata?.terminal !== true) return undefined;
  const runId = str(metadata.runId);
  if (!runId) return undefined;
  const phase = metadata.phase ?? code.phase;
  return {
    ...(metadata as Partial<RunResult>),
    runId,
    terminal: true,
    phase: phase === "completed" ? "completed" : "failed",
  };
}

/** An exec approval request a frame carries, or undefined. */
export function execApprovalOf(p: Perception): ExecApprovalRequest | undefined {
  const request = dict(p.data?.execApproval);
  if (!request) return undefined;
  const token = str(request.token);
  const cwd = str(request.cwd);
  const rendered = str(request.rendered);
  if (!token || cwd === undefined || rendered === undefined || !Array.isArray(request.argv))
    return undefined;
  return { token, cwd, rendered, argv: request.argv.filter((a) => typeof a === "string") };
}

/** `budget:` value for `code do`: whole seconds. */
export function budgetArgument(budget: string | number): string {
  if (typeof budget === "number") {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("budget must be positive");
    return `${Math.max(1, Math.ceil(budget / 1000))}s`;
  }
  const text = budget.trim();
  if (!/^\d+(s|m|h)$/.test(text)) throw new Error(`budget "${budget}" is not like 90s, 10m or 2h`);
  return text;
}

/** A queue that can be read once, in order, as an async iterator. */
class EventStream<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  private taken = false;
  push(item: T) {
    if (this.done) return;
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.done = true;
    for (const next of this.waiting.splice(0)) next({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.taken) throw new Error("A run's events can be read once.");
    this.taken = true;
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      return: () => {
        this.items = [];
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * One coding task, from dispatch to its Run result.
 *
 * ```ts
 * const run = await marina.code.run("Fix the off-by-one in paginate()");
 * for await (const step of run.steps()) console.log(step.label);
 * const result = await run.result; // RunResult
 * ```
 */
export class CodingRun {
  /** Every coding event of this run's session while it runs, in order. Read once. */
  readonly events: AsyncIterable<CodeEvent>;
  /** Resolves with the Run result (completed or failed); rejects on timeout or disconnect. */
  readonly result: Promise<RunResult>;
  private stream = new EventStream<CodeEvent>();
  private settle!: { resolve: (r: RunResult) => void; reject: (e: unknown) => void };
  private id?: string;

  /** @internal */
  constructor(
    private readonly coding: MarinaCoding,
    private readonly sessionId: string | undefined,
  ) {
    this.events = this.stream;
    this.result = new Promise<RunResult>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // A caller who reads only events must not see an unhandled rejection.
    // allow-empty-catch: the error still reaches whoever awaits `result`
    this.result.catch(() => {});
  }

  /** The run's id once the server has accepted it (`task_run_…`). */
  get runId(): string | undefined {
    return this.id;
  }

  /** Only the coder's steps (reads, edits with their diffs, checks). Read once. */
  async *steps(): AsyncGenerator<CodingActivity> {
    for await (const event of this.events) if (event.activity) yield event.activity;
  }

  /** Redirect the coder while it works. */
  steer(direction: string): Promise<unknown> {
    return this.coding.steer(direction);
  }

  /** Stop the coder. The result still arrives, as `failed`. */
  stop(): Promise<unknown> {
    return this.coding.stop();
  }

  /** @internal Feed one frame; returns true once the run has ended. */
  receive(p: Perception): boolean {
    const event = codeEventOf(p);
    if (!event) return false;
    if (this.sessionId && event.sessionId && event.sessionId !== this.sessionId) return false;
    // The server names the run when it accepts it; ignore another run's late end.
    if (!this.id && event.event === "code_lifecycle" && event.runId && !event.result)
      this.id = event.runId;
    if (event.result && this.id && event.result.runId !== this.id) return false;
    this.stream.push(event);
    if (!event.result || !this.id) return false;
    this.finish(event.result);
    return true;
  }

  /** @internal */
  finish(result: RunResult): void {
    this.stream.end();
    this.settle.resolve(result);
  }

  /** @internal */
  fail(error: unknown): void {
    this.stream.end();
    this.settle.reject(error);
  }
}

/**
 * Code Mode for one connection: run tasks in the server's workspace, follow
 * them, review what they produced.
 */
export class MarinaCoding {
  private session?: Promise<string | undefined>;
  private approver?: (request: ExecApprovalRequest) => boolean | Promise<boolean>;
  private watching = false;
  private readonly active = new Set<() => void>();

  /** @internal */
  constructor(private readonly client: MarinaClient) {}

  /**
   * Enter Code Mode (once per connection) and return the coding session id.
   * The server picks the workspace: a local folder server codes in its folder.
   */
  open(): Promise<string | undefined> {
    this.session ??= this.client.command("code").then((perceptions) => {
      for (const p of perceptions) {
        const code = dict(p.data?.code);
        if (code?.event === "code_mode_entered") return str(code.sessionId);
      }
      return undefined;
    });
    this.session.catch(() => {
      this.session = undefined;
    });
    return this.session;
  }

  /** Dispatch a coding task. Resolves once the server accepts it; follow it on the run. */
  async run(task: string, options: CodeRunOptions = {}): Promise<CodingRun> {
    const text = task.trim();
    if (!text) throw new Error("Empty task: nothing to do.");
    const sessionId = await this.open();
    const run = new CodingRun(this, sessionId);
    // Watch BEFORE dispatching, so a fast end cannot slip past.
    const handler = (p: Perception) => {
      if (run.receive(p)) cleanup();
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cleanup();
      // allow-empty-catch: the timeout error below already reports the run
      this.stop().catch(() => {});
      run.fail(new CodingTimeoutError(timeoutMs));
    }, timeoutMs);
    const onLost = () => {
      cleanup();
      run.fail(new Error("The connection was lost before the coding run ended."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      this.client.offPerception(handler);
      this.client.off("reconnect_failed", onLost);
      this.active.delete(onLost);
    };
    this.client.onPerception(handler);
    // A dropped socket reconnects on its own; only giving up ends the run.
    this.client.on("reconnect_failed", onLost);
    this.active.add(onLost);
    const verification = options.verification ?? "checks";
    const budget = options.budget === undefined ? "" : `budget:${budgetArgument(options.budget)} `;
    try {
      // A program drives this run: nobody is at a keyboard to answer questions.
      await this.client.command(
        `code do verification:${verification} owner:unattended ${budget}-- ${text}`,
      );
    } catch (error) {
      cleanup();
      run.fail(error);
      throw error;
    }
    return run;
  }

  /**
   * Answer the coder's requests to run commands outside its allowlist. Without
   * a handler they wait for someone else to answer (`code exec-approve`).
   * The server honours approvals only when it allows them (a local folder
   * server started with exec approval on).
   */
  onExecApproval(handler: (request: ExecApprovalRequest) => boolean | Promise<boolean>): void {
    this.approver = handler;
    if (this.watching) return;
    this.watching = true;
    this.client.onPerception((p) => {
      const request = execApprovalOf(p);
      if (!request || !this.approver) return;
      const approver = this.approver;
      // A handler that throws denies: never run a command nobody approved.
      void Promise.resolve()
        .then(() => approver(request))
        .then(
          (yes) => yes === true,
          () => false,
        )
        .then((yes) =>
          this.client.command(
            yes ? `code exec-approve ${request.token}` : `code exec-deny ${request.token}`,
          ),
        )
        // allow-empty-catch: an answer that could not be sent leaves the request open to answer again
        .catch(() => {});
    });
  }

  /** The session's whole change as a unified diff ("" when nothing changed). */
  async diff(path?: string): Promise<string> {
    await this.open();
    const perceptions = await this.client.command(path ? `code diff ${path}` : "code diff");
    for (const p of perceptions) {
      const code = dict(p.data?.code);
      if (code?.type === "diff" && typeof code.content === "string") return code.content;
    }
    return "";
  }

  /** Record your verdict on a run's change. */
  review(runId: string, verdict: "approve" | "reject"): Promise<unknown> {
    if (!/^[\w-]{1,128}$/.test(runId)) throw new Error(`Not a run id: ${runId}`);
    return this.client.command(`code review ${verdict} ${runId}`);
  }

  /** Redirect the coder while it works. */
  steer(direction: string): Promise<unknown> {
    return this.client.command(`code steer ${direction}`);
  }

  /** Stop the coder. */
  stop(): Promise<unknown> {
    return this.client.command("code stop");
  }

  /** @internal The connection is closing: every unfinished run fails. */
  closed(): void {
    for (const lost of [...this.active]) lost();
  }
}
