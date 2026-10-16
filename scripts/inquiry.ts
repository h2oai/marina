#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../src/engine/errors";
import { MarinaInvestigationClient } from "../src/sdk/investigation-client";
import {
  type InvestigationView,
  investigationAttemptText,
  investigationPlainText,
} from "../src/sdk/investigation-text";
import {
  type InvestigationAttempt,
  type InvestigationRequest,
  investigationTerminal,
} from "../src/sdk/investigation-types";
import { httpBaseFromUrl } from "./marina";
import { cachedParticipantToken, cachedServerUrl, listCachedParticipants } from "./session-cache";

export const INQUIRY_USAGE = `marina predict [options] <question>
marina research [options] <question>
marina inquiry <list|show|why|sources|report|watch|cancel|select|grant|revoke|erase|review|resolve|tui> [id] [value]

  --url URL --name ACCOUNT        existing Marina server and authenticated account
  --type binary|number|choice     prediction answer format (default binary)
  --unit TEXT --options A,B,C     unit or mutually exclusive outcome labels
  --case ID --parent ATTEMPT      iterate or start a child investigation
  --context TEXT --horizon DATE --asof DATE --runs N
  --key KEY                      reuse a submission safely after a lost response
  --json                         machine output (one JSON object; no progress on stdout)
  --plain                        wait and print plain text
  --detach                       start and return IDs immediately
  --tui                          native terminal workspace (requires a TTY)

Interactive terminals open the workspace by default for predict/research.
Ctrl+C detaches; stopping paid work is a separate explicit cancel action.
Exit: 0 final/detached, 2 partial/unavailable, 1 failed, 130 interrupted wait.
Uses MARINA_URL / MARINA_TOKEN or the server-bound token saved by marina connect.`;

interface InquiryOptions {
  action: string;
  args: string[];
  url: string;
  name?: string;
  json: boolean;
  plain: boolean;
  tui: boolean;
  detach: boolean;
  key: string;
  request: InvestigationRequest;
}

