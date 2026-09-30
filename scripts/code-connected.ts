// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import { MarinaAgent, type Perception } from "../src/sdk/client";
import { parseCodingCommandTarget } from "../src/sdk/command-target";
import { execApprovalRequest, terminalCodeLifecycle } from "./code";
import { CodeConsole } from "./code-console";
import { HarnessStore, validateHarness } from "./code-harness";
import { formatCodePerception, terminalText } from "./code-terminal";
import { cachedParticipantToken, participantUrl, saveParticipantToken } from "./session-cache";

export interface ConnectedCodeOptions {
  url: string;
  name: string;
  session: string;
  token?: string;
  cacheDirectory?: string;
}

/** Authenticated existing-session attach. No server spawn, name-login fallback or local filesystem assumption. */
export async function openConnectedCodeSession(
  options: ConnectedCodeOptions,
  observe: (p: Perception) => void = () => {},
) {
  const url = participantUrl(options.url);
  if (!/^[a-zA-Z0-9_]{1,20}$/.test(options.name))
    throw new Error("Use the exact Marina account name (1–20 letters, digits or underscores).");
  const target = parseCodingCommandTarget({ sessionId: options.session });
  const token = options.token ?? cachedParticipantToken(options.name, url, options.cacheDirectory);
  if (!token)
    throw new Error(
      "Authenticate with marina connect <name> on this server first, or set MARINA_TOKEN. Connected coding never falls back to a new identity.",
    );
  const agent = new MarinaAgent(url, {
    autoReconnect: false,
    commandMode: "correlated",
    connectTimeout: 10_000,
  });
  agent.onPerception(observe);
  try {
    const identity = await agent.reconnect(token);
    // Reconnect rotates the credential even when a later session preflight is refused.
    saveParticipantToken(identity.name, url, identity.token, options.cacheDirectory);
    if (identity.name.toLowerCase() !== options.name.toLowerCase())
      throw new Error(
        `The credential belongs to ${identity.name}, not the requested account. No coding command was sent.`,
      );
    if (identity.name !== options.name)
      saveParticipantToken(options.name, url, identity.token, options.cacheDirectory);
    const result = await agent.command("code status", { codingTarget: target });
    const status = result
      .map(
        (p) =>
          p.data.code as
            | {
                event?: string;
                sessionId?: string;
                status?: string;
                workspace?: string;
                metadata?: { profile?: string; model?: string };
              }
            | undefined,
      )
      .find((code) => code?.event === "session_status" && code.sessionId === target.sessionId);
    if (!status?.workspace || status.status !== "active")
      throw new Error(
        "Connected coding requires an accessible active session. Inspect code list before retrying.",
      );
    const resumed = await agent.command(`code resume ${target.sessionId}`);
    if (
      !resumed.some((p) => {
        const code = p.data.code as { event?: string; sessionId?: string } | undefined;
        return code?.event === "session_resumed" && code.sessionId === target.sessionId;
      })
    )
      throw new Error(
        "The server did not confirm the requested coding session. No task was dispatched.",
      );
    const entered = await agent.command("code");
    if (
      !entered.some((p) => {
        const code = p.data.code as { event?: string; sessionId?: string } | undefined;
        return code?.event === "code_mode_entered" && code.sessionId === target.sessionId;
      })
    )
      throw new Error(
        "The server did not enter the requested coding session. No task was dispatched.",
      );
    const harness = validateHarness({
      version: 1,
      agent: "marina",
      profile: status.metadata?.profile,
      model: status.metadata?.model,
    });
    return { agent, url, sessionId: target.sessionId, workspace: status.workspace, harness };
  } catch (error) {
    agent.disconnect();
    throw error;
  }
}

/** An interactive view owns only its socket and terminal, never the attached world. */
export async function runConnectedCodeSession(options: ConnectedCodeOptions): Promise<number> {
  let consoleView: CodeConsole | undefined;
  let attached: Awaited<ReturnType<typeof openConnectedCodeSession>> | undefined;
  const completed = Promise.withResolvers<number>();
  const pendingApprovals = new Set<string>();
  let disconnected: (() => void) | undefined;
  const write = (text: string) =>
    consoleView ? consoleView.write(text) : process.stdout.write(`${terminalText(text)}\n`);
  const observe = (p: Perception) => {
    const terminal = terminalCodeLifecycle(p);
    if (terminal) consoleView?.completed(terminal.sessionId);
    if (consoleView) consoleView.receive(p);
    else {
      const text = formatCodePerception(p);
      if (text) write(text);
    }
    const request = execApprovalRequest(p);
    if (!request || !consoleView || !attached || pendingApprovals.has(request.token)) return;
    pendingApprovals.add(request.token);
    const view = consoleView;
    const agent = attached.agent;
    void (async () => {
      const answer = await view.ask(`Run in ${request.cwd}: ${request.rendered} [y/N]: `);
      await agent.command(
        `code ${/^y(es)?$/i.test(answer.trim()) ? "exec-approve" : "exec-deny"} ${request.token}`,
      );
    })()
      .catch((error) => write(`Approval could not be delivered: ${getErrorMessage(error)}`))
      .finally(() => pendingApprovals.delete(request.token));
  };
  const interrupt = () => {
    void consoleView?.interrupt();
  };
  const terminate = () => {
    void consoleView?.close(0);
  };
  try {
    attached = await openConnectedCodeSession(options, observe);
    const key = createHash("sha256")
      .update(`${attached.url}\n${options.name}\n${attached.sessionId}`)
      .digest("hex")
      .slice(0, 20);
    const directory = join(homedir(), ".marina", "connected", key);
    consoleView = new CodeConsole({
      agent: attached.agent,
      url: attached.url.replace(/^ws/, "http"),
      root: attached.workspace,
      sessionId: attached.sessionId,
      directory,
      connected: true,
      harness: attached.harness,
      store: new HarnessStore(directory),
      finish: (code) => completed.resolve(code),
    });
    write(
      `Marina · ${attached.url}\nCoding session · ${attached.sessionId}\nServer workspace · ${attached.workspace}`,
    );
    disconnected = () => {
      write(
        "Disconnected. Pending command outcomes may be unknown; inspect session evidence before retrying. No work was replayed.",
      );
      void consoleView?.close(1);
    };
    attached.agent.on("disconnect", disconnected);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    await consoleView.start(true);
    // Restore the active-task indicator after subscribing the view. Attaching must
    // neither redispatch a task nor make Ctrl+C overlook already-running work.
    await attached.agent.command("code status", {
      codingTarget: { sessionId: attached.sessionId },
    });
    return await completed.promise;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (consoleView) await consoleView.close(1);
    if (disconnected) attached?.agent.off("disconnect", disconnected);
    attached?.agent.disconnect();
  }
}