export function parseInquiryArgs(
  kind: "predict" | "research" | "inquiry",
  args: string[],
  env: Record<string, string | undefined> = process.env,
): InquiryOptions {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  const names = new Set([
    "url",
    "name",
    "type",
    "unit",
    "options",
    "case",
    "parent",
    "context",
    "horizon",
    "asof",
    "runs",
    "key",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (["json", "plain", "tui", "detach", "help"].includes(name)) {
      flags.add(name);
      continue;
    }
    if (!names.has(name) || args[index + 1] === undefined || args[index + 1]!.startsWith("--"))
      throw new Error(`Invalid option ${arg}\n${INQUIRY_USAGE}`);
    if (values[name] !== undefined) throw new Error(`${arg} given twice`);
    values[name] = args[++index]!;
  }
  if (flags.has("tui") && (flags.has("json") || flags.has("plain") || flags.has("detach")))
    throw new Error("--tui cannot be combined with --json, --plain or --detach");
  const action = flags.has("help")
    ? "help"
    : kind === "inquiry"
      ? (positional.shift() ?? "tui")
      : "start";
  const shape = values.type ?? "binary";
  if (!["binary", "number", "choice"].includes(shape))
    throw new Error("--type must be binary, number or choice");
  if (
    values.runs &&
    (!/^\d+$/.test(values.runs) || Number(values.runs) < 1 || Number(values.runs) > 9)
  )
    throw new Error("--runs must be 1–9");
  return {
    action,
    args: positional,
    url: values.url ?? env.MARINA_URL ?? "ws://localhost:3300",
    name: values.name,
    json: flags.has("json"),
    plain: flags.has("plain"),
    tui: flags.has("tui"),
    detach: flags.has("detach"),
    key: values.key ?? crypto.randomUUID(),
    request: {
      kind: kind === "research" ? "research" : "prediction",
      question: positional.join(" "),
      ...(kind === "research"
        ? {}
        : {
            answer:
              shape === "choice"
                ? {
                    type: "choice",
                    options: (values.options ?? "")
                      .split(",")
                      .map((label, i) => ({ id: `option-${i + 1}`, label: label.trim() })),
                  }
                : shape === "number"
                  ? { type: "number", ...(values.unit ? { unit: values.unit } : {}) }
                  : { type: "binary" },
          }),
      ...(values.case ? { caseId: values.case } : {}),
      ...(values.parent ? { parentAttemptId: values.parent } : {}),
      ...(values.context ? { context: values.context } : {}),
      ...(values.horizon ? { horizon: values.horizon } : {}),
      ...(values.asof ? { asOf: values.asof } : {}),
      ...(values.runs ? { runs: Number(values.runs) } : {}),
    },
  };
}

export function investigationExitCode(attempt: InvestigationAttempt): number {
  return attempt.state !== "completed" ? 1 : attempt.result?.availability === "final" ? 0 : 2;
}

export async function runInquiry(
  kind: "predict" | "research" | "inquiry",
  args: string[],
): Promise<number> {
  let json = args.includes("--json");
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Wait interrupted; server work remains available"));
  let waiting: InvestigationAttempt | undefined;
  try {
    const options = parseInquiryArgs(kind, args);
    json = options.json;
    if (options.action === "help") {
      console.log(INQUIRY_USAGE);
      return 0;
    }
    const url = httpBaseFromUrl(options.url);
    const accounts = listCachedParticipants().filter(
      (account) => cachedServerUrl(account.url) === cachedServerUrl(options.url),
    );
    const name = options.name ?? (accounts.length === 1 ? accounts[0]!.name : undefined);
    const token =
      process.env.MARINA_TOKEN ?? (name ? cachedParticipantToken(name, options.url) : undefined);
    if (!token)
      throw new Error(
        "Sign in with marina connect <name>, then use --name <name>; or supply MARINA_TOKEN. Credentials are bound to the selected server.",
      );
    const client = new MarinaInvestigationClient({ url, token });
    const interactive =
      options.tui ||
      options.action === "tui" ||
      (options.action === "start" &&
        !options.json &&
        !options.plain &&
        !options.detach &&
        !!process.stdin.isTTY &&
        !!process.stdout.isTTY);
    if (interactive) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          "The TUI requires an interactive terminal. Use --plain or --json for pipes.",
        );
      const { runInvestigationTerminal } = await import("./inquiry-terminal");
      await runInvestigationTerminal(
        client,
        url,
        options.action === "start" ? options.request : undefined,
        options.key,
        options.args[0],
      );
      return 0;
    }
    const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    process.on("SIGINT", interrupt);
    const [id, account, access] = options.args;
    const requireId = () => {
      if (!id) throw new Error(`An ID is required for ${options.action}`);
      return id;
    };
    const output = (value: unknown, text: string) =>
      console.log(json ? JSON.stringify(value) : investigationPlainText(text));
    if (options.action === "list") {
      const result = await client.list(undefined, signal());
      output(
        result,
        result.cases.map((item) => `${item.id}  ${item.kind}  ${item.question}`).join("\n") ||
          "No investigations yet.",
      );
      return 0;
    }
    if (options.action === "start" || options.action === "watch") {
      if (options.action === "start") {
        if (!options.request.question.trim()) throw new Error(`Give a question.\n${INQUIRY_USAGE}`);
        // The request key is printed on stderr before dispatch so a lost response is recoverable.
        console.error(`Request key: ${options.key}`);
        waiting = (await client.start(options.request, options.key, signal())).attempt;
        if (options.detach) {
          output(
            waiting,
            `Case ${waiting.caseId}\nAttempt ${waiting.id}\nmarina inquiry watch ${waiting.id}`,
          );
          return 0;
        }
      } else waiting = await client.attempt(requireId(), signal());
      console.error(
        `Following ${waiting.id}; Ctrl+C detaches. Cancel: marina inquiry cancel ${waiting.id}`,
      );
      while (!investigationTerminal(waiting.state)) {
        await abortableDelay(1500, controller.signal);
        waiting = await client.attempt(waiting.id, signal());
      }
      output(waiting, investigationAttemptText(waiting));
      return investigationExitCode(waiting);
    }
    if (["show", "why", "sources", "report"].includes(options.action)) {
      const result = await client.get(requireId(), undefined, signal());
      output(
        result,
        investigationAttemptText(
          result.attempt,
          options.action === "show" ? "answer" : (options.action as InvestigationView),
        ),
      );
      return 0;
    }
    if (options.action === "cancel") {
      const result = await client.cancel(requireId(), signal());
      output(result, `Cancelled ${result.cancelled.length} active attempt(s).`);
      return 0;
    }
    if (options.action === "select") {
      const result = await client.select(requireId(), signal());
      output(result, investigationAttemptText(result.attempt));
      return 0;
    }
    if (options.action === "erase") {
      const result = await client.erase(requireId(), signal());
      output(result, "Case and owned evidence erased.");
      return 0;
    }
    if (options.action === "review") {
      const result = await client.review(requireId(), options.args.slice(1).join(" "), signal());
      output(result, "Review added.");
      return 0;
    }
    if (options.action === "resolve") {
      const result = await client.resolve(
        requireId(),
        JSON.parse(options.args.slice(1).join(" ")),
        signal(),
      );
      output(result, `Outcome recorded; loss ${result.loss ?? "unavailable"}.`);
      return 0;
    }
    if (options.action === "grant" || options.action === "revoke") {
      if (!account || (options.action === "grant" && access !== "read" && access !== "work"))
        throw new Error("Use grant <case> <account> <read|work> or revoke <case> <account>");
      const result = await client.grant(
        requireId(),
        account,
        options.action === "revoke" ? null : (access as "read" | "work"),
        signal(),
      );
      output(result, `${account}: ${result.access ?? "revoked"}`);
      return 0;
    }
    throw new Error(INQUIRY_USAGE);
  } catch (error) {
    if (json)
      console.log(
        JSON.stringify({
          error: getErrorMessage(error),
          ...(waiting ? { caseId: waiting.caseId, attemptId: waiting.id } : {}),
        }),
      );
    else console.error(investigationPlainText(getErrorMessage(error)));
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
